/**
 * SearchPanel — project-wide find & replace (Ctrl+Shift+F).
 *
 * Search runs over the backend context map (RAM-hot, ignore rules applied).
 * Replace routes every modified file through the orchestrator → changelog
 * entry + P2P broadcast — never a raw disk write.
 * Per-match checkboxes give per-match confirm; "Replace" applies selected.
 */

import { useState, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { Search, CaseSensitive, Regex, ChevronRight, ChevronDown, Replace } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import type { SearchMatch } from '../../lib/types'
import { basename } from '../../lib/utils'

const matchKey = (m: SearchMatch) => `${m.file}:${m.line}:${m.col}`

export function SearchPanel() {
  const { openFileAtLine, addNotification, addChangelogEntry, loadFileTree, openFile, activeFile, isDirty } = useAppStore()

  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [isRegex, setIsRegex] = useState(false)
  const [includeGlob, setIncludeGlob] = useState('')
  const [excludeGlob, setExcludeGlob] = useState('')
  const [results, setResults] = useState<SearchMatch[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<'idle' | 'searching' | 'done'>('idle')
  const [replacing, setReplacing] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  async function runSearch(q: string) {
    if (!q.trim()) { setResults([]); setStatus('idle'); return }
    setStatus('searching')
    try {
      const res = await api.searchProject({
        query: q, caseSensitive, isRegex,
        includeGlob: includeGlob.trim() || undefined,
        excludeGlob: excludeGlob.trim() || undefined,
      })
      setResults(res)
      setExcluded(new Set())
      setStatus('done')
    } catch (e: any) {
      setResults([])
      setStatus('done')
      addNotification({ type: 'error', detail: 'Search Failed', message: String(e) })
    }
  }

  function onQueryChange(q: string) {
    setQuery(q)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), 350)
  }

  const byFile = useMemo(() => {
    const map = new Map<string, SearchMatch[]>()
    for (const m of results) {
      const arr = map.get(m.file) ?? []
      arr.push(m)
      map.set(m.file, arr)
    }
    return map
  }, [results])

  const selectedCount = results.length - excluded.size

  async function doReplace() {
    const targets = results.filter((m) => !excluded.has(matchKey(m)))
    if (targets.length === 0) return
    const fileCount = new Set(targets.map((t) => t.file)).size
    if (!window.confirm(`Replace ${targets.length} match(es) across ${fileCount} file(s)?\n\nEvery file goes through the orchestrator — the change is logged and broadcast, and revertible from the Mission Log.`)) return
    setReplacing(true)
    try {
      const entries = await api.replaceInFiles(
        targets.map((t) => ({ file: t.file, line: t.line, col: t.col, len: t.len })),
        replacement,
      )
      entries.forEach(addChangelogEntry)
      await loadFileTree()
      // Reload active buffer if touched (and clean — never clobber unsaved edits)
      if (activeFile && !isDirty && entries.some((e) => e.file === activeFile)) {
        await openFile(activeFile)
      }
      addNotification({ type: 'change', detail: 'Replaced', message: `${targets.length} match(es) in ${fileCount} file(s)` })
      await runSearch(query)
    } catch (e: any) {
      addNotification({ type: 'error', detail: 'Replace Failed', message: String(e) })
    } finally {
      setReplacing(false)
    }
  }

  const toggleOpt = (fn: () => void) => { fn(); if (query.trim()) setTimeout(() => runSearch(query), 0) }

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 300, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="shrink-0 flex flex-col glass-panel overflow-hidden relative z-30"
      style={{ borderRight: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Header */}
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <span className="text-[12px] font-mono tracking-[0.2em] uppercase" style={{ color: 'rgba(0,200,255,0.5)' }}>
          Search
        </span>
      </div>

      <div className="p-3 space-y-2 shrink-0" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.05)' }}>
        {/* Query row */}
        <div className="flex items-center gap-1.5 rounded-lg px-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '0.6px solid rgba(0,200,255,0.25)' }}
        >
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query) }}
            placeholder="Search project…"
            className="flex-1 min-w-0 bg-transparent py-1.5 text-[12px] text-text-primary placeholder-text-dim outline-none font-mono"
          />
          <button
            onClick={() => toggleOpt(() => setCaseSensitive(!caseSensitive))}
            className={`p-0.5 rounded ${caseSensitive ? 'text-cyan' : 'text-text-muted/40 hover:text-text-muted'}`}
            title="Match case"
          >
            <CaseSensitive size={13} />
          </button>
          <button
            onClick={() => toggleOpt(() => setIsRegex(!isRegex))}
            className={`p-0.5 rounded ${isRegex ? 'text-cyan' : 'text-text-muted/40 hover:text-text-muted'}`}
            title="Regular expression"
          >
            <Regex size={12} />
          </button>
        </div>

        {/* Replace row */}
        <div className="flex items-center gap-1.5 rounded-lg px-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '0.6px solid rgba(255,255,255,0.08)' }}
        >
          <Replace size={12} className="text-text-muted shrink-0" />
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with…"
            className="flex-1 min-w-0 bg-transparent py-1.5 text-[12px] text-text-primary placeholder-text-dim outline-none font-mono"
          />
          <button
            onClick={doReplace}
            disabled={replacing || selectedCount === 0}
            className="text-[12px] font-mono px-2 py-0.5 rounded-full disabled:opacity-30 shrink-0"
            style={{ background: 'rgba(0,255,136,0.12)', border: '0.5px solid rgba(0,255,136,0.5)', color: '#00FF88' }}
          >
            {replacing ? '…' : `Replace ${selectedCount || ''}`}
          </button>
        </div>

        {/* Globs */}
        <div className="flex items-center gap-1.5">
          <input
            value={includeGlob}
            onChange={(e) => setIncludeGlob(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query) }}
            placeholder="include: *.rs, src/**"
            className="flex-1 min-w-0 bg-transparent rounded-lg px-2 py-1 text-[12px] text-text-secondary placeholder-text-dim outline-none font-mono"
            style={{ background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.06)' }}
          />
          <input
            value={excludeGlob}
            onChange={(e) => setExcludeGlob(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(query) }}
            placeholder="exclude: *.json"
            className="flex-1 min-w-0 bg-transparent rounded-lg px-2 py-1 text-[12px] text-text-secondary placeholder-text-dim outline-none font-mono"
            style={{ background: 'rgba(255,255,255,0.03)', border: '0.5px solid rgba(255,255,255,0.06)' }}
          />
        </div>

        {/* Count */}
        {status === 'done' && (
          <p className="text-[12px] font-mono text-text-muted">
            {results.length === 0 ? 'No results' :
              `${results.length}${results.length >= 500 ? '+' : ''} result${results.length !== 1 ? 's' : ''} in ${byFile.size} file${byFile.size !== 1 ? 's' : ''}`}
          </p>
        )}
        {status === 'searching' && <p className="text-[12px] font-mono text-cyan animate-pulse">Searching…</p>}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto py-1">
        {[...byFile.entries()].map(([file, matches]) => {
          const isCollapsed = collapsed.has(file)
          return (
            <div key={file}>
              <button
                onClick={() => setCollapsed((s) => {
                  const n = new Set(s)
                  if (n.has(file)) n.delete(file); else n.add(file)
                  return n
                })}
                className="w-full flex items-center gap-1.5 px-3 py-1 hover:bg-surface/30 transition-colors"
              >
                {isCollapsed ? <ChevronRight size={10} className="text-text-muted shrink-0" /> : <ChevronDown size={10} className="text-text-muted shrink-0" />}
                <span className="text-[12px] font-mono text-cyan/80 truncate">{basename(file)}</span>
                <span className="text-[12px] font-mono text-text-muted/50 truncate flex-1 text-left">{file}</span>
                <span className="text-[12px] font-mono text-text-muted shrink-0">{matches.length}</span>
              </button>

              {!isCollapsed && matches.map((m) => {
                const key = matchKey(m)
                const checked = !excluded.has(key)
                const pre = m.line_text.slice(0, m.col)
                const mid = m.line_text.slice(m.col, m.col + m.len)
                const post = m.line_text.slice(m.col + m.len)
                return (
                  <div key={key} className="flex items-center gap-1.5 pl-7 pr-2 py-0.5 group hover:bg-surface/20">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setExcluded((s) => {
                        const n = new Set(s)
                        if (n.has(key)) n.delete(key); else n.add(key)
                        return n
                      })}
                      className="w-2.5 h-2.5 shrink-0 accent-cyan cursor-pointer"
                      title={checked ? 'Excluded from replace when unchecked' : 'Include in replace'}
                    />
                    <button
                      onClick={() => openFileAtLine(m.file, m.line, m.col)}
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                      title={`${m.file}:${m.line}`}
                    >
                      <span className="text-[12px] font-mono text-text-muted/60 shrink-0 w-7 text-right">{m.line}</span>
                      <span className="text-[12px] font-mono truncate">
                        <span className="text-text-muted">{pre.length > 40 ? '…' + pre.slice(-40) : pre}</span>
                        <span className="text-void px-0.5 rounded-sm" style={{ background: '#00C8FF' }}>{mid}</span>
                        <span className="text-text-muted">{post}</span>
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </motion.div>
  )
}
