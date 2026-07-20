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
import { X, Plus, MoreHorizontal, Circle, Check } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import { getFileLanguage, basename } from '../../lib/utils'
import { registerLspProviders, lspOpen, lspChange, lspClose } from '../../lib/lsp'
import { bindEditor, unbind } from '../../lib/crdt'

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
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [eol, setEol] = useState<'LF' | 'CRLF'>('LF')
  const [indent, setIndent] = useState('Spaces: 2')
  const [editorReady, setEditorReady] = useState(false)
  const [showOverflow, setShowOverflow] = useState(false)

  const language = getFileLanguage(activeFile ?? '')
  const peersOnline = collaborators.some((c) => !c.is_self && c.status !== 'offline')

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

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setEditorReady(true)
    registerCliFormatters(monaco)
    registerLspProviders(monaco)
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
      minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false,
      smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'gutter', padding: { top: 10, bottom: 10 }, overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true, scrollbar: { verticalScrollbarSize: 5, horizontalScrollbarSize: 5 },
    })
  }

  return (
    <div className="flex flex-col h-full w-full">
      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 h-8 shrink-0 overflow-hidden"
        style={{ borderBottom: '1px solid rgba(140,200,255,0.08)' }}
      >
        <div className="flex items-center gap-1 overflow-x-auto flex-1" style={{ scrollbarWidth: 'none' }}>
          {openTabs.map((tab) => {
            const buf = tabCache[tab]
            const dirty = tab === activeFile ? isDirty : Boolean(buf && !buf.isBinary && buf.content !== buf.savedContent)
            const isActive = tab === activeFile
            return (
              <div key={tab}
                onClick={() => { if (!isActive) openFile(tab) }}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab) } }}
                className="group flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-lg cursor-pointer transition-colors"
                style={isActive
                  ? { background: 'rgba(0,200,255,0.12)', border: '0.5px solid rgba(0,200,255,0.35)' }
                  : { background: 'rgba(255,255,255,0.03)', border: '0.5px solid transparent' }}
                title={tab}
              >
                <span className={`text-[10px] font-mono truncate max-w-[110px] ${isActive ? 'text-cyan' : 'text-text-muted group-hover:text-text-secondary'}`}>
                  {basename(tab)}
                </span>
                {dirty && <Circle size={6} className="fill-orange text-orange shrink-0" />}
                <button onClick={(e) => { e.stopPropagation(); closeTab(tab) }} className="text-text-muted/30 hover:text-text-primary shrink-0">
                  <X size={10} />
                </button>
              </div>
            )
          })}
        </div>
        {/* + new file */}
        <button onClick={() => requestExplorerCreate('file')} className="p-1 rounded text-text-muted/50 hover:text-cyan shrink-0" title="New file">
          <Plus size={13} />
        </button>
        {/* ••• overflow */}
        <div className="relative shrink-0">
          <button onClick={() => setShowOverflow((v) => !v)} className="p-1 rounded text-text-muted/50 hover:text-text-primary" title="Tabs menu">
            <MoreHorizontal size={13} />
          </button>
          {showOverflow && (
            <>
              <div className="fixed inset-0 z-[80]" onClick={() => setShowOverflow(false)} />
              <div className="absolute right-0 top-full mt-1 w-40 glasscard-surface z-[90] py-1 max-h-60 overflow-y-auto">
                {openTabs.map((tab) => (
                  <button key={tab} onClick={() => { openFile(tab); setShowOverflow(false) }}
                    className="w-full text-left px-3 py-1 text-[10px] font-mono text-text-secondary hover:text-cyan hover:bg-cyan/8 truncate">
                    {basename(tab)}
                  </button>
                ))}
                {openTabs.length > 0 && (
                  <button onClick={() => { closeAllTabs(); setShowOverflow(false) }}
                    className="w-full text-left px-3 py-1 text-[10px] font-mono text-red/70 hover:text-red border-t border-white/5 mt-1">
                    Close all tabs
                  </button>
                )}
              </div>
            </>
          )}
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
            loading={<span className="text-[11px] font-mono text-text-muted animate-pulse">Loading editor…</span>}
            options={{ readOnly: isAiWriting || activeFileIsBinary, domReadOnly: activeFileIsBinary }}
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl font-display font-bold text-gradient mb-2 opacity-25">0G</div>
              <p className="text-[11px] text-text-muted">Open a file from the File Explorer disc</p>
            </div>
          </div>
        )}
        {isAiWriting && <div className="absolute inset-x-0 top-0 h-0.5 writing-indicator" />}
      </div>

      {/* ── Status bar (full reference set) ────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 h-6 shrink-0 text-[10px] font-mono text-text-muted"
        style={{ borderTop: '1px solid rgba(140,200,255,0.08)' }}
      >
        <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
        <span className="text-border">·</span>
        <span>{activeFileIsBinary ? 'binary' : indent}</span>
        <span className="text-border">·</span>
        <span>UTF-8</span>
        <span className="text-border">·</span>
        <span>{eol}</span>
        <span className="text-border">·</span>
        <span className="uppercase">{activeFileIsBinary ? 'binary' : language}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {isDirty ? (
            <><Circle size={7} className="fill-orange text-orange" /><span className="text-orange">Unsaved</span></>
          ) : activeFile ? (
            <><Check size={11} className="text-green" /><span className="text-green">Saved</span></>
          ) : null}
        </div>
      </div>
    </div>
  )
}
