import { useCallback, useEffect, useMemo, useState } from 'react'
import { SquareFunction, Box, ListTree, RefreshCw } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import type { GraphNode } from '../../lib/types'
import { basename } from '../../lib/utils'

/**
 * Outline — the symbols in the active file, from the tree-sitter graph.
 *
 * The graph the AI uses for structural context already knows every function and
 * type and its line; this surfaces that same data as navigation. It's sourced
 * from the graph rather than the language server on purpose: the graph is always
 * built (the scanner populates it on open), so the outline works even for a file
 * whose LSP hasn't started — or has no LSP at all.
 */
export function OutlinePanel() {
  const activeFile = useAppStore((s) => s.activeFile)
  const openFileAtLine = useAppStore((s) => s.openFileAtLine)
  const changelogLength = useAppStore((s) => s.changelog.length)

  const [symbols, setSymbols] = useState<GraphNode[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')

  const norm = (p: string) => p.replace(/\\/g, '/')

  const load = useCallback(async () => {
    if (!activeFile) { setSymbols([]); return }
    setLoading(true)
    try {
      const graph = await api.getGraphJson()
      const target = norm(activeFile)
      const mine = graph.nodes.filter(
        (n) => (n.kind === 'Function' || n.kind === 'TypeDef') && norm(n.path) === target,
      )
      // Line order is reading order — the only order that matches the file.
      mine.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      setSymbols(mine)
    } catch {
      setSymbols([])
    } finally {
      setLoading(false)
    }
  }, [activeFile])

  // Reload when the file changes, when a save lands (symbols may have moved), and
  // when the scanner signals the graph finished (re)building.
  useEffect(() => { load() }, [load, changelogLength])
  useEffect(() => {
    const un = listen('graph_ready', () => load())
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [load])

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return symbols
    return symbols.filter((s) => s.name.toLowerCase().includes(q))
  }, [symbols, filter])

  if (!activeFile) {
    return (
      <div className="empty-state">
        <ListTree size={22} style={{ color: 'var(--accent)', opacity: 0.7 }} />
        <p className="empty-state-title">No file open</p>
        <p className="empty-state-hint">Open a file to see its functions and types here.</p>
      </div>
    )
  }

  return (
    <div className="outline">
      <div className="outline-bar">
        <input
          className="input outline-filter"
          placeholder={`Filter symbols in ${basename(activeFile)}…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter symbols"
        />
        <button className="btn btn-ghost btn-icon" onClick={load} title="Rescan" aria-label="Rescan">
          <RefreshCw size={13} />
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-hint">
            {loading
              ? 'Reading symbols…'
              : symbols.length === 0
                ? 'No functions or types found in this file.'
                : 'No symbols match your filter.'}
          </p>
        </div>
      ) : (
        <ol className="outline-list">
          {shown.map((s) => {
            const isType = s.kind === 'TypeDef'
            return (
              <li key={s.id}>
                <button
                  className="list-row outline-row"
                  onClick={() => s.line != null && openFileAtLine(activeFile, s.line)}
                  title={`${isType ? s.type_kind ?? 'type' : 'function'} ${s.name}${s.line != null ? ` · line ${s.line}` : ''}`}
                >
                  {isType
                    ? <Box size={13} style={{ color: 'var(--ai)' }} />
                    : <SquareFunction size={13} style={{ color: 'var(--accent)' }} />}
                  <span className="outline-name truncate">{s.name}</span>
                  {isType && s.type_kind && <span className="outline-kind">{s.type_kind}</span>}
                  <span style={{ flex: 1 }} />
                  {s.line != null && <span className="outline-line">{s.line}</span>}
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
