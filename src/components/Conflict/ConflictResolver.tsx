import { useMemo, useState } from 'react'
import { GitMerge, User, Users, Check } from 'lucide-react'
import { useConflicts } from '../../store/conflictStore'
import { merge3, resolveMerge, type Side } from '../../lib/merge3'
import { basename } from '../../lib/utils'

/**
 * Conflict resolver.
 *
 * Appears only when a teammate's saved change genuinely collides with yours —
 * clean merges are applied silently upstream and never reach here. For each
 * colliding region the user picks a side (or keeps both); the preview updates
 * live, and applying commits the reconciled file through the orchestrator so it
 * flows into the encrypted ledger and back out to every peer.
 *
 * Provenance colour holds: cyan is you, amber is the teammate. A reviewer always
 * knows whose lines they're keeping.
 */
export function ConflictResolver() {
  const current = useConflicts((s) => s.current)
  const resolve = useConflicts((s) => s.resolve)
  const [choices, setChoices] = useState<Record<number, Side>>({})
  const [applying, setApplying] = useState(false)

  // Recompute the merge whenever the active conflict changes. Keyed by id so the
  // choices reset cleanly when one conflict is resolved and the next appears.
  const merge = useMemo(
    () => (current ? merge3(current.base ?? '', current.ours, current.theirs) : null),
    [current],
  )

  if (!current || !merge) return null

  // Conflict blocks in document order — the index the choices map is keyed on.
  const conflictIndexes: number[] = []
  merge.blocks.forEach((b, i) => { if (b.kind === 'conflict') conflictIndexes.push(i) })

  const choiceList: Side[] = conflictIndexes.map((_, ci) => choices[ci] ?? 'ours')
  const resolved = resolveMerge(merge, choiceList, current.ours)
  const decided = conflictIndexes.filter((_, ci) => choices[ci] !== undefined).length
  const allDecided = decided === conflictIndexes.length

  const setChoice = (ci: number, side: Side) =>
    setChoices((c) => ({ ...c, [ci]: side }))

  const setAll = (side: Side) => {
    const next: Record<number, Side> = {}
    conflictIndexes.forEach((_, ci) => { next[ci] = side })
    setChoices(next)
  }

  const apply = async () => {
    setApplying(true)
    try {
      await resolve(
        current.id,
        current.file,
        resolved,
        `Resolved conflict with ${current.their_user} in ${current.file}`,
      )
      setChoices({})
    } finally {
      setApplying(false)
    }
  }

  let ci = -1 // running conflict-block index as we render blocks

  return (
    <div className="conflict-overlay" role="dialog" aria-modal="true" aria-label="Resolve merge conflict">
      <div className="conflict-modal">
        <header className="conflict-head">
          <GitMerge size={15} style={{ color: 'var(--warning)' }} />
          <div className="min-w-0">
            <div className="conflict-title truncate">Merge conflict · {basename(current.file)}</div>
            <div className="conflict-sub truncate" title={current.file}>
              <span className="conflict-who conflict-mine"><User size={11} /> You</span>
              <span className="conflict-vs">vs</span>
              <span className="conflict-who conflict-theirs"><Users size={11} /> {current.their_user}</span>
              <span className="conflict-dot">·</span>
              {conflictIndexes.length} region{conflictIndexes.length === 1 ? '' : 's'} · {decided} decided
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => setAll('ours')} disabled={applying}>Keep all mine</button>
          <button className="btn btn-ghost" onClick={() => setAll('theirs')} disabled={applying}>Take all theirs</button>
          <button className="btn btn-primary" onClick={apply} disabled={applying || !allDecided} title={allDecided ? 'Apply resolution' : 'Choose a side for every region first'}>
            <Check size={13} /> {applying ? 'Applying…' : 'Apply resolution'}
          </button>
        </header>

        <div className="conflict-body">
          {merge.blocks.map((block, i) => {
            if (block.kind === 'stable') {
              if (block.lines.length === 0) return null
              return (
                <pre key={i} className="conflict-stable">
                  {block.lines.map((l, k) => (
                    <div key={k} className="conflict-line"><span className="conflict-gutter"> </span>{l || ' '}</div>
                  ))}
                </pre>
              )
            }
            ci++
            const idx = ci
            const chosen = choices[idx]
            return (
              <div key={i} className="conflict-region" data-decided={chosen !== undefined}>
                <div className="conflict-region-head">
                  <span className="conflict-region-label">Conflict {idx + 1}</span>
                  <span style={{ flex: 1 }} />
                  <SideButton label="Mine" side="ours" active={chosen} onPick={() => setChoice(idx, 'ours')} tone="mine" />
                  <SideButton label="Theirs" side="theirs" active={chosen} onPick={() => setChoice(idx, 'theirs')} tone="theirs" />
                  <SideButton label="Both" side="both-ot" active={chosen} onPick={() => setChoice(idx, 'both-ot')} tone="both" />
                </div>
                <div className="conflict-sides">
                  <pre className="conflict-side conflict-mine" data-dim={chosen !== undefined && chosen !== 'ours' && chosen !== 'both-ot' && chosen !== 'both-to'}>
                    <div className="conflict-side-tag"><User size={10} /> You</div>
                    {block.ours.length === 0
                      ? <div className="conflict-line conflict-empty">(you removed these lines)</div>
                      : block.ours.map((l, k) => (
                        <div key={k} className="conflict-line"><span className="conflict-gutter">◆</span>{l || ' '}</div>
                      ))}
                  </pre>
                  <pre className="conflict-side conflict-theirs" data-dim={chosen !== undefined && chosen !== 'theirs' && chosen !== 'both-ot' && chosen !== 'both-to'}>
                    <div className="conflict-side-tag"><Users size={10} /> {current.their_user}</div>
                    {block.theirs.length === 0
                      ? <div className="conflict-line conflict-empty">({current.their_user} removed these lines)</div>
                      : block.theirs.map((l, k) => (
                        <div key={k} className="conflict-line"><span className="conflict-gutter">◆</span>{l || ' '}</div>
                      ))}
                  </pre>
                </div>
              </div>
            )
          })}
        </div>

        <footer className="conflict-foot">
          <span className="conflict-foot-hint">
            {allDecided
              ? 'Applying commits the reconciled file to the ledger and syncs it to everyone.'
              : `Pick a side for ${conflictIndexes.length - decided} more region${conflictIndexes.length - decided === 1 ? '' : 's'} to continue.`}
          </span>
        </footer>
      </div>
    </div>
  )
}

function SideButton({
  label, side, active, onPick, tone,
}: {
  label: string
  side: Side
  active: Side | undefined
  onPick: () => void
  tone: 'mine' | 'theirs' | 'both'
}) {
  const on = active === side || (tone === 'both' && (active === 'both-ot' || active === 'both-to'))
  return (
    <button
      className={`conflict-pick conflict-pick-${tone}`}
      aria-pressed={on}
      data-on={on}
      onClick={onPick}
    >
      {on && <Check size={11} />} {label}
    </button>
  )
}
