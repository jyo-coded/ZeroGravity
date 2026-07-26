import { Check, X, FileWarning, ChevronRight, Sparkles } from 'lucide-react'
import { useChangeSet } from '../../store/changeSetStore'
import { diffStats } from '../../lib/diff'
import { basename } from '../../lib/utils'

/**
 * Review — the gate every AI edit passes through before it touches disk.
 *
 * Shows the proposed change per file, split into hunks the user can accept or
 * reject individually. Nothing here writes on its own: applying is always an
 * explicit action, and only accepted hunks are written.
 *
 * Colour follows the product's provenance encoding — violet marks AI authorship
 * throughout, so a reviewer always knows what a model wrote.
 */
export function DiffReview() {
  const { changeSet, activePath, setActivePath, toggleHunk, setAllHunks, applyFile, rejectFile, acceptAll, discard, applying } =
    useChangeSet()

  if (!changeSet) return null
  const active = changeSet.files.find((f) => f.path === activePath) ?? changeSet.files[0]

  const totalAccepted = changeSet.files.reduce((n, f) => n + f.accepted.size, 0)
  const actionable = changeSet.files.filter((f) => !f.error)

  return (
    <section className="review" aria-label="Review AI changes">
      <header className="review-head">
        <Sparkles size={14} style={{ color: 'var(--ai)' }} />
        <div className="min-w-0">
          <div className="review-title truncate" title={changeSet.intent}>{changeSet.intent}</div>
          <div className="review-sub">
            {changeSet.files.length} file{changeSet.files.length === 1 ? '' : 's'} · {totalAccepted} hunk
            {totalAccepted === 1 ? '' : 's'} selected · proposed by {changeSet.model}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={discard} disabled={applying}>Discard all</button>
        <button className="btn btn-ai" onClick={acceptAll} disabled={applying || actionable.length === 0}>
          <Check size={13} /> Apply {actionable.length > 1 ? 'all files' : ''}
        </button>
      </header>

      {/* File list — only shown when a change spans more than one file, so a
          single-file edit goes straight to the diff without a pointless index. */}
      {changeSet.files.length > 1 && (
        <nav className="review-files" aria-label="Changed files">
          {changeSet.files.map((f) => {
            const s = diffStats(f.hunks.filter((h) => f.accepted.has(h.id)))
            return (
              <button
                key={f.path}
                className="list-row"
                aria-selected={f.path === active?.path}
                onClick={() => setActivePath(f.path)}
                title={f.path}
              >
                {f.error ? <FileWarning size={12} style={{ color: 'var(--danger)' }} /> : <ChevronRight size={12} />}
                <span className="truncate">{basename(f.path)}</span>
                <span style={{ flex: 1 }} />
                {f.isNew && <span className="review-tag">new</span>}
                {!f.error && (
                  <span className="review-stat">
                    <span style={{ color: 'var(--diff-add-line)' }}>+{s.added}</span>
                    <span style={{ color: 'var(--diff-del-line)' }}>−{s.removed}</span>
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      )}

      {active && (
        <div className="review-body">
          <div className="review-filebar">
            <span className="review-path truncate" title={active.path}>{active.path}</span>
            <span style={{ flex: 1 }} />
            {!active.error && (
              <>
                <button className="btn btn-ghost" onClick={() => setAllHunks(active.path, false)}>None</button>
                <button className="btn btn-ghost" onClick={() => setAllHunks(active.path, true)}>All</button>
                <button className="btn btn-ghost" onClick={() => rejectFile(active.path)} disabled={applying}>
                  <X size={13} /> Reject
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => applyFile(active.path)}
                  disabled={applying || active.accepted.size === 0}
                >
                  <Check size={13} /> Apply file
                </button>
              </>
            )}
          </div>

          {active.error ? (
            <div className="empty-state">
              <p className="empty-state-title">This edit couldn&apos;t be applied</p>
              <p className="empty-state-hint">{active.error}</p>
              <button className="btn" onClick={() => rejectFile(active.path)}>Dismiss</button>
            </div>
          ) : active.hunks.length === 0 ? (
            <div className="empty-state">
              <p className="empty-state-hint">No changes to this file.</p>
            </div>
          ) : (
            <div className="review-hunks">
              {active.hunks.map((h, i) => {
                const on = active.accepted.has(h.id)
                return (
                  <div key={h.id} className="hunk" data-accepted={on}>
                    <div className="hunk-head">
                      <span className="hunk-label">
                        Change {i + 1} · line {h.oldStart}
                      </span>
                      <span className="review-stat">
                        <span style={{ color: 'var(--diff-add-line)' }}>+{h.added}</span>
                        <span style={{ color: 'var(--diff-del-line)' }}>−{h.removed}</span>
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        className="btn btn-ghost"
                        style={{ height: 22 }}
                        onClick={() => toggleHunk(active.path, h.id)}
                        aria-pressed={on}
                      >
                        {on ? <><Check size={12} /> Included</> : <><X size={12} /> Skipped</>}
                      </button>
                    </div>
                    <pre className="hunk-body">
                      {h.oldLines.map((l, k) => (
                        <div key={`d${k}`} className="hunk-line hunk-del"><span className="hunk-gutter">−</span>{l || ' '}</div>
                      ))}
                      {h.newLines.map((l, k) => (
                        <div key={`a${k}`} className="hunk-line hunk-add"><span className="hunk-gutter">+</span>{l || ' '}</div>
                      ))}
                    </pre>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
