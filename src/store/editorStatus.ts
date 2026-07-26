import { create } from 'zustand'

/**
 * Editor status telemetry, published by the editor and consumed by the global
 * status bar.
 *
 * A separate micro-store because these values change on every keystroke and
 * cursor move: keeping them out of appStore means a cursor move re-renders the
 * status bar only, never the file tree, tab strip, or AI panel.
 */
interface EditorStatus {
  line: number
  col: number
  selectionLength: number
  eol: 'LF' | 'CRLF'
  indent: string
  encoding: string
  language: string
  set: (patch: Partial<Omit<EditorStatus, 'set' | 'reset'>>) => void
  reset: () => void
}

const EMPTY = {
  line: 1,
  col: 1,
  selectionLength: 0,
  eol: 'LF' as const,
  indent: 'Spaces: 2',
  encoding: 'UTF-8',
  language: 'plaintext',
}

export const useEditorStatus = create<EditorStatus>((set) => ({
  ...EMPTY,
  set: (patch) => set(patch),
  reset: () => set(EMPTY),
}))
