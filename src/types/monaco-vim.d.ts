/**
 * monaco-vim ships no type declarations. Only the surface we actually use is
 * declared here — a fuller guess would be fiction, and `any` would lose the
 * dispose() contract that keeps the binding from leaking between editors.
 */
declare module 'monaco-vim' {
  import type * as Monaco from 'monaco-editor'

  export interface VimMode {
    /** Detaches keybindings and restores the editor's normal behaviour. */
    dispose(): void
  }

  /**
   * Attach vim keybindings to an editor.
   * @param statusBarNode element that receives the mode indicator and the `:` command line.
   */
  export function initVimMode(
    editor: Monaco.editor.IStandaloneCodeEditor,
    statusBarNode?: HTMLElement | null,
  ): VimMode

  export const VimMode: {
    Vim: {
      /** Map a key sequence, e.g. defineMap('jj', '<Esc>', 'insert'). */
      map(lhs: string, rhs: string, context?: string): void
      /** Register a custom `:` command. */
      defineEx(name: string, shorthand: string, callback: () => void): void
    }
  }
}
