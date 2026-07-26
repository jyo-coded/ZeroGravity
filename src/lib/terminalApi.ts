import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Raw PTY bridge. One module so every terminal surface speaks the same protocol. */

export interface PtyOutput { id: string; data: string }
export interface PtyExit { id: string; code: number | null }

export const ptySpawn = (id: string, cols: number, rows: number, cwd?: string, shell?: string) =>
  invoke<void>('pty_spawn', { id, cols, rows, cwd, shell })

export const ptyWrite = (id: string, data: string) => invoke<void>('pty_write', { id, data })

export const ptyResize = (id: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows })

export const ptyKill = (id: string) => invoke<void>('pty_kill', { id })

export const ptyList = () => invoke<string[]>('pty_list')

export const onPtyOutput = (cb: (p: PtyOutput) => void): Promise<UnlistenFn> =>
  listen<PtyOutput>('pty://output', (e) => cb(e.payload))

export const onPtyExit = (cb: (p: PtyExit) => void): Promise<UnlistenFn> =>
  listen<PtyExit>('pty://exit', (e) => cb(e.payload))

/**
 * Decode a base64 chunk from the PTY into raw bytes.
 *
 * The backend base64-encodes because reads land on arbitrary byte boundaries —
 * decoding chunks as UTF-8 independently would corrupt multi-byte characters
 * and escape sequences split across reads. xterm.js accepts a Uint8Array and
 * owns the stream decoding, so the bytes pass through untouched.
 */
export function decodePtyChunk(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
