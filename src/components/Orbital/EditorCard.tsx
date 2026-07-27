/**
 * EditorCard — Monaco inside a GlassCard (Phase 4).
 *
 * Ports the existing editor behavior verbatim (tabs, save, LSP, CRDT binding,
 * git gutter, format, pending-reveal) — this is a re-skin, not a rebuild.
 * Adds the full reference status bar: Ln/Col · indent · encoding · EOL ·
 * language · save state, plus a tab bar with + and ••• overflow.
 */

import { useRef, useState, useEffect } from 'react'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { X, Plus, MoreHorizontal } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useEditorStatus } from '../../store/editorStatus'
import { useSettings, monacoOptionsFrom } from '../../store/settingsStore'
import * as api from '../../lib/api'
import { getFileLanguage, basename } from '../../lib/utils'
import { registerLspProviders, lspOpen, lspChange, lspClose } from '../../lib/lsp'
import { registerInlineCompletion } from '../../lib/inlineCompletion'
import { bindEditor, unbind } from '../../lib/crdt'
import { useDebug } from '../../store/debugStore'

const NO_BREAKPOINTS: number[] = []

let formattersRegistered = false
function registerCliFormatters(monaco: typeof Monaco) {
  if (formattersRegistered) return
  formattersRegistered = true
  const register = (langs: string[]) => {
    for (const lang of langs) {
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model) {
          const path = model.uri.path.replace(/^\//, '')
          try {
            const formatted = await api.formatDocument(path, model.getValue())
            return [{ range: model.getFullModelRange(), text: formatted }]
          } catch (e: any) {
            useAppStore.getState().addNotification({ type: 'error', detail: 'Format Failed', message: String(e) })
            return []
          }
        },
      })
    }
  }
  register(['rust', 'python'])
  api.detectFormatters().then((d) => { if (d.prettier) register(['javascript', 'typescript', 'json', 'css', 'html', 'markdown']) }).catch(() => {})
}

export function EditorCard() {
  const {
    activeFile, activeFileContent, activeFileIsBinary,
    openFile, setActiveFileContent, isAiWriting, saveFile, isDirty,
    openTabs, tabCache, closeTab, closeAllTabs, collaborators,
    pendingReveal, clearPendingReveal, lastSavedContent, requestExplorerCreate,
  } = useAppStore()

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const gitDecosRef = useRef<string[]>([])
  const dapDecosRef = useRef<string[]>([])
  // Breakpoints for THIS file plus the current paused line — drive the gutter.
  const breakpoints = useDebug((s) => s.breakpoints[activeFile ?? ''] ?? NO_BREAKPOINTS)
  const stopped = useDebug((s) => s.stopped)
  const vimRef = useRef<{ dispose(): void } | null>(null)
  const vimStatusRef = useRef<HTMLDivElement>(null)
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [eol, setEol] = useState<'LF' | 'CRLF'>('LF')
  const [indent, setIndent] = useState('Spaces: 2')
  const [editorReady, setEditorReady] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)

  const settings = useSettings()
  const language = getFileLanguage(activeFile ?? '')
  const peersOnline = collaborators.some((c) => !c.is_self && c.status !== 'offline')

  // Vim mode. Attached and detached live, so toggling the setting takes effect
  // without reopening the file. monaco-vim is imported lazily: a user who never
  // enables it never downloads or parses it.
  useEffect(() => {
    let cancelled = false
    const editor = editorRef.current
    if (!editorReady || !editor) return

    if (settings.vimMode) {
      import('monaco-vim')
        .then(({ initVimMode }) => {
          if (cancelled || !editorRef.current) return
          vimRef.current = initVimMode(editorRef.current, vimStatusRef.current)
        })
        .catch(() => {
          useAppStore.getState().addNotification({
            type: 'error',
            detail: 'Vim mode unavailable',
            message: 'The vim keybinding module could not be loaded.',
          })
        })
    }

    return () => {
      cancelled = true
      // Always dispose: leaving the binding attached across an editor swap would
      // capture keys for a model that no longer exists.
      vimRef.current?.dispose()
      vimRef.current = null
    }
  }, [settings.vimMode, editorReady, activeFile])

  // Publish editor telemetry to the global status bar. The editor owns these
  // facts; the status bar renders them. Kept in a dedicated store so a cursor
  // move repaints the status bar alone, never the tree or the AI panel.
  useEffect(() => {
    useEditorStatus.getState().set({
      line: cursorPos.line,
      col: cursorPos.col,
      eol,
      indent: activeFileIsBinary ? 'binary' : indent,
      language: activeFileIsBinary ? 'binary' : language,
    })
  }, [cursorPos.line, cursorPos.col, eol, indent, language, activeFileIsBinary])

  // Save (Ctrl+S)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [saveFile])

  // Command-palette Format hook
  useEffect(() => {
    const h = () => editorRef.current?.getAction('editor.action.formatDocument')?.run()
    window.addEventListener('og:format', h)
    return () => window.removeEventListener('og:format', h)
  }, [])

  // LSP lifecycle
  useEffect(() => {
    if (!activeFile || activeFileIsBinary) return
    const lang = getFileLanguage(activeFile)
    lspOpen(activeFile, useAppStore.getState().activeFileContent, lang)
    return () => { lspClose(activeFile, lang) }
  }, [activeFile, activeFileIsBinary])

  useEffect(() => {
    if (!activeFile || activeFileIsBinary) return
    const t = setTimeout(() => lspChange(activeFile, activeFileContent, getFileLanguage(activeFile)), 300)
    return () => clearTimeout(t)
  }, [activeFileContent, activeFile, activeFileIsBinary])

  // CRDT binding while peers online
  useEffect(() => {
    if (!activeFile || activeFileIsBinary || !editorReady || !peersOnline) return
    const editor = editorRef.current, monaco = monacoRef.current
    if (!editor || !monaco) return
    let disposer: (() => void) | null = null
    let cancelled = false
    bindEditor(activeFile, editor, monaco).then((d) => { if (cancelled) d(); else disposer = d })
    return () => { cancelled = true; if (disposer) disposer(); else unbind(activeFile) }
  }, [activeFile, activeFileIsBinary, editorReady, peersOnline])

  // Pending reveal (search / go-to)
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== activeFile || !editorRef.current) return
    const t = setTimeout(() => {
      const ed = editorRef.current; if (!ed) return
      try {
        const line = Math.max(1, pendingReveal.line), col = Math.max(1, pendingReveal.col + 1)
        ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: col }); ed.focus()
      } catch { /* stale */ }
      clearPendingReveal()
    }, 80)
    return () => clearTimeout(t)
  }, [pendingReveal, activeFile, activeFileContent, clearPendingReveal])

  // Git diff gutter
  useEffect(() => {
    const ed = editorRef.current, monaco = monacoRef.current
    if (!ed || !monaco || !activeFile) return
    if (!useAppStore.getState().gitBranch) { gitDecosRef.current = ed.deltaDecorations(gitDecosRef.current, []); return }
    let cancelled = false
    api.gitDiffFile(activeFile).then((hunks) => {
      if (cancelled || !editorRef.current) return
      const decos = hunks.map((hnk) => ({
        range: new monaco.Range(hnk.start, 1, hnk.end, 1),
        options: { isWholeLine: true, linesDecorationsClassName: `git-gutter-${hnk.kind}` },
      }))
      gitDecosRef.current = editorRef.current.deltaDecorations(gitDecosRef.current, decos)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [activeFile, lastSavedContent])

  // Debug gutter — breakpoint glyphs and the current paused line. Rendered as
  // decorations (not widgets) so they survive scroll and edits like git markers.
  useEffect(() => {
    const ed = editorRef.current, monaco = monacoRef.current
    if (!ed || !monaco || !activeFile) return
    const decos: Monaco.editor.IModelDeltaDecoration[] = breakpoints.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: 'dap-breakpoint',
        glyphMarginHoverMessage: { value: 'Breakpoint' },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }))
    if (stopped && stopped.path === activeFile) {
      decos.push({
        range: new monaco.Range(stopped.line, 1, stopped.line, 1),
        options: {
          isWholeLine: true,
          className: 'dap-stopline',
          glyphMarginClassName: 'dap-stopglyph',
        },
      })
    }
    dapDecosRef.current = ed.deltaDecorations(dapDecosRef.current, decos)
  }, [activeFile, breakpoints, stopped, editorReady])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setEditorReady(true)
    registerCliFormatters(monaco)
    // Click the glyph margin to toggle a breakpoint on that line.
    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber
        const path = useAppStore.getState().activeFile
        if (line && path) useDebug.getState().toggleBreakpoint(path, line)
      }
    })
    registerLspProviders(monaco)
    registerInlineCompletion(monaco)
    editor.onDidChangeCursorPosition((e) => setCursorPos({ line: e.position.lineNumber, col: e.position.column }))
    const syncMeta = () => {
      const m = editor.getModel()
      if (!m) return
      setEol(m.getEOL() === '\r\n' ? 'CRLF' : 'LF')
      const opts = m.getOptions()
      setIndent(opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tabs: ${opts.tabSize}`)
    }
    editor.onDidChangeModelContent(syncMeta)
    syncMeta()
    editor.updateOptions({
      automaticLayout: true, autoIndent: 'full', fontSize: 12.5,
      fontFamily: "'IBM Plex Mono','JetBrains Mono',monospace", fontLigatures: true,
      minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false, glyphMargin: true,
      smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'gutter', padding: { top: 10, bottom: 10 }, overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true, scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
    })
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* ── Tab bar ────────────────────────────────────────────────────────
          Flush tabs with a top accent rail on the active one. Pills were the
          old look; a real editor's tabs sit edge-to-edge so the strip reads as
          one surface and the active tab connects visually to the code below. */}
      <div className="tabbar" role="tablist" aria-label="Open files">
        {openTabs.map((tab) => {
          const buf = tabCache[tab]
          const dirty = tab === activeFile ? isDirty : Boolean(buf && !buf.isBinary && buf.content !== buf.savedContent)
          const isActive = tab === activeFile
          return (
            <div
              key={tab}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => { if (!isActive) openFile(tab) }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(tab) } }}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab) } }}
              className="tab"
              title={tab}
            >
              <span className="truncate">{basename(tab)}</span>
              {dirty && <span className="tab-dirty" title="Unsaved changes" />}
              <button
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(tab) }}
                aria-label={`Close ${basename(tab)}`}
                title="Close"
              >
                <X size={13} />
              </button>
            </div>
          )
        })}

        <div className="flex items-center gap-1 px-2 ml-auto sticky right-0" style={{ background: 'var(--bg-base)' }}>
          <button className="btn btn-ghost btn-icon" onClick={() => requestExplorerCreate('file')} title="New file" aria-label="New file">
            <Plus size={15} />
          </button>
          <div className="relative">
            <button className="btn btn-ghost btn-icon" onClick={() => setShowOverflow((v) => !v)} title="Open editors" aria-label="Open editors">
              <MoreHorizontal size={15} />
            </button>
            {showOverflow && (
              <>
                <div className="fixed inset-0" style={{ zIndex: 'var(--z-overlay)' }} onClick={() => setShowOverflow(false)} />
                <div
                  className="overlay-surface absolute right-0 top-full mt-1 w-56 py-1 max-h-72 overflow-y-auto"
                  style={{ zIndex: 'calc(var(--z-overlay) + 1)' }}
                  role="menu"
                >
                  {openTabs.map((tab) => (
                    <button key={tab} role="menuitem" className="list-row" onClick={() => { openFile(tab); setShowOverflow(false) }}>
                      <span className="truncate">{basename(tab)}</span>
                    </button>
                  ))}
                  {openTabs.length > 0 && (
                    <button
                      role="menuitem"
                      className="list-row"
                      style={{ color: 'var(--danger)', borderTop: '1px solid var(--border-subtle)', marginTop: 4 }}
                      onClick={() => { closeAllTabs(); setShowOverflow(false) }}
                    >
                      Close all editors
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Editor ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative">
        {activeFile ? (
          <MonacoEditor
            path={activeFile}
            height="100%"
            language={activeFileIsBinary ? 'plaintext' : language}
            value={activeFileContent}
            onChange={(v) => setActiveFileContent(v ?? '')}
            onMount={handleMount}
            theme="vs-dark"
            loading={<span className="text-[12px] font-mono text-text-muted animate-pulse">Loading editor…</span>}
            options={{
              ...monacoOptionsFrom(settings),
              readOnly: isAiWriting || activeFileIsBinary,
              domReadOnly: activeFileIsBinary,
            }}
          />
        ) : (
          <EmptyEditor />
        )}
        {isAiWriting && <div className="absolute inset-x-0 top-0 h-0.5 writing-indicator" />}
      </div>

      {/* Vim's mode indicator and ':' command line. Rendered only in vim mode so
          it never takes vertical space from users who don't use it. */}
      {settings.vimMode && <div ref={vimStatusRef} className="vim-status" aria-live="polite" />}
    </div>
  )
}

/**
 * No file open. Names the two fastest ways in rather than decorating the void —
 * an empty state's job is to move the user, not to fill space.
 */
function EmptyEditor() {
  const setQuickOpen = useAppStore((s) => s.setQuickOpen)
  return (
    <div className="empty-state">
      <p className="empty-state-title">No file open</p>
      <p className="empty-state-hint">
        Open one from the Explorer, or jump straight to it by name.
      </p>
      <div className="flex items-center gap-2" style={{ marginTop: 'var(--space-2)' }}>
        <button className="btn btn-primary" onClick={() => setQuickOpen('files')}>
          Go to File
        </button>
        <span className="kbd">Ctrl</span>
        <span className="kbd">P</span>
      </div>
    </div>
  )
}
