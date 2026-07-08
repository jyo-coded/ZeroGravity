/**
 * FloatingCards — canvas view with floating code cards + inline constellation.
 *
 * SVG Concept Layout:
 *   - Active card (large, cyan glow corona, Monaco editor, AI cursor, footer pills)
 *   - Dimmed cards (smaller, semi-transparent, peer badges)
 *   - Ghost card (+ new file, dashed border)
 *   - Inline Project Constellation (right side of canvas)
 *
 * Wires to: openFile, closeActiveFile, setActiveFileContent, saveFile,
 *           revertLastApply, isAiWriting, isDirty, lastApplyEntryId,
 *           fileTree, expandedDirs, toggleDir, createFile, changelog
 */

import { useRef, useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import MonacoEditor, { OnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { X, Save, Undo2, ChevronRight, Plus, Loader2 } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import { getFileLanguage, basename } from '../../lib/utils'
import { InlineConstellation } from './InlineConstellation'
import { registerLspProviders, lspOpen, lspChange, lspClose } from '../../lib/lsp'
import { bindEditor, unbind } from '../../lib/crdt'

// Register CLI-backed document formatters exactly once per app session.
// Rust → rustfmt, Python → black (always registered — Monaco has no built-in).
// JS/TS/JSON/CSS/HTML/MD → prettier, registered ONLY when a prettier install
// is detected, so Monaco's built-in formatters keep working without it (#2).
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
            useAppStore.getState().addNotification({
              type: 'error',
              detail: 'Format Failed',
              message: String(e),
            })
            return []
          }
        },
      })
    }
  }

  register(['rust', 'python'])
  api.detectFormatters()
    .then((det) => {
      if (det.prettier) {
        register(['javascript', 'typescript', 'json', 'css', 'html', 'markdown'])
      }
    })
    .catch(() => { /* detection failed — built-ins remain */ })
}

export function FloatingCards() {
  const {
    activeFile, activeFileContent, activeFileIsBinary,
    openFile, closeActiveFile, setActiveFileContent,
    isAiWriting, saveFile, isDirty,
    lastApplyEntryId, revertLastApply, createFile,
    changelog, openTabs, tabCache, closeTab, setOpenTabs,
    pendingReveal, clearPendingReveal, lastSavedContent,
    splitFile, setSplitFile, setTabContent, saveTab,
    collaborators,
  } = useAppStore()

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const gitDecosRef = useRef<string[]>([])
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [isCreating, setIsCreating] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [editorReady, setEditorReady] = useState(false)

  // T1: live CRDT collaboration is active only while a peer is online
  const peersOnline = collaborators.some((c) => !c.is_self && c.status !== 'offline')

  const language = getFileLanguage(activeFile ?? '')

  // Build list of recently-edited files for dimmed cards
  const recentFiles = useMemo(() => {
    const seen = new Set<string>()
    const files: { path: string; user: string; model: string; color: string }[] = []
    for (const entry of [...changelog].reverse()) {
      if (!seen.has(entry.file) && entry.file !== activeFile) {
        seen.add(entry.file)
        files.push({
          path: entry.file,
          user: entry.changed_by,
          model: entry.model,
          color: entry.changed_by === 'You' ? '#00C8FF' : '#00FF88',
        })
      }
      if (files.length >= 2) break
    }
    return files
  }, [changelog, activeFile])

  // A3: consume pendingReveal — jump to line/col once the target file is active
  useEffect(() => {
    if (!pendingReveal || pendingReveal.path !== activeFile || !editorRef.current) return
    const t = setTimeout(() => {
      const ed = editorRef.current
      if (!ed) return
      try {
        const line = Math.max(1, pendingReveal.line)
        const col = Math.max(1, pendingReveal.col + 1)
        ed.revealLineInCenter(line)
        ed.setPosition({ lineNumber: line, column: col })
        ed.focus()
      } catch { /* line may be out of range for a stale result — ignore */ }
      clearPendingReveal()
    }, 80)
    return () => clearTimeout(t)
  }, [pendingReveal, activeFile, activeFileContent, clearPendingReveal])

  // Ctrl+S global save handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [saveFile])

  // T1: bind the active editor to the shared CRDT doc while peers are online.
  // Solo (no peers) → no binding → editor behaves exactly as before.
  useEffect(() => {
    if (!activeFile || activeFileIsBinary || !editorReady || !peersOnline) return
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    let disposer: (() => void) | null = null
    let cancelled = false
    bindEditor(activeFile, editor, monaco).then((d) => {
      if (cancelled) d()
      else disposer = d
    })
    return () => {
      cancelled = true
      if (disposer) disposer()
      else unbind(activeFile)
    }
  }, [activeFile, activeFileIsBinary, editorReady, peersOnline])

  // A4: LSP document lifecycle — open/close with the active file
  useEffect(() => {
    if (!activeFile || activeFileIsBinary) return
    const lang = getFileLanguage(activeFile)
    lspOpen(activeFile, useAppStore.getState().activeFileContent, lang)
    return () => { lspClose(activeFile, lang) }
  }, [activeFile, activeFileIsBinary])

  // A4: debounced didChange while typing
  useEffect(() => {
    if (!activeFile || activeFileIsBinary) return
    const t = setTimeout(() => {
      lspChange(activeFile, activeFileContent, getFileLanguage(activeFile))
    }, 300)
    return () => clearTimeout(t)
  }, [activeFileContent, activeFile, activeFileIsBinary])

  // A5: command palette "Format Document"
  useEffect(() => {
    const handler = () => {
      editorRef.current?.getAction('editor.action.formatDocument')?.run()
    }
    window.addEventListener('og:format', handler)
    return () => window.removeEventListener('og:format', handler)
  }, [])

  // A6: git diff gutter — refresh after open/save (lastSavedContent changes)
  useEffect(() => {
    const ed = editorRef.current
    const monaco = monacoRef.current
    if (!ed || !monaco || !activeFile) return
    if (!useAppStore.getState().gitBranch) {
      gitDecosRef.current = ed.deltaDecorations(gitDecosRef.current, [])
      return
    }
    let cancelled = false
    api.gitDiffFile(activeFile)
      .then((hunks) => {
        if (cancelled || !editorRef.current) return
        const decos = hunks.map((h) => ({
          range: new monaco.Range(h.start, 1, h.end, 1),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `git-gutter-${h.kind}`,
          },
        }))
        gitDecosRef.current = editorRef.current.deltaDecorations(gitDecosRef.current, decos)
      })
      .catch(() => { /* not a repo or git missing — gutter stays clean */ })
    return () => { cancelled = true }
  }, [activeFile, lastSavedContent])

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setEditorReady(true)
    registerCliFormatters(monaco)
    registerLspProviders(monaco)
    editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, col: e.position.column })
    })
    editor.updateOptions({
      automaticLayout: true,
      autoIndent: 'full',
      fontSize: 12,
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
      fontLigatures: true,
      minimap: { enabled: false },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'gutter',
      padding: { top: 12, bottom: 12 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 4, horizontalScrollbarSize: 4 },
    })
  }

  return (
    <div className="flex-1 h-full w-full relative overflow-hidden">
      {/* ═══ Canvas area with floating cards ═══ */}
      <div className="absolute inset-0 flex">

        {/* ─── Left / Center: Floating code cards ──────────────────────── */}
        <div className="flex-1 relative p-4 min-w-0">

          {/* ─── Tab strip (drag to reorder) ────────────────────────────── */}
          {openTabs.length > 0 && (
            <Reorder.Group
              axis="x"
              values={openTabs}
              onReorder={setOpenTabs}
              as="div"
              className="absolute left-4 top-3 right-[40%] z-10 flex items-center gap-1 overflow-x-auto pb-1"
              style={{ scrollbarWidth: 'none' }}
            >
              {openTabs.map((tab) => {
                const buf = tabCache[tab]
                const tabDirty = tab === activeFile
                  ? isDirty
                  : Boolean(buf && !buf.isBinary && buf.content !== buf.savedContent)
                const isActiveTab = tab === activeFile
                return (
                  <Reorder.Item
                    key={tab}
                    value={tab}
                    as="div"
                    onClick={(e: React.MouseEvent) => {
                      if (e.altKey) { setSplitFile(tab); return }  // Alt+click → open in split pane
                      if (!isActiveTab) openFile(tab)
                    }}
                    onMouseDown={(e: React.MouseEvent) => { if (e.button === 1) { e.preventDefault(); closeTab(tab) } }}
                    title={`${tab}\nAlt+click: open in split pane`}
                    className="group flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-lg cursor-pointer transition-colors duration-150"
                    style={isActiveTab ? {
                      background: 'rgba(0,200,255,0.1)',
                      border: '0.5px solid rgba(0,200,255,0.35)',
                    } : {
                      background: 'rgba(0,5,16,0.55)',
                      border: '0.5px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <span className={`text-[10px] font-mono truncate max-w-[120px] ${isActiveTab ? 'text-cyan' : 'text-text-muted group-hover:text-text-secondary'}`}>
                      {basename(tab)}
                    </span>
                    {tabDirty && <div className="w-1.5 h-1.5 rounded-full bg-orange shrink-0" />}
                    <button
                      onClick={(e) => { e.stopPropagation(); closeTab(tab) }}
                      className="text-text-muted/30 hover:text-text-primary transition-colors shrink-0"
                    >
                      <X size={10} />
                    </button>
                  </Reorder.Item>
                )
              })}
            </Reorder.Group>
          )}

          {/* ─── Active File Card (large, cyan glow) ────────────────────── */}
          <AnimatePresence mode="wait">
            {activeFile ? (
              <motion.div
                key="editor-card"
                initial={{ opacity: 0, scale: 0.97, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: -8 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className={`absolute left-4 ${openTabs.length > 0 ? 'top-[46px]' : 'top-4'} right-[40%] bottom-[140px] flex flex-col min-w-0 overflow-hidden`}
                style={{
                  background: isAiWriting ? 'rgba(0, 4, 14, 0.9)' : 'rgba(0, 5, 16, 0.75)',
                  borderRadius: '14px',
                  border: `1px solid ${isAiWriting ? 'rgba(0, 200, 255, 0.35)' : 'rgba(0, 200, 255, 0.15)'}`,
                  boxShadow: isAiWriting
                    ? '0 0 40px rgba(0, 200, 255, 0.15), 0 0 80px rgba(0, 200, 255, 0.06), 0 8px 32px rgba(0, 0, 0, 0.4)'
                    : '0 0 20px rgba(0, 200, 255, 0.08), 0 8px 32px rgba(0, 0, 0, 0.4)',
                }}
              >
                {/* Card header */}
                <div className="flex items-center gap-2 px-4 h-10 shrink-0"
                  style={{ borderBottom: '1px solid rgba(0,200,255,0.1)' }}
                >
                  {/* File path breadcrumb — dir segments open + expand the explorer */}
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    {activeFile.split('/').map((seg, i, arr) => (
                      <span key={i} className="flex items-center gap-1">
                        {i < arr.length - 1 ? (
                          <button
                            onClick={() => {
                              const s = useAppStore.getState()
                              const prefixes: string[] = []
                              for (let k = 0; k <= i; k++) prefixes.push(arr.slice(0, k + 1).join('/'))
                              useAppStore.setState({
                                explorerOpen: true,
                                expandedDirs: new Set([...s.expandedDirs, ...prefixes]),
                              })
                            }}
                            className="text-xs font-mono text-text-muted hover:text-text-secondary transition-colors"
                            title={`Reveal ${arr.slice(0, i + 1).join('/')} in Explorer`}
                          >
                            {seg}
                          </button>
                        ) : (
                          <span className="text-xs font-mono text-cyan">{seg}</span>
                        )}
                        {i < arr.length - 1 && <ChevronRight size={10} className="text-text-muted/30" />}
                      </span>
                    ))}
                  </div>

                  {/* Dirty indicator */}
                  {isDirty && <div className="w-2 h-2 rounded-full bg-orange shrink-0" title="Unsaved changes" />}

                  {/* AI Writing indicator */}
                  {isAiWriting && (
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(0,200,255,0.1)', border: '0.5px solid rgba(0,200,255,0.3)' }}
                    >
                      <Loader2 size={10} className="animate-spin text-cyan" />
                      <span className="text-[10px] font-mono text-cyan">AI Writing</span>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 ml-2">
                    {lastApplyEntryId && !activeFileIsBinary && (
                      <button
                        onClick={revertLastApply}
                        disabled={isAiWriting}
                        className="p-1 rounded text-cyan/60 hover:text-cyan hover:bg-cyan/10 transition-colors disabled:opacity-50"
                        title="Undo last AI change"
                      >
                        <Undo2 size={11} />
                      </button>
                    )}
                    {isDirty && !activeFileIsBinary && (
                      <button
                        onClick={saveFile}
                        className="p-1 rounded text-orange/60 hover:text-orange hover:bg-orange/10 transition-colors"
                        title="Save (Ctrl+S)"
                      >
                        <Save size={11} />
                      </button>
                    )}
                    <button
                      onClick={closeActiveFile}
                      className="p-1 rounded text-text-muted/40 hover:text-text-primary hover:bg-surface/30 transition-colors"
                      title="Close file"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>

                {/* Binary badge */}
                {activeFileIsBinary && (
                  <div className="px-4 py-1.5"
                    style={{ background: 'rgba(255,165,0,0.05)', borderBottom: '1px solid rgba(255,165,0,0.1)' }}
                  >
                    <span className="text-[10px] font-mono uppercase tracking-wider text-orange">
                      Read-only binary preview
                    </span>
                  </div>
                )}

                {/* Monaco Editor (+ optional split pane, #3) */}
                <div className="flex-1 min-h-0 relative flex">
                  <div className="flex-1 min-w-0 relative">
                    <MonacoEditor
                      path={activeFile}
                      height="100%"
                      language={activeFileIsBinary ? 'plaintext' : language}
                      value={activeFileContent}
                      onChange={(val) => setActiveFileContent(val ?? '')}
                      onMount={handleEditorMount}
                      theme="vs-dark"
                      loading={<span className="text-[11px] font-mono text-text-muted animate-pulse">Loading editor…</span>}
                      options={{
                        readOnly: isAiWriting || activeFileIsBinary,
                        domReadOnly: activeFileIsBinary,
                      }}
                    />
                    {/* AI cursor blink indicator */}
                    {isAiWriting && (
                      <div className="absolute inset-x-0 top-0 h-0.5 writing-indicator" />
                    )}
                  </div>

                  {splitFile && tabCache[splitFile] && (
                    <div className="flex-1 min-w-0 flex flex-col"
                      style={{ borderLeft: '1px solid rgba(0,200,255,0.15)' }}
                    >
                      {/* Split pane header */}
                      <div className="flex items-center gap-2 px-3 h-7 shrink-0"
                        style={{ borderBottom: '1px solid rgba(0,200,255,0.08)', background: 'rgba(0,200,255,0.03)' }}
                      >
                        <span className="text-[10px] font-mono text-text-secondary truncate flex-1" title={splitFile}>
                          {basename(splitFile)}
                        </span>
                        {tabCache[splitFile].content !== tabCache[splitFile].savedContent && (
                          <>
                            <div className="w-1.5 h-1.5 rounded-full bg-orange shrink-0" />
                            <button
                              onClick={() => saveTab(splitFile)}
                              className="p-0.5 rounded text-orange/60 hover:text-orange transition-colors"
                              title="Save split file"
                            >
                              <Save size={10} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => setSplitFile(null)}
                          className="p-0.5 rounded text-text-muted/40 hover:text-text-primary transition-colors"
                          title="Close split"
                        >
                          <X size={11} />
                        </button>
                      </div>
                      <div className="flex-1 min-h-0">
                        <MonacoEditor
                          path={`split://${splitFile}`}
                          height="100%"
                          language={tabCache[splitFile].isBinary ? 'plaintext' : getFileLanguage(splitFile)}
                          value={tabCache[splitFile].content}
                          onChange={(val) => setTabContent(splitFile, val ?? '')}
                          theme="vs-dark"
                          options={{
                            readOnly: tabCache[splitFile].isBinary,
                            automaticLayout: true,
                            fontSize: 12,
                            fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace",
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            padding: { top: 12, bottom: 12 },
                            scrollbar: { verticalScrollbarSize: 4, horizontalScrollbarSize: 4 },
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Card footer — action pills */}
                <div className="flex items-center justify-between px-4 h-8 shrink-0"
                  style={{ borderTop: '1px solid rgba(0,200,255,0.08)' }}
                >
                  <div className="flex items-center gap-3 text-[10px] font-mono text-text-muted">
                    <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
                    <span className="uppercase">{activeFileIsBinary ? 'binary' : language}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isDirty && (
                      <span className="text-[10px] font-mono text-orange px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(255,165,0,0.08)', border: '0.5px solid rgba(255,165,0,0.3)' }}
                      >
                        unsaved
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <div className="text-center">
                  <div className="text-5xl font-display font-bold text-gradient mb-3 opacity-20">0G</div>
                  <p className="text-sm text-text-muted">Click a file in the constellation</p>
                  <p className="text-xs text-text-muted/40 mt-1">or ask AI to create one</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ─── Dimmed cards (recent files from changelog) ─────────────── */}
          {recentFiles.map((rf, i) => (
            <motion.div
              key={rf.path}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.05 }}
              onClick={() => openFile(rf.path)}
              className="absolute cursor-pointer group transition-all duration-200"
              style={{
                right: i === 0 ? '42%' : '44%',
                top: i === 0 ? '16px' : '80px',
                width: '180px',
                background: 'rgba(0,5,16,0.5)',
                borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.06)',
                padding: '12px',
                opacity: 0.6 - i * 0.15,
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-mono text-text-muted truncate">{basename(rf.path)}</span>
                <div className="ml-auto flex items-center gap-1">
                  <div className="w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold"
                    style={{ backgroundColor: rf.color, color: '#000408' }}
                  >
                    {rf.user.slice(0, 1).toUpperCase()}
                  </div>
                </div>
              </div>
              {/* Fake code lines */}
              <div className="space-y-1">
                {[0.7, 0.5, 0.6, 0.3].map((w, li) => (
                  <div key={li} className="h-[3px] rounded-full"
                    style={{ width: `${w * 100}%`, background: 'rgba(226,232,240,0.08)' }}
                  />
                ))}
              </div>
              {/* Hover glow */}
              <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{ boxShadow: '0 0 20px rgba(0,200,255,0.08)' }}
              />
            </motion.div>
          ))}

          {/* ─── Ghost card (+ new file) ────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="absolute cursor-pointer group"
            style={{
              right: '42%',
              bottom: '160px',
              width: '140px',
              height: '80px',
              borderRadius: '12px',
              border: '1px dashed rgba(0,200,255,0.15)',
              background: 'rgba(0,200,255,0.02)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: '6px',
            }}
            onClick={() => setIsCreating(true)}
          >
            <Plus size={16} className="text-cyan/30 group-hover:text-cyan/60 transition-colors" />
            <span className="text-[9px] font-mono text-cyan/25 group-hover:text-cyan/50 transition-colors">
              new file
            </span>
          </motion.div>

          {/* ─── New file creation modal ────────────────────────────────── */}
          <AnimatePresence>
            {isCreating && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50"
              >
                <form
                  className="w-72 rounded-xl glass-elevated border border-cyan/20 p-4 shadow-glow"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const path = newFilePath.trim()
                    if (!path) return
                    await createFile(path)
                    setNewFilePath('')
                    setIsCreating(false)
                  }}
                >
                  <div className="text-xs font-display font-semibold text-cyan mb-3 tracking-wider">NEW FILE</div>
                  <input
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { setNewFilePath(''); setIsCreating(false) } }}
                    placeholder="src/new-file.ts"
                    autoFocus
                    className="w-full bg-void/50 text-xs text-text-primary placeholder-text-dim font-mono px-3 py-2 rounded-lg border border-border/40 focus:border-cyan/30 outline-none"
                  />
                  <div className="flex items-center gap-2 mt-3">
                    <button type="submit" className="btn-beam text-[10px] px-3 py-1">Create</button>
                    <button
                      type="button"
                      onClick={() => { setNewFilePath(''); setIsCreating(false) }}
                      className="text-[10px] text-text-muted hover:text-text-primary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ─── Right side: Inline Constellation ────────────────────────── */}
        <div className="w-[35%] relative shrink-0">
          <InlineConstellation />
        </div>
      </div>
    </div>
  )
}

