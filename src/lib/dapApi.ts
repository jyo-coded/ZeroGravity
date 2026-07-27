import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/**
 * Debug Adapter Protocol client bindings.
 *
 * The Rust side is a pure relay: it owns the adapter process and the launch
 * handshake, and everything after launch is a generic `dap_request` passthrough.
 * These helpers name the specific DAP calls the debugger UI makes, so the store
 * reads as debugger operations rather than raw command strings.
 */

export interface BreakpointSet {
  /** Absolute filesystem path — the adapter matches breakpoints by real path. */
  path: string
  lines: number[]
}

export interface StackFrame {
  id: number
  name: string
  line: number
  column: number
  source?: { path?: string; name?: string }
}

export interface Scope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface Variable {
  name: string
  value: string
  type?: string
  variablesReference: number // >0 means expandable
}

export interface DapEvent {
  event: string
  body: any
}

export async function dapCheck(): Promise<void> {
  return invoke('dap_check')
}

export async function dapStart(opts: {
  program: string
  args?: string[]
  cwd: string
  breakpoints: BreakpointSet[]
  stopOnEntry?: boolean
}): Promise<void> {
  return invoke('dap_start', {
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd,
    breakpoints: opts.breakpoints,
    stopOnEntry: opts.stopOnEntry ?? false,
  })
}

export async function dapStop(): Promise<void> {
  return invoke('dap_stop')
}

export async function dapRunning(): Promise<boolean> {
  return invoke('dap_running')
}

/** Generic request passthrough. Returns the DAP response `body`. */
async function req(command: string, args: Record<string, unknown> = {}): Promise<any> {
  return invoke('dap_request', { command, args })
}

export const dap = {
  threads: () => req('threads').then((b) => (b?.threads ?? []) as { id: number; name: string }[]),
  stackTrace: (threadId: number) =>
    req('stackTrace', { threadId, startFrame: 0, levels: 20 }).then((b) => (b?.stackFrames ?? []) as StackFrame[]),
  scopes: (frameId: number) => req('scopes', { frameId }).then((b) => (b?.scopes ?? []) as Scope[]),
  variables: (variablesReference: number) =>
    req('variables', { variablesReference }).then((b) => (b?.variables ?? []) as Variable[]),
  continue: (threadId: number) => req('continue', { threadId }),
  next: (threadId: number) => req('next', { threadId }),
  stepIn: (threadId: number) => req('stepIn', { threadId }),
  stepOut: (threadId: number) => req('stepOut', { threadId }),
  pause: (threadId: number) => req('pause', { threadId }),
  setBreakpoints: (path: string, lines: number[]) =>
    req('setBreakpoints', { source: { path }, breakpoints: lines.map((line) => ({ line })) }),
  evaluate: (expression: string, frameId?: number) =>
    req('evaluate', { expression, frameId, context: 'repl' }),
}

/** Subscribe to adapter events (stopped, output, terminated, …). */
export function onDapEvent(handler: (e: DapEvent) => void): Promise<UnlistenFn> {
  return listen<DapEvent>('dap://event', (e) => handler(e.payload))
}
