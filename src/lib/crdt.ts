/**
 * crdt.ts — live collaborative editing over the 0G mesh (T1).
 *
 * Uses Yjs (pure JS) with a HAND-WRITTEN Monaco binding — deliberately avoids
 * y-monaco so Monaco stays on the CDN loader (same reason the LSP client is
 * hand-rolled). Yjs updates + cursor presence are relayed as base64 over the
 * existing encrypted TCP mesh via broadcast_crdt.
 *
 * Sync model:
 *   - One Y.Doc per file. A binding is created only while peers are online.
 *   - On bind, a peer requests current state; whoever holds it replies. If
 *     nobody answers within a grace window, the lowest-priority opener seeds
 *     from disk (priority tie-break makes simultaneous cold-open deterministic).
 *   - The encrypted changelog stays the commit layer: Ctrl+S still checkpoints
 *     the buffer through the orchestrator. CRDT only carries live keystrokes.
 */

import type * as Monaco from 'monaco-editor'
import * as Y from 'yjs'
import * as api from './api'
import { useAppStore } from '../store/appStore'

const LOCAL = 'local'
const REMOTE = 'remote'

// ─── base64 <-> Uint8Array (chunked to avoid call-stack limits) ─────────────

function u8ToB64(u: Uint8Array): string {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u.length; i += CH) {
    s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)))
  }
  return btoa(s)
}

function b64ToU8(b: string): Uint8Array {
  const s = atob(b)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}

// ─── Per-document state ─────────────────────────────────────────────────────

interface DocEntry {
  rel: string
  ydoc: Y.Doc
  ytext: Y.Text
  synced: boolean
  seedPriority: number
  yielded: boolean
  resolveInit?: () => void
  timers: ReturnType<typeof setTimeout>[]
  // active binding (at most one main editor per file)
  model?: Monaco.editor.ITextModel
  editor?: Monaco.editor.IStandaloneCodeEditor
  monaco?: typeof Monaco
  applyingRemote: boolean
  disposers: (() => void)[]
}

const docs = new Map<string, DocEntry>()

// Remote peer cursors — kept for ALL peers (drives follow-mode) even when the
// file they're in isn't the one we're viewing.
interface RemoteCursor {
  rel: string
  name: string
  color: string
  headLine: number
  headCol: number
  selections: { sl: number; sc: number; el: number; ec: number }[]
  decorations: string[] // decoration ids on our active model, if rendered
}
const remoteCursors = new Map<string, RemoteCursor>() // peerId → cursor

let myPeerId = ''
api.getPeerId().then((id) => { myPeerId = id }).catch(() => {})

function getEntry(rel: string): DocEntry {
  let e = docs.get(rel)
  if (!e) {
    const ydoc = new Y.Doc()
    e = {
      rel, ydoc, ytext: ydoc.getText('content'),
      synced: false, seedPriority: Math.random(), yielded: false,
      timers: [], applyingRemote: false, disposers: [],
    }
    // Broadcast our local updates (skip echoes of applied remote updates)
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return
      api.broadcastCrdt(rel, 'update', u8ToB64(update)).catch(() => {})
    })
    docs.set(rel, e)
  }
  return e
}

// ─── Selfware helpers ───────────────────────────────────────────────────────

function selfIdentity(): { name: string; color: string } {
  const id = useAppStore.getState().identity
  return { name: id?.username ?? 'Peer', color: id?.avatar_color ?? '#00C8FF' }
}

/** Seed the doc from disk content if nobody else has, then advertise state. */
function seedIfNeeded(entry: DocEntry, diskContent: string, force = false) {
  if (entry.synced || entry.ytext.length > 0) return
  if (entry.yielded && !force) return
  entry.ydoc.transact(() => entry.ytext.insert(0, diskContent), LOCAL)
  entry.synced = true
  // Proactively push full state so any waiting requester syncs
  api.broadcastCrdt(entry.rel, 'state', u8ToB64(Y.encodeStateAsUpdate(entry.ydoc))).catch(() => {})
  entry.resolveInit?.()
}

/** Reach a decided initial ytext: adopt a peer's state, or seed from disk. */
async function ensureInitialState(entry: DocEntry, diskContent: string): Promise<void> {
  if (entry.synced || entry.ytext.length > 0) { entry.synced = true; return }
  entry.seedPriority = Math.random()
  entry.yielded = false
  await new Promise<void>((resolve) => {
    entry.resolveInit = resolve
    api.broadcastCrdt(entry.rel, 'request', String(entry.seedPriority)).catch(() => {})
    // Non-yielders seed at 500ms; yielders get a longer safety net at 1500ms.
    entry.timers.push(setTimeout(() => seedIfNeeded(entry, diskContent), 500))
    entry.timers.push(setTimeout(() => { seedIfNeeded(entry, diskContent, true); resolve() }, 1500))
  })
}

// ─── Binding lifecycle ──────────────────────────────────────────────────────

/**
 * Bind a Monaco editor/model to the shared doc for `rel`. Returns a disposer.
 * Safe to call when solo — callers gate on peers being present.
 */
export async function bindEditor(
  rel: string,
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
): Promise<() => void> {
  const model = editor.getModel()
  if (!model) return () => {}
  const entry = getEntry(rel)
  if (entry.model === model) return () => unbind(rel) // already bound

  entry.model = model
  entry.editor = editor
  entry.monaco = monaco

  const diskContent = model.getValue()
  await ensureInitialState(entry, diskContent)

  // Reconcile the model to the shared truth before wiring incremental sync
  entry.applyingRemote = true
  try {
    const target = entry.ytext.toString()
    if (model.getValue() !== target) model.setValue(target)
  } finally {
    entry.applyingRemote = false
  }

  // Monaco → Y (changes arrive end-to-start, so offsets stay valid in order)
  const d1 = model.onDidChangeContent((e: Monaco.editor.IModelContentChangedEvent) => {
    if (entry.applyingRemote) return
    entry.ydoc.transact(() => {
      for (const c of e.changes) {
        if (c.rangeLength > 0) entry.ytext.delete(c.rangeOffset, c.rangeLength)
        if (c.text) entry.ytext.insert(c.rangeOffset, c.text)
      }
    }, LOCAL)
  })

  // Y → Monaco (apply edits one at a time so positions stay consistent)
  const observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
    if (tr.local) return // our own edit — model already reflects it
    if (!entry.model) return
    entry.applyingRemote = true
    try {
      let index = 0
      for (const op of event.delta) {
        if (op.retain != null) {
          index += op.retain
        } else if (typeof op.insert === 'string') {
          const pos = entry.model.getPositionAt(index)
          entry.model.applyEdits([{
            range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
            text: op.insert,
            forceMoveMarkers: true,
          }])
          index += op.insert.length
        } else if (op.delete != null) {
          const from = entry.model.getPositionAt(index)
          const to = entry.model.getPositionAt(index + op.delete)
          entry.model.applyEdits([{
            range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
            text: '',
          }])
        }
      }
    } finally {
      entry.applyingRemote = false
    }
  }
  entry.ytext.observe(observer)

  // Local cursor presence (throttled)
  let cursorTimer: ReturnType<typeof setTimeout> | null = null
  const d2 = editor.onDidChangeCursorSelection(() => {
    if (cursorTimer) return
    cursorTimer = setTimeout(() => {
      cursorTimer = null
      const { name, color } = selfIdentity()
      const sels = editor.getSelections() ?? []
      const primary = editor.getSelection()
      api.broadcastCrdt(rel, 'cursor', JSON.stringify({
        name, color,
        head: primary ? { line: primary.positionLineNumber, col: primary.positionColumn } : null,
        selections: sels.map((s) => ({
          sl: s.startLineNumber, sc: s.startColumn, el: s.endLineNumber, ec: s.endColumn,
        })),
      })).catch(() => {})
    }, 90)
  })

  entry.disposers = [
    () => d1.dispose(),
    () => d2.dispose(),
    () => entry.ytext.unobserve(observer),
    () => { if (cursorTimer) clearTimeout(cursorTimer) },
  ]

  // Render any cursors we already know about for this file
  renderRemoteCursorsFor(rel)

  return () => unbind(rel)
}

export function unbind(rel: string) {
  const entry = docs.get(rel)
  if (!entry) return
  entry.disposers.forEach((d) => { try { d() } catch { /* noop */ } })
  entry.disposers = []
  // Clear our decorations from the model being released
  if (entry.model) {
    for (const rc of remoteCursors.values()) {
      if (rc.rel === rel && rc.decorations.length) {
        rc.decorations = entry.model.deltaDecorations(rc.decorations, [])
      }
    }
  }
  entry.model = undefined
  entry.editor = undefined
}

// ─── Remote message routing (called from Workspace listener) ────────────────

export function handleCrdtMessage(payload: { doc: string; kind: string; data: string; from: string }) {
  const { doc: rel, kind, data, from } = payload
  if (from && from === myPeerId) return // never process our own echo

  switch (kind) {
    case 'update': {
      const entry = docs.get(rel)
      if (!entry) return // not open here — we'll request fresh state on open
      Y.applyUpdate(entry.ydoc, b64ToU8(data), REMOTE)
      return
    }
    case 'state': {
      const entry = docs.get(rel)
      if (!entry) return
      Y.applyUpdate(entry.ydoc, b64ToU8(data), REMOTE)
      entry.synced = true
      entry.resolveInit?.()
      // If our model is stale (bound before sync), reconcile it
      if (entry.model && !entry.applyingRemote) {
        const target = entry.ytext.toString()
        if (entry.model.getValue() !== target) {
          entry.applyingRemote = true
          try { entry.model.setValue(target) } finally { entry.applyingRemote = false }
        }
      }
      return
    }
    case 'request': {
      const entry = docs.get(rel)
      if (!entry) return
      const theirPriority = parseFloat(data)
      if (entry.synced || entry.ytext.length > 0) {
        // We hold state — answer
        api.broadcastCrdt(rel, 'state', u8ToB64(Y.encodeStateAsUpdate(entry.ydoc))).catch(() => {})
      } else if (!Number.isNaN(theirPriority) && theirPriority < entry.seedPriority) {
        // A lower-priority opener will seed — yield to them
        entry.yielded = true
      }
      return
    }
    case 'cursor': {
      try {
        const c = JSON.parse(data)
        const rc: RemoteCursor = remoteCursors.get(from) ?? {
          rel, name: c.name, color: c.color, headLine: 1, headCol: 1, selections: [], decorations: [],
        }
        rc.rel = rel
        rc.name = c.name ?? rc.name
        rc.color = c.color ?? rc.color
        rc.headLine = c.head?.line ?? rc.headLine
        rc.headCol = c.head?.col ?? rc.headCol
        rc.selections = c.selections ?? []
        remoteCursors.set(from, rc)
        renderRemoteCursorFor(from)
      } catch { /* malformed cursor — ignore */ }
      return
    }
  }
}

/** Drop a peer's presence when they disconnect. */
export function removePeer(peerId: string) {
  const rc = remoteCursors.get(peerId)
  if (rc && rc.decorations.length) {
    const entry = docs.get(rc.rel)
    if (entry?.model) entry.model.deltaDecorations(rc.decorations, [])
  }
  remoteCursors.delete(peerId)
}

/** Jump to a peer's live position (follow-on-avatar-click). */
export function followPeer(peerId: string): boolean {
  const rc = remoteCursors.get(peerId)
  if (!rc) return false
  useAppStore.getState().openFileAtLine(rc.rel, rc.headLine, Math.max(0, rc.headCol - 1))
  return true
}

// ─── Remote cursor rendering ────────────────────────────────────────────────

const injectedStyles = new Set<string>()

function ensurePeerStyle(peerId: string, color: string, name: string) {
  const cls = 'crdt-peer-' + peerId.replace(/[^a-zA-Z0-9]/g, '')
  const key = `${cls}:${color}:${name}`
  if (injectedStyles.has(key)) return cls
  // Remove any prior rule for this peer (color/name may change)
  document.getElementById('style-' + cls)?.remove()
  const safeName = name.replace(/[\\"']/g, '').slice(0, 24)
  const el = document.createElement('style')
  el.id = 'style-' + cls
  el.textContent = `
    .${cls}-sel { background: ${color}22; }
    .${cls}-caret {
      border-left: 2px solid ${color};
      margin-left: -1px;
      position: relative;
    }
    .${cls}-caret::after {
      content: "${safeName}";
      position: absolute;
      top: -1.1em; left: -2px;
      font: 9px 'IBM Plex Mono', monospace;
      background: ${color}; color: #000408;
      padding: 0 3px; border-radius: 3px;
      white-space: nowrap; pointer-events: none; z-index: 20;
    }`
  document.head.appendChild(el)
  injectedStyles.add(key)
  return cls
}

function renderRemoteCursorFor(peerId: string) {
  const rc = remoteCursors.get(peerId)
  if (!rc) return
  const entry = docs.get(rc.rel)
  if (!entry?.model || !entry.monaco) return // that file isn't the active bound model
  const m = entry.monaco
  const cls = ensurePeerStyle(peerId, rc.color, rc.name)

  const decos: Monaco.editor.IModelDeltaDecoration[] = []
  for (const s of rc.selections) {
    if (s.sl !== s.el || s.sc !== s.ec) {
      decos.push({
        range: new m.Range(s.sl, s.sc, s.el, s.ec),
        options: { className: `${cls}-sel`, stickiness: 1 },
      })
    }
  }
  decos.push({
    range: new m.Range(rc.headLine, rc.headCol, rc.headLine, rc.headCol),
    options: { className: `${cls}-caret`, stickiness: 1 },
  })
  rc.decorations = entry.model.deltaDecorations(rc.decorations, decos)
}

function renderRemoteCursorsFor(rel: string) {
  for (const [peerId, rc] of remoteCursors) {
    if (rc.rel === rel) renderRemoteCursorFor(peerId)
  }
}

/** True when at least one peer cursor is known — used to show a follow hint. */
export function hasRemotePeers(): boolean {
  return remoteCursors.size > 0
}

/** True while `rel` has a live CRDT binding (its model is the shared truth). */
export function isBound(rel: string): boolean {
  const e = docs.get(rel)
  return Boolean(e && e.model)
}
