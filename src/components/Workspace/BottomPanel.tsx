import { lazy, Suspense, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useLayoutStore, type BottomTab } from '../../store/layoutStore'
import { useAppStore } from '../../store/appStore'
import { ProblemsPanel } from '../Problems/ProblemsPanel'
// xterm is ~250kB and only matters once a terminal is actually opened.
const TerminalPanel = lazy(() => import('../Terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel })))

const TABS: { id: BottomTab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
]

/**
 * The bottom dock — terminal, diagnostics, and output.
 *
 * Tabs here are text labels rather than icons: unlike the activity bar (whose
 * six fixed positions are learned by muscle memory), these change with context
 * and carry a live count, so they need to be readable at a glance.
 */
export function BottomPanel() {
  const { bottomTab, setBottomTab, bottomHeight, toggleBottom } = useLayoutStore()
  const problems = useAppStore((s) => s.problems)
  const problemCount = Object.values(problems).reduce((n, arr) => n + arr.length, 0)

  // Spawn a shell only once the user has actually opened the terminal, then keep
  // it alive for the session — no shell process for someone who never uses it.
  const [mountedTerminal, setMountedTerminal] = useState(false)
  useEffect(() => {
    if (bottomTab === 'terminal') setMountedTerminal(true)
  }, [bottomTab])

  return (
    <section className="panel panel-bottom" style={{ height: bottomHeight }} aria-label="Panel">
      <header className="panel-header" style={{ paddingRight: 'var(--space-3)' }}>
        <div role="tablist" aria-label="Panel views" className="flex items-center gap-1">
          {TABS.map((t) => {
            const selected = bottomTab === t.id
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={selected}
                className="btn btn-ghost"
                style={{
                  height: 24,
                  color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: selected ? 'var(--bg-hover)' : 'transparent',
                }}
                onClick={() => setBottomTab(t.id)}
              >
                {t.label}
                {t.id === 'problems' && problemCount > 0 && (
                  <span
                    style={{
                      minWidth: 16, height: 16, padding: '0 4px',
                      borderRadius: 'var(--radius-pill)',
                      background: 'var(--bg-raised)',
                      color: 'var(--text-secondary)',
                      fontSize: 'var(--text-2xs)',
                      lineHeight: '16px', textAlign: 'center',
                    }}
                  >
                    {problemCount}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-icon" onClick={toggleBottom} title="Close panel" aria-label="Close panel">
          <X size={14} />
        </button>
      </header>

      {/* The terminal stays mounted across tab switches: unmounting would kill
          scrollback and any running process the moment you glanced at Problems. */}
      <div className="panel-body" style={{ overflow: 'hidden' }}>
        <div style={{ display: bottomTab === 'terminal' ? 'block' : 'none', height: '100%' }}>
          {mountedTerminal && (
            <Suspense fallback={<div className="empty-state"><p className="empty-state-hint">Starting shell…</p></div>}>
              <TerminalPanel />
            </Suspense>
          )}
        </div>
        {bottomTab === 'problems' && <ProblemsPanel />}
        {bottomTab === 'output' && <OutputPending />}
      </div>
    </section>
  )
}

function OutputPending() {
  return (
    <div className="empty-state">
      <p className="empty-state-title">No output yet</p>
      <p className="empty-state-hint">
        Language server and task logs will stream here once a task has run.
      </p>
    </div>
  )
}
