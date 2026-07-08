/**
 * QuickOpen — fuzzy file finder (Ctrl+P) + project-wide symbol search (Ctrl+T).
 *
 * Files mode: fuzzy match over the file tree; empty query shows recent files.
 * Symbols mode: fuzzy match over CodeGraph Function/TypeDef nodes → jump to line.
 * This modal is the foundation the A5 command palette will extend.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { File, Clock, FunctionSquare, Box, Terminal } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import type { FileNode, GraphNode } from '../../lib/types'

/** A5: every registered action, fuzzy-searchable via Ctrl+Shift+P */
function buildCommands(close: () => void): { label: string; hint?: string; run: () => void }[] {
  const s = () => useAppStore.getState()
  return [
    { label: 'Go to File…', hint: 'Ctrl+P', run: () => s().setQuickOpen('files') },
    { label: 'Go to Symbol…', hint: 'Ctrl+T', run: () => s().setQuickOpen('symbols') },
    { label: 'Find in Files', hint: 'Ctrl+Shift+F', run: () => { s().toggleSearch(); close() } },
    { label: 'Toggle File Explorer', run: () => { s().toggleExplorer(); close() } },
    { label: 'Toggle Problems Panel', run: () => { s().toggleProblems(); close() } },
    { label: 'Toggle Team & Chat Panel', run: () => { s().toggleTeamPanel(); close() } },
    { label: 'New File', run: () => { s().requestExplorerCreate('file'); close() } },
    { label: 'New Folder', run: () => { s().requestExplorerCreate('folder'); close() } },
    { label: 'Stop AI Generation', run: () => { s().cancelAi(); close() } },
    { label: 'Save', hint: 'Ctrl+S', run: () => { s().saveFile(); close() } },
    { label: 'Save All', hint: 'Ctrl+K S', run: () => { s().saveAll(); close() } },
    { label: 'Format Document', hint: 'Shift+Alt+F', run: () => { window.dispatchEvent(new CustomEvent('og:format')); close() } },
    { label: 'Reopen Closed Tab', hint: 'Ctrl+Shift+T', run: () => { s().reopenClosedTab(); close() } },
    { label: 'Close Tab', run: () => { s().closeActiveFile(); close() } },
    { label: 'Close Other Tabs', run: () => { s().closeOtherTabs(); close() } },
    { label: 'Close Saved Tabs', run: () => { s().closeSavedTabs(); close() } },
    { label: 'Close All Tabs', run: () => { s().closeAllTabs(); close() } },
    { label: 'Split: Open Active File in Right Pane', run: () => { const a = s().activeFile; if (a) s().setSplitFile(a); close() } },
    { label: 'Close Split Pane', run: () => { s().setSplitFile(null); close() } },
    { label: 'View: Canvas', run: () => { s().setWorkspaceView('canvas'); close() } },
    { label: 'View: Constellation', run: () => { s().setWorkspaceView('constellation'); close() } },
    { label: 'View: Timeline', run: () => { s().setWorkspaceView('timeline'); close() } },
    { label: 'View: Team', run: () => { s().setWorkspaceView('team'); close() } },
    { label: `Auto-Save: turn ${s().autoSave === 'idle' ? 'off' : 'on'}`, run: () => { s().setAutoSave(s().autoSave === 'idle' ? 'off' : 'idle'); close() } },
    { label: `Trim Trailing Whitespace on Save: turn ${s().trimOnSave ? 'off' : 'on'}`, run: () => { s().setTrimOnSave(!s().trimOnSave); close() } },
    { label: 'Undo Last Delete', run: () => { s().undoLastDelete(); close() } },
    { label: 'Refresh File Tree & Git Status', run: () => { s().loadFileTree(); close() } },
    { label: 'Clear Chat History', run: () => { s().clearChatHistory(); close() } },
    { label: 'Leave Project', run: () => { s().clearProject(); s().setView('onboarding_project'); close() } },
  ]
}

/** fzf-style subsequence scorer — higher is better, -1 = no match */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      streak++
      qi++
      score += 1 + streak * 2 + (ti === 0 || '/._- '.includes(t[ti - 1]) ? 8 : 0)
    } else {
      streak = 0
    }
  }
  if (qi < q.length) return -1
  return score - t.length * 0.05
}

function flattenFiles(nodes: FileNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.is_dir) {
      if (n.children) out.push(...flattenFiles(n.children))
    } else {
      out.push(n.path)
    }
  }
  return out
}

interface Item {
  key: string
  label: string
  detail: string
  icon: 'file' | 'recent' | 'fn' | 'type' | 'cmd'
  action: () => void
}

export function QuickOpen() {
  const {
    quickOpenMode, setQuickOpen, fileTree, recentFiles,
    openFile, openFileAtLine,
  } = useAppStore()

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [symbols, setSymbols] = useState<GraphNode[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const isOpen = quickOpenMode !== null

  // Reset + focus on open; fetch symbols when entering symbol mode
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setSelected(0)
    setTimeout(() => inputRef.current?.focus(), 30)
    if (quickOpenMode === 'symbols') {
      api.getGraphJson()
        .then((g) => setSymbols((g.nodes ?? []).filter((n) => n.kind !== 'File')))
        .catch(() => setSymbols([]))
    }
  }, [isOpen, quickOpenMode])

  const items: Item[] = useMemo(() => {
    if (!isOpen) return []

    if (quickOpenMode === 'files') {
      const all = flattenFiles(fileTree)
      const allSet = new Set(all)

      if (!query.trim()) {
        const recents = recentFiles.filter((r) => allSet.has(r))
        const rest = all.filter((f) => !recents.includes(f)).slice(0, 30)
        return [
          ...recents.map<Item>((f) => ({
            key: f,
            label: f.split('/').pop() ?? f,
            detail: f,
            icon: 'recent',
            action: () => { openFile(f); setQuickOpen(null) },
          })),
          ...rest.map<Item>((f) => ({
            key: f,
            label: f.split('/').pop() ?? f,
            detail: f,
            icon: 'file',
            action: () => { openFile(f); setQuickOpen(null) },
          })),
        ].slice(0, 50)
      }

      return all
        .map((f) => ({ f, s: fuzzyScore(query, f) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map<Item>(({ f }) => ({
          key: f,
          label: f.split('/').pop() ?? f,
          detail: f,
          icon: 'file',
          action: () => { openFile(f); setQuickOpen(null) },
        }))
    }

    // Commands mode (A5)
    if (quickOpenMode === 'commands') {
      return buildCommands(() => setQuickOpen(null))
        .map((c) => ({ c, s: fuzzyScore(query, c.label) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .map<Item>(({ c }) => ({
          key: c.label,
          label: c.label,
          detail: c.hint ?? '',
          icon: 'cmd',
          action: c.run,
        }))
    }

    // Symbols mode
    return symbols
      .map((n) => ({ n, s: fuzzyScore(query, n.name) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map<Item>(({ n }) => ({
        key: n.id,
        label: n.name,
        detail: `${n.path}${n.line ? `:${n.line}` : ''}${n.type_kind ? `  ·  ${n.type_kind}` : ''}`,
        icon: n.kind === 'Function' ? 'fn' : 'type',
        action: () => { openFileAtLine(n.path, n.line ?? 1, 0); setQuickOpen(null) },
      }))
  }, [isOpen, quickOpenMode, query, fileTree, recentFiles, symbols, openFile, openFileAtLine, setQuickOpen])

  // Clamp selection + keep it visible
  useEffect(() => { setSelected(0) }, [query])
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (!isOpen) return null

  const ICONS = {
    file:   <File size={12} className="text-cyan/60 shrink-0" />,
    recent: <Clock size={12} className="text-purple-light shrink-0" />,
    fn:     <FunctionSquare size={12} className="text-green shrink-0" />,
    type:   <Box size={12} className="text-purple-light shrink-0" />,
    cmd:    <Terminal size={12} className="text-cyan shrink-0" />,
  }

  const MODE_LABEL = { files: 'FILES', symbols: 'SYMBOLS', commands: 'COMMANDS' } as const
  const MODE_PLACEHOLDER = {
    files: 'Jump to file…',
    symbols: 'Search symbols…',
    commands: 'Run a command…',
  } as const

  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center pt-[12vh]"
      style={{ background: 'rgba(0,2,8,0.55)' }}
      onClick={() => setQuickOpen(null)}
    >
      <motion.div
        initial={{ opacity: 0, y: -10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.14, ease: 'easeOut' }}
        className="w-[520px] max-w-[90vw] glass-elevated rounded-xl overflow-hidden"
        style={{
          border: '0.6px solid rgba(0,200,255,0.3)',
          boxShadow: '0 0 40px rgba(0,200,255,0.1), 0 16px 48px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '0.5px solid rgba(0,200,255,0.12)' }}
        >
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(0,200,255,0.08)', border: '0.5px solid rgba(0,200,255,0.25)', color: '#00C8FF' }}
          >
            {MODE_LABEL[quickOpenMode!]}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, items.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); items[selected]?.action() }
              else if (e.key === 'Escape') { setQuickOpen(null) }
            }}
            placeholder={MODE_PLACEHOLDER[quickOpenMode!]}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-dim outline-none font-mono"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <p className="text-[11px] text-text-muted text-center py-6">
              {quickOpenMode === 'symbols' && symbols.length === 0
                ? 'No symbols indexed yet — open a project file first'
                : 'No matches'}
            </p>
          )}
          {items.map((item, i) => (
            <button
              key={item.key}
              onClick={item.action}
              onMouseEnter={() => setSelected(i)}
              className="w-full flex items-center gap-2.5 px-4 py-1.5 text-left transition-colors"
              style={i === selected ? { background: 'rgba(0,200,255,0.08)' } : undefined}
            >
              {ICONS[item.icon]}
              <span className={`text-[12px] shrink-0 ${i === selected ? 'text-cyan' : 'text-text-primary'}`}>
                {item.label}
              </span>
              <span className="text-[10px] font-mono text-text-muted truncate">{item.detail}</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-4 py-2 text-[9px] font-mono text-text-muted/50"
          style={{ borderTop: '0.5px solid rgba(255,255,255,0.05)' }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">
            {quickOpenMode === 'files' ? 'Ctrl+T symbols · Ctrl+Shift+P commands'
              : quickOpenMode === 'symbols' ? 'Ctrl+P files · Ctrl+Shift+P commands'
              : 'Ctrl+P files · Ctrl+T symbols'}
          </span>
        </div>
      </motion.div>
    </div>
  )
}
