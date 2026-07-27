import { create } from 'zustand'
import { dap, dapStart, dapStop, dapCheck, type StackFrame, type Variable, type DapEvent } from '../lib/dapApi'
import { useAppStore } from './appStore'

/**
 * Debug session state (Python / debugpy).
 *
 * The backend owns the adapter and the launch handshake; this store owns
 * everything the UI reasons about: where the breakpoints are, whether we're
 * paused, the call stack and variables at the stop, and the console output.
 * DAP events flow in through `ingest`; user actions flow out through the step
 * controls. Breakpoints are kept in project-relative paths (what the editor
 * knows) and converted to absolute only at the adapter boundary.
 */

export type DebugStatus = 'idle' | 'starting' | 'running' | 'paused' | 'terminated'

export interface VarScope {
  name: string
  reference: number
}

interface DebugState {
  breakpoints: Record<string, number[]> // relPath -> sorted line numbers
  status: DebugStatus
  error: string | null
  program: string | null // relPath being debugged

  threadId: number | null
  frames: StackFrame[]
  selectedFrameId: number | null
  scopes: VarScope[]
  varsByRef: Record<number, Variable[]>
  expanded: Record<number, boolean>
  /** Where execution is paused, in editor terms — drives the current-line marker. */
  stopped: { path: string; line: number } | null
  output: { text: string; stderr: boolean }[]

  toggleBreakpoint: (relPath: string, line: number) => void
  breakpointsFor: (relPath: string) => number[]
  start: () => Promise<void>
  stop: () => Promise<void>
  cont: () => Promise<void>
  stepOver: () => Promise<void>
  stepIn: () => Promise<void>
  stepOut: () => Promise<void>
  pause: () => Promise<void>
  selectFrame: (frameId: number) => Promise<void>
  toggleVar: (reference: number) => Promise<void>
  ingest: (e: DapEvent) => Promise<void>
}

// ── path mapping: the editor speaks relative, the adapter speaks absolute ──
const fwd = (p: string) => p.replace(/\\/g, '/')
function root(): string {
  return fwd(useAppStore.getState().project?.root_path ?? '')
}
function toAbs(rel: string): string {
  const r = root()
  return r ? `${r}/${fwd(rel)}` : fwd(rel)
}
/** Absolute adapter path → project-relative, or null if it's outside the project
 *  (e.g. a stdlib frame) — those can't be opened in the editor, so we don't try. */
function toRel(abs: string): string | null {
  const r = root().toLowerCase()
  const a = fwd(abs)
  if (r && a.toLowerCase().startsWith(r + '/')) return a.slice(r.length + 1)
  return null
}

export const useDebug = create<DebugState>((set, get) => ({
  breakpoints: {},
  status: 'idle',
  error: null,
  program: null,
  threadId: null,
  frames: [],
  selectedFrameId: null,
  scopes: [],
  varsByRef: {},
  expanded: {},
  stopped: null,
  output: [],

  breakpointsFor: (relPath) => get().breakpoints[relPath] ?? [],

  toggleBreakpoint: (relPath, line) => {
    const cur = new Set(get().breakpoints[relPath] ?? [])
    if (cur.has(line)) cur.delete(line)
    else cur.add(line)
    const lines = [...cur].sort((a, b) => a - b)
    set((s) => ({ breakpoints: { ...s.breakpoints, [relPath]: lines } }))
    // If a session is live, push the change so it takes effect immediately.
    if (get().status === 'running' || get().status === 'paused') {
      dap.setBreakpoints(toAbs(relPath), lines).catch(() => {})
    }
  },

  start: async () => {
    const app = useAppStore.getState()
    const file = app.activeFile
    if (!file) {
      app.addNotification({ type: 'error', detail: 'Nothing to debug', message: 'Open a Python file first.' })
      return
    }
    if (!/\.py$/i.test(file)) {
      app.addNotification({ type: 'error', detail: 'Not a Python file', message: 'The debugger currently runs Python (.py) files.' })
      return
    }

    set({ status: 'starting', error: null, output: [], frames: [], scopes: [], stopped: null })
    try {
      await dapCheck()
    } catch (e) {
      set({ status: 'idle', error: String(e) })
      app.addNotification({ type: 'error', detail: 'Debugger unavailable', message: String(e) })
      return
    }

    const breakpoints = Object.entries(get().breakpoints)
      .filter(([, lines]) => lines.length > 0)
      .map(([rel, lines]) => ({ path: toAbs(rel), lines }))

    try {
      await dapStart({ program: toAbs(file), cwd: root(), breakpoints })
      set({ status: 'running', program: file })
    } catch (e) {
      set({ status: 'idle', error: String(e) })
      app.addNotification({ type: 'error', detail: 'Could not start debugger', message: String(e) })
    }
  },

  stop: async () => {
    try { await dapStop() } catch { /* already gone */ }
    set({ status: 'idle', threadId: null, frames: [], scopes: [], varsByRef: {}, expanded: {}, stopped: null, program: null })
  },

  cont: async () => { const t = get().threadId; if (t != null) { set({ status: 'running', stopped: null, frames: [] }); await dap.continue(t).catch(() => {}) } },
  stepOver: async () => { const t = get().threadId; if (t != null) await dap.next(t).catch(() => {}) },
  stepIn: async () => { const t = get().threadId; if (t != null) await dap.stepIn(t).catch(() => {}) },
  stepOut: async () => { const t = get().threadId; if (t != null) await dap.stepOut(t).catch(() => {}) },
  pause: async () => { const t = get().threadId; if (t != null) await dap.pause(t).catch(() => {}) },

  selectFrame: async (frameId) => {
    const frame = get().frames.find((f) => f.id === frameId)
    set({ selectedFrameId: frameId })
    await loadScopes(set, frameId)
    if (frame?.source?.path) {
      const rel = toRel(frame.source.path)
      if (rel != null) {
        set({ stopped: { path: rel, line: frame.line } })
        useAppStore.getState().openFileAtLine(rel, frame.line)
      }
    }
  },

  toggleVar: async (reference) => {
    const isOpen = get().expanded[reference]
    if (isOpen) {
      set((s) => ({ expanded: { ...s.expanded, [reference]: false } }))
      return
    }
    if (!get().varsByRef[reference]) {
      const vars = await dap.variables(reference).catch(() => [])
      set((s) => ({ varsByRef: { ...s.varsByRef, [reference]: vars } }))
    }
    set((s) => ({ expanded: { ...s.expanded, [reference]: true } }))
  },

  ingest: async (e) => {
    switch (e.event) {
      case 'stopped': {
        const threadId = e.body?.threadId ?? get().threadId
        set({ status: 'paused', threadId })
        const frames = await dap.stackTrace(threadId).catch(() => [] as StackFrame[])
        const top = frames[0]
        set({ frames, selectedFrameId: top?.id ?? null, varsByRef: {}, expanded: {} })
        if (top) {
          await loadScopes(set, top.id)
          if (top.source?.path) {
            const rel = toRel(top.source.path)
            if (rel != null) {
              set({ stopped: { path: rel, line: top.line } })
              useAppStore.getState().openFileAtLine(rel, top.line)
            }
          }
        }
        break
      }
      case 'continued':
        set({ status: 'running', stopped: null, frames: [], scopes: [] })
        break
      case 'output': {
        const text: string = e.body?.output ?? ''
        const stderr = e.body?.category === 'stderr'
        if (text) set((s) => ({ output: [...s.output.slice(-500), { text, stderr }] }))
        break
      }
      case 'exited':
      case 'terminated':
        set({ status: 'terminated', threadId: null, stopped: null, frames: [], scopes: [] })
        break
    }
  },
}))

/** Load the scopes for a frame and eagerly pull each scope's top-level variables
 *  (one round trip per scope) so the tree renders populated, not as empty rows. */
async function loadScopes(
  set: (partial: Partial<DebugState>) => void,
  frameId: number,
) {
  const scopes = await dap.scopes(frameId).catch(() => [])
  const varsByRef: Record<number, Variable[]> = {}
  for (const sc of scopes) {
    varsByRef[sc.variablesReference] = await dap.variables(sc.variablesReference).catch(() => [])
  }
  set({
    scopes: scopes.map((s) => ({ name: s.name, reference: s.variablesReference })),
    varsByRef,
    expanded: {},
  })
}
