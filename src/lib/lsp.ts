/**
 * lsp.ts — thin LSP client over the Tauri bridge (A4).
 *
 * Registers Monaco providers (hover, completion, signature help, definition,
 * references, rename, code actions) that translate Monaco ⇄ LSP, manages
 * document lifecycle (didOpen/didChange/didClose), and routes
 * publishDiagnostics into Monaco markers + the Problems store.
 *
 * Rename edits touching OTHER files are committed through the orchestrator
 * (commit_write) — changelog + P2P broadcast preserved, never raw writes.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type * as Monaco from 'monaco-editor'
import { useAppStore } from '../store/appStore'
import * as api from './api'
import { getFileLanguage, basename } from './utils'

// ─── Language grouping ─────────────────────────────────────────────────────

/** Monaco language id → LSP server group */
function groupOf(monacoLang: string): string | null {
  switch (monacoLang) {
    case 'rust': return 'rust'
    case 'typescript':
    case 'javascript': return 'typescript'
    case 'python': return 'python'
    default: return null // json/css/html use Monaco's built-in workers
  }
}

// ─── Client state ──────────────────────────────────────────────────────────

const started = new Set<string>()
const unavailable = new Set<string>()
const openDocs = new Map<string, number>() // rel path → version
let monacoRef: typeof Monaco | null = null

function root(): string {
  return (useAppStore.getState().project?.root_path ?? '').replace(/\\/g, '/')
}

function toUri(rel: string): string {
  return `file:///${root()}/${rel}`
}

function fromUri(uri: string): string | null {
  const decoded = decodeURIComponent(uri).replace(/\\/g, '/')
  const r = root()
  const idx = decoded.toLowerCase().indexOf(r.toLowerCase())
  if (idx < 0) return null
  return decoded.slice(idx + r.length).replace(/^\//, '')
}

async function ensureStarted(group: string): Promise<boolean> {
  if (started.has(group)) return true
  if (unavailable.has(group)) return false
  try {
    const res = await invoke<{ ok: boolean; hint?: string }>('lsp_start', { lang: group })
    if (res.ok) {
      started.add(group)
      return true
    }
    unavailable.add(group)
    if (res.hint) {
      useAppStore.getState().addNotification({
        type: 'error', detail: 'Language Server', message: res.hint,
      })
    }
    return false
  } catch {
    unavailable.add(group)
    return false
  }
}

async function req(group: string, method: string, params: unknown): Promise<any> {
  const res = await invoke<any>('lsp_request', { lang: group, method, params })
  if (res && res.__lsp_error) throw new Error(JSON.stringify(res.__lsp_error))
  return res
}

function notify(group: string, method: string, params: unknown) {
  invoke('lsp_notify', { lang: group, method, params }).catch(() => {})
}

// ─── Document lifecycle ────────────────────────────────────────────────────

export async function lspOpen(rel: string, content: string, monacoLang: string) {
  const group = groupOf(monacoLang)
  if (!group) return
  if (!(await ensureStarted(group))) return
  if (openDocs.has(rel)) {
    lspChange(rel, content, monacoLang)
    return
  }
  openDocs.set(rel, 1)
  notify(group, 'textDocument/didOpen', {
    textDocument: { uri: toUri(rel), languageId: monacoLang, version: 1, text: content },
  })
}

export function lspChange(rel: string, content: string, monacoLang: string) {
  const group = groupOf(monacoLang)
  if (!group || !started.has(group) || !openDocs.has(rel)) return
  const v = (openDocs.get(rel) ?? 1) + 1
  openDocs.set(rel, v)
  notify(group, 'textDocument/didChange', {
    textDocument: { uri: toUri(rel), version: v },
    contentChanges: [{ text: content }], // rangeless = full document
  })
}

export function lspClose(rel: string, monacoLang: string) {
  const group = groupOf(monacoLang)
  if (!group || !started.has(group) || !openDocs.has(rel)) return
  openDocs.delete(rel)
  notify(group, 'textDocument/didClose', { textDocument: { uri: toUri(rel) } })
}

// ─── LSP ⇄ Monaco translation helpers ──────────────────────────────────────

function toMonacoRange(m: typeof Monaco, r: any): Monaco.Range {
  return new m.Range(
    (r?.start?.line ?? 0) + 1, (r?.start?.character ?? 0) + 1,
    (r?.end?.line ?? 0) + 1, (r?.end?.character ?? 0) + 1,
  )
}

function lspPosition(position: Monaco.Position) {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function docId(rel: string) {
  return { uri: toUri(rel) }
}

function hoverText(contents: any): string {
  const one = (c: any): string => {
    if (!c) return ''
    if (typeof c === 'string') return c
    if (c.value && c.language) return '```' + c.language + '\n' + c.value + '\n```'
    if (c.value) return c.value
    return ''
  }
  if (Array.isArray(contents)) return contents.map(one).filter(Boolean).join('\n\n')
  return one(contents)
}

/** Fetch or create a Monaco model for a project file (enables cross-file peek). */
async function ensureModel(m: typeof Monaco, rel: string): Promise<Monaco.Uri | null> {
  const uri = m.Uri.parse(`file:///__peek__/${rel}`)
  if (m.editor.getModel(uri)) return uri
  try {
    const raw = (await api.openFile(rel)) as any
    if (raw?.is_binary) return null
    m.editor.createModel(raw?.content ?? '', getFileLanguage(rel), uri)
    return uri
  } catch {
    return null
  }
}

function peekUriToRel(uri: Monaco.Uri): string | null {
  const s = uri.path.replace(/^\//, '')
  if (s.startsWith('__peek__/')) return s.slice('__peek__/'.length)
  return null
}

/** Rel path of the file backing a Monaco model in the main editor. */
function modelRel(model: Monaco.editor.ITextModel): string | null {
  const peek = peekUriToRel(model.uri)
  if (peek) return peek
  // @monaco-editor/react creates uris straight from the `path` prop
  const p = model.uri.path.replace(/^\//, '').replace(/^split:\/\//, '')
  return p || null
}

async function locationsOf(m: typeof Monaco, raw: any): Promise<Monaco.languages.Location[]> {
  const arr = !raw ? [] : Array.isArray(raw) ? raw : [raw]
  const out: Monaco.languages.Location[] = []
  for (const loc of arr.slice(0, 25)) {
    const uri = loc.uri ?? loc.targetUri
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
    const rel = fromUri(uri ?? '')
    if (!rel || !range) continue
    const modelUri = await ensureModel(m, rel)
    if (!modelUri) continue
    out.push({ uri: modelUri, range: toMonacoRange(m, range) })
  }
  return out
}

// ─── Workspace edit application (rename, quick fixes) ──────────────────────

/** Collect per-file text edits from an LSP WorkspaceEdit. */
function collectEdits(we: any): Map<string, any[]> {
  const byFile = new Map<string, any[]>()
  if (we?.changes) {
    for (const [uri, edits] of Object.entries(we.changes)) {
      const rel = fromUri(uri)
      if (rel) byFile.set(rel, edits as any[])
    }
  }
  for (const dc of we?.documentChanges ?? []) {
    if (dc?.textDocument?.uri && dc?.edits) {
      const rel = fromUri(dc.textDocument.uri)
      if (rel) byFile.set(rel, [...(byFile.get(rel) ?? []), ...dc.edits])
    }
  }
  return byFile
}

/** Apply LSP TextEdits to a string (edits sorted bottom-up). */
function applyTextEdits(content: string, edits: any[]): string {
  const lines = content.split('\n')
  const offsets: number[] = [0]
  for (const l of lines) offsets.push(offsets[offsets.length - 1] + l.length + 1)
  const toOff = (p: any) => Math.min(content.length, (offsets[p.line] ?? content.length) + p.character)
  const sorted = [...edits].sort((a, b) =>
    toOff(b.range.start) - toOff(a.range.start))
  let out = content
  for (const e of sorted) {
    const s = toOff(e.range.start)
    const en = toOff(e.range.end)
    out = out.slice(0, s) + e.newText + out.slice(en)
  }
  return out
}

/** Commit other-file edits through the orchestrator; return current-file edits. */
async function applyWorkspaceEdit(
  we: any,
  currentRel: string | null,
  summary: string,
): Promise<any[]> {
  const byFile = collectEdits(we)
  const s = useAppStore.getState()
  let committed = 0
  for (const [rel, edits] of byFile) {
    if (rel === currentRel) continue
    const buf = s.tabCache[rel]
    if (buf && !buf.isBinary && buf.content !== buf.savedContent) {
      s.addNotification({
        type: 'conflict', detail: 'Rename skipped',
        message: `${rel} has unsaved changes — save it and rerun`,
      })
      continue
    }
    try {
      const raw = (await api.openFile(rel)) as any
      if (raw?.is_binary) continue
      const next = applyTextEdits(raw?.content ?? '', edits)
      const entry = await api.commitWrite({
        file: rel, content: next, summary,
        affected_lines: [], affected_functions: [],
      })
      s.addChangelogEntry(entry)
      committed++
    } catch { /* skip unreadable file */ }
  }
  if (committed > 0) {
    await s.loadFileTree()
    s.addNotification({ type: 'change', detail: 'LSP Edit', message: `${summary} — ${committed} other file(s) updated` })
  }
  return currentRel ? (byFile.get(currentRel) ?? []) : []
}

// ─── Provider registration ────────────────────────────────────────────────

let providersRegistered = false

export function registerLspProviders(m: typeof Monaco) {
  if (providersRegistered) return
  providersRegistered = true
  monacoRef = m

  const LANGS = ['rust', 'typescript', 'javascript', 'python']

  // Cross-file navigation: Go to Definition opens the real tab
  m.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const rel = peekUriToRel(resource) ?? fromUri(resource.toString())
      if (!rel) return false
      let line = 1, col = 0
      const sp = selectionOrPosition as any
      if (sp) {
        line = sp.startLineNumber ?? sp.lineNumber ?? 1
        col = (sp.startColumn ?? sp.column ?? 1) - 1
      }
      useAppStore.getState().openFileAtLine(rel, line, col)
      return true
    },
  })

  const kindMap = (lspKind: number): Monaco.languages.CompletionItemKind => {
    const k = m.languages.CompletionItemKind
    const table = [
      k.Text, k.Text, k.Method, k.Function, k.Constructor, k.Field, k.Variable,
      k.Class, k.Interface, k.Module, k.Property, k.Unit, k.Value, k.Enum,
      k.Keyword, k.Snippet, k.Color, k.File, k.Reference, k.Folder,
      k.EnumMember, k.Constant, k.Struct, k.Event, k.Operator, k.TypeParameter,
    ]
    return table[lspKind] ?? k.Text
  }

  for (const lang of LANGS) {
    const group = groupOf(lang)!

    m.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const res = await req(group, 'textDocument/hover', {
            textDocument: docId(rel), position: lspPosition(position),
          })
          if (!res?.contents) return null
          const value = hoverText(res.contents)
          if (!value) return null
          return {
            range: res.range ? toMonacoRange(m, res.range) : undefined,
            contents: [{ value }],
          }
        } catch { return null }
      },
    })

    m.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', ':', '>', '"', "'", '/', '@'],
      async provideCompletionItems(model, position) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return { suggestions: [] }
        try {
          const res = await req(group, 'textDocument/completion', {
            textDocument: docId(rel), position: lspPosition(position),
            context: { triggerKind: 1 },
          })
          const items: any[] = Array.isArray(res) ? res : res?.items ?? []
          const word = model.getWordUntilPosition(position)
          const defaultRange = new m.Range(
            position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
          const suggestions = items.slice(0, 120).map((it) => {
            const te = it.textEdit
            const range = te?.range
              ? toMonacoRange(m, te.range)
              : te?.insert ? toMonacoRange(m, te.insert) : defaultRange
            return {
              label: it.label,
              kind: kindMap(it.kind ?? 1),
              detail: it.detail,
              documentation: typeof it.documentation === 'object'
                ? { value: it.documentation?.value ?? '' }
                : it.documentation,
              insertText: te?.newText ?? it.insertText ?? it.label,
              insertTextRules: it.insertTextFormat === 2
                ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              sortText: it.sortText,
              filterText: it.filterText,
              range,
            } as Monaco.languages.CompletionItem
          })
          return { suggestions, incomplete: Boolean(res?.isIncomplete) }
        } catch { return { suggestions: [] } }
      },
    })

    m.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(model, position) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const res = await req(group, 'textDocument/signatureHelp', {
            textDocument: docId(rel), position: lspPosition(position),
          })
          if (!res?.signatures?.length) return null
          return {
            value: {
              signatures: res.signatures.map((s: any) => ({
                label: s.label,
                documentation: typeof s.documentation === 'object'
                  ? { value: s.documentation?.value ?? '' } : s.documentation,
                parameters: (s.parameters ?? []).map((p: any) => ({
                  label: p.label,
                  documentation: typeof p.documentation === 'object'
                    ? { value: p.documentation?.value ?? '' } : p.documentation,
                })),
              })),
              activeSignature: res.activeSignature ?? 0,
              activeParameter: res.activeParameter ?? 0,
            },
            dispose() {},
          }
        } catch { return null }
      },
    })

    m.languages.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const res = await req(group, 'textDocument/definition', {
            textDocument: docId(rel), position: lspPosition(position),
          })
          return await locationsOf(m, res)
        } catch { return null }
      },
    })

    m.languages.registerReferenceProvider(lang, {
      async provideReferences(model, position) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const res = await req(group, 'textDocument/references', {
            textDocument: docId(rel), position: lspPosition(position),
            context: { includeDeclaration: true },
          })
          return await locationsOf(m, res)
        } catch { return null }
      },
    })

    m.languages.registerRenameProvider(lang, {
      async provideRenameEdits(model, position, newName) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const we = await req(group, 'textDocument/rename', {
            textDocument: docId(rel), position: lspPosition(position), newName,
          })
          if (!we) return null
          // Other files → orchestrator commits; current file → Monaco (undoable)
          const mine = await applyWorkspaceEdit(we, rel, `LSP rename → ${newName}`)
          return {
            edits: mine.map((e) => ({
              resource: model.uri,
              versionId: undefined,
              textEdit: { range: toMonacoRange(m, e.range), text: e.newText },
            })),
          }
        } catch (e: any) {
          return { edits: [], rejectReason: String(e?.message ?? e) } as any
        }
      },
    })

    m.languages.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, context) {
        const rel = modelRel(model)
        if (!rel || !started.has(group)) return null
        try {
          const diagnostics = context.markers.map((mk) => ({
            range: {
              start: { line: mk.startLineNumber - 1, character: mk.startColumn - 1 },
              end: { line: mk.endLineNumber - 1, character: mk.endColumn - 1 },
            },
            message: mk.message,
            severity: mk.severity === m.MarkerSeverity.Error ? 1 : 2,
          }))
          const res = await req(group, 'textDocument/codeAction', {
            textDocument: docId(rel),
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            context: { diagnostics },
          })
          const actions = (Array.isArray(res) ? res : [])
            .filter((a: any) => a?.edit) // command-only actions unsupported (flagged)
            .slice(0, 12)
            .map((a: any) => {
              const mine = collectEdits(a.edit).get(rel) ?? []
              return {
                title: a.title,
                kind: a.kind ?? 'quickfix',
                diagnostics: [],
                isPreferred: Boolean(a.isPreferred),
                edit: {
                  edits: mine.map((e: any) => ({
                    resource: model.uri,
                    versionId: undefined,
                    textEdit: { range: toMonacoRange(m, e.range), text: e.newText },
                  })),
                },
              } as Monaco.languages.CodeAction
            })
          return { actions, dispose() {} }
        } catch { return null }
      },
    })
  }

  // ── Diagnostics → markers + Problems store ──────────────────────────────
  listen('lsp_diagnostics', (e: any) => {
    const params = e.payload?.params
    const rel = fromUri(params?.uri ?? '')
    if (!rel || !monacoRef) return
    const diags: any[] = params?.diagnostics ?? []

    const sev = (d: number) =>
      d === 1 ? monacoRef!.MarkerSeverity.Error
        : d === 2 ? monacoRef!.MarkerSeverity.Warning
        : d === 3 ? monacoRef!.MarkerSeverity.Info
        : monacoRef!.MarkerSeverity.Hint

    const markers = diags.map((d) => ({
      severity: sev(d.severity ?? 1),
      message: d.message ?? '',
      source: d.source ?? 'lsp',
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? 0) + 1,
    }))

    // Apply to any live model backing this file (main editor, split, peek)
    for (const model of monacoRef.editor.getModels()) {
      if (modelRel(model) === rel) {
        monacoRef.editor.setModelMarkers(model, 'lsp', markers)
      }
    }

    useAppStore.getState().setProblems(rel, diags.map((d) => ({
      line: (d.range?.start?.line ?? 0) + 1,
      col: (d.range?.start?.character ?? 0) + 1,
      severity: d.severity ?? 1,
      message: d.message ?? '',
      source: d.source ?? basename(rel),
    })))
  })
}
