import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2, TerminalSquare } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { ptyKill } from '../../lib/terminalApi'
import { TerminalSession } from './TerminalSession'

interface Session {
  id: string
  title: string
  dead: boolean
}

let seq = 0
const nextId = () => `term-${Date.now().toString(36)}-${++seq}`

/**
 * The terminal panel — multiple concurrent shells with a session list.
 *
 * Sessions stay mounted while inactive so switching between them preserves
 * scrollback and any running process. The panel owns session lifetime: only an
 * explicit kill (or app exit) ends a shell.
 */
export function TerminalPanel() {
  const projectRoot = useAppStore((s) => s.project?.root_path)
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Guards against StrictMode's double-invoked effects spawning two shells.
  const bootstrapped = useRef(false)

  const create = useCallback(() => {
    const id = nextId()
    setSessions((prev) => [...prev, { id, title: `Shell ${prev.length + 1}`, dead: false }])
    setActiveId(id)
  }, [])

  // First shell opens automatically — an empty terminal panel with a button to
  // press is one pointless click on the thing users open constantly.
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    create()
  }, [create])

  const close = useCallback((id: string) => {
    ptyKill(id).catch(() => {})
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id)
      setActiveId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur))
      return next
    })
  }, [])

  const markDead = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, dead: true } : s)))
  }, [])

  return (
    <div className="terminal-panel">
      <div className="terminal-surface">
        {sessions.map((s) => (
          <TerminalSession
            key={s.id}
            id={s.id}
            cwd={projectRoot}
            active={s.id === activeId}
            onExit={() => markDead(s.id)}
          />
        ))}
        {sessions.length === 0 && (
          <div className="empty-state">
            <p className="empty-state-title">No terminal open</p>
            <button className="btn btn-primary" onClick={create}>New shell</button>
          </div>
        )}
      </div>

      {/* Session rail — a list rather than tabs, so long shell names stay legible
          and the active one is unambiguous even with several open. */}
      <div className="terminal-rail">
        <button className="btn btn-ghost btn-icon" onClick={create} title="New shell" aria-label="New shell">
          <Plus size={15} />
        </button>
        <div className="terminal-rail-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className="list-row"
              aria-selected={s.id === activeId}
              onClick={() => setActiveId(s.id)}
              title={s.dead ? `${s.title} (exited)` : s.title}
              style={{ height: 26, opacity: s.dead ? 0.5 : 1 }}
            >
              <TerminalSquare size={13} style={{ flexShrink: 0 }} />
              <span className="truncate">{s.title}</span>
              {s.dead && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>exited</span>}
              <span style={{ flex: 1 }} />
              <span
                role="button"
                tabIndex={0}
                className="tab-close"
                style={{ opacity: 1 }}
                onClick={(e) => { e.stopPropagation(); close(s.id) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); close(s.id) } }}
                aria-label={`Kill ${s.title}`}
                title="Kill shell"
              >
                <Trash2 size={12} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
