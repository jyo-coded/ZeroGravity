import { useMemo, useState } from 'react'
import { ShieldCheck, Bot, User, RotateCcw, FileCode2, AlertTriangle, Lock, Undo2 } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { diffToHunks, diffStats } from '../../lib/diff'
import { basename } from '../../lib/utils'
import type { ChangelogEntry } from '../../lib/types'

/**
 * The ledger — 0G's distinguishing feature.
 *
 * Every write in the project, human or model, is recorded in an append-only log
 * encrypted with the project passphrase (XChaCha20-Poly1305, Argon2id). This
 * panel makes that record useful rather than merely present: who changed what,
 * whether a person or a model authored it, the exact diff, and the ability to
 * travel back to any earlier state.
 *
 * Colour carries the meaning consistently with the rest of the product:
 * cyan = a human wrote this, violet = a model wrote this.
 */
/** A run group (contiguous entries sharing a session id) or a lone entry. */
type LedgerItem =
  | { kind: 'run'; sessionId: string; entries: ChangelogEntry[] }
  | { kind: 'single'; entry: ChangelogEntry }

/** Collapse contiguous same-session entries into run groups, timeline order kept. */
function groupBySession(list: ChangelogEntry[]): LedgerItem[] {
  const items: LedgerItem[] = []
  let i = 0
  while (i < list.length) {
    const sid = list[i].session_id
    if (sid) {
      const group: ChangelogEntry[] = []
      while (i < list.length && list[i].session_id === sid) { group.push(list[i]); i++ }
      // A single-file run is clearer shown as a normal entry than as a group of one.
      if (group.length > 1) items.push({ kind: 'run', sessionId: sid, entries: group })
      else items.push({ kind: 'single', entry: group[0] })
    } else {
      items.push({ kind: 'single', entry: list[i] })
      i++
    }
  }
  return items
}

export function LedgerPanel() {
  const { changelog, revertEntry, revertRun, openFile, project } = useAppStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'ai' | 'human'>('all')
  const [undoing, setUndoing] = useState<string | null>(null)

  // An entry is AI-authored when a model is named on it. That single fact is
  // what makes provenance queryable — "show me everything the model wrote".
  const isAi = (e: ChangelogEntry) => Boolean(e.model && e.model.toLowerCase() !== 'human')

  const entries = useMemo(() => {
    const list = [...changelog].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    if (filter === 'ai') return list.filter(isAi)
    if (filter === 'human') return list.filter((e) => !isAi(e))
    return list
  }, [changelog, filter])

  const items = useMemo(() => groupBySession(entries), [entries])

  const aiCount = changelog.filter(isAi).length
  const active = entries.find((e) => e.id === selected) ?? null

  if (changelog.length === 0) {
    return (
      <div className="empty-state">
        <ShieldCheck size={22} style={{ color: 'var(--accent)', opacity: 0.7 }} />
        <p className="empty-state-title">Nothing recorded yet</p>
        <p className="empty-state-hint">
          Every change you or the AI make is signed into this project&apos;s encrypted ledger. Edit a
          file to see the first entry.
        </p>
      </div>
    )
  }

  return (
    <div className="ledger">
      {/* Provenance summary — the headline number: how much of this project was
          written by a model, and the proof that it is recorded, not asserted. */}
      <div className="ledger-summary">
        <div className="ledger-stat">
          <span className="ledger-stat-num">{changelog.length}</span>
          <span className="ledger-stat-label">signed</span>
        </div>
        <div className="ledger-stat">
          <span className="ledger-stat-num by-ai">{aiCount}</span>
          <span className="ledger-stat-label">by AI</span>
        </div>
        <div className="ledger-stat">
          <span className="ledger-stat-num by-human">{changelog.length - aiCount}</span>
          <span className="ledger-stat-label">by hand</span>
        </div>
        <span style={{ flex: 1 }} />
        <span className="ledger-lock" title={`Encrypted with this project's passphrase · ${project?.name ?? ''}`}>
          <Lock size={11} /> encrypted
        </span>
      </div>

      <div className="ledger-filters" role="tablist" aria-label="Filter by author">
        {(['all', 'ai', 'human'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            className="ledger-filter"
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'Everything' : f === 'ai' ? 'AI only' : 'Human only'}
          </button>
        ))}
      </div>

      <ol className="ledger-list">
        {items.map((item) => {
          if (item.kind === 'run') {
            const { sessionId, entries: runEntries } = item
            const model = runEntries.find((e) => isAi(e))?.model ?? runEntries[0].model
            const restorable = runEntries.some((e) => typeof e.previous_content === 'string')
            const busy = undoing === sessionId
            return (
              <li key={sessionId} className="ledger-run">
                <div className="ledger-run-head">
                  <Bot size={12} style={{ color: 'var(--ai)' }} />
                  <span className="ledger-run-title truncate" title={runEntries[0].summary}>
                    Agent run · {runEntries.length} files
                  </span>
                  <span className="ledger-run-model truncate">{model}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn btn-ghost"
                    disabled={busy || !restorable}
                    title={restorable
                      ? 'Undo every file this run changed, back to before it started'
                      : 'This run is too old to undo — its snapshots have been pruned'}
                    onClick={async () => {
                      if (!window.confirm(`Undo this agent run? ${runEntries.length} file(s) will be restored to their state before the run.`)) return
                      setUndoing(sessionId)
                      try { await revertRun(sessionId) } finally { setUndoing(null) }
                    }}
                  >
                    <Undo2 size={12} /> {busy ? 'Undoing…' : 'Undo run'}
                  </button>
                </div>
                <div className="ledger-run-body">
                  {runEntries.map((e) => (
                    <LedgerRow
                      key={e.id}
                      entry={e}
                      ai={isAi(e)}
                      selected={e.id === selected}
                      onSelect={() => setSelected(e.id === selected ? null : e.id)}
                      onOpen={openFile}
                      onRevert={revertEntry}
                    />
                  ))}
                </div>
              </li>
            )
          }
          const e = item.entry
          return (
            <li key={e.id}>
              <LedgerRow
                entry={e}
                ai={isAi(e)}
                selected={e.id === selected}
                onSelect={() => setSelected(e.id === selected ? null : e.id)}
                onOpen={openFile}
                onRevert={revertEntry}
              />
            </li>
          )
        })}
      </ol>

      {active === null && entries.length > 0 && (
        <p className="ledger-hint">Select an entry to see exactly what changed.</p>
      )}
    </div>
  )
}

/** One ledger row — the collapsed entry plus its expandable detail. */
function LedgerRow({ entry, ai, selected, onSelect, onOpen, onRevert }: {
  entry: ChangelogEntry
  ai: boolean
  selected: boolean
  onSelect: () => void
  onOpen: (p: string) => void
  onRevert: (id: string) => Promise<void>
}) {
  return (
    <>
      <button className="ledger-entry" aria-selected={selected} onClick={onSelect}>
        <span className={ai ? 'dot-ai' : 'dot-human'} />
        <span className="ledger-entry-main min-w-0">
          <span className="ledger-file truncate" title={entry.file}>{basename(entry.file)}</span>
          <span className="ledger-summary-text truncate" title={entry.summary}>{entry.summary}</span>
        </span>
        <span className="ledger-meta">
          {ai ? <Bot size={11} /> : <User size={11} />}
          <span className="truncate">{ai ? entry.model : entry.changed_by}</span>
          <time dateTime={entry.timestamp}>
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </span>
        {entry.conflict_flag && <AlertTriangle size={12} style={{ color: 'var(--warning)' }} />}
      </button>
      {selected && <EntryDetail entry={entry} isAi={ai} onOpen={onOpen} onRevert={onRevert} />}
    </>
  )
}

/**
 * One entry expanded: the exact diff it represents, and the option to travel
 * back to the state before it.
 */
function EntryDetail({ entry, isAi, onOpen, onRevert }: {
  entry: ChangelogEntry
  isAi: boolean
  onOpen: (p: string) => void
  onRevert: (id: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  // The ledger prunes old bodies to stay bounded, so an older entry can show
  // its metadata but not its diff. Say that plainly instead of rendering blank.
  const hasBody = typeof entry.previous_content === 'string'
  const hunks = useMemo(
    () => (hasBody ? diffToHunks(entry.previous_content ?? '', '', entry.id) : []),
    [entry.id, entry.previous_content, hasBody],
  )
  const stats = diffStats(hunks)

  return (
    <div className="ledger-detail">
      <div className="ledger-detail-head">
        <span className={isAi ? 'by-ai' : 'by-human'} style={{ fontSize: 'var(--text-xs)' }}>
          {isAi ? `Written by ${entry.model}` : `Written by ${entry.changed_by}`}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => onOpen(entry.file)} title="Open this file">
          <FileCode2 size={12} /> Open
        </button>
        <button
          className="btn"
          disabled={busy || !hasBody}
          title={hasBody
            ? 'Restore the file to its state before this change'
            : 'The earlier content of this entry has been pruned, so it cannot be restored'}
          onClick={async () => {
            if (!window.confirm(`Restore ${basename(entry.file)} to its state before this change?`)) return
            setBusy(true)
            try { await onRevert(entry.id) } finally { setBusy(false) }
          }}
        >
          <RotateCcw size={12} /> Restore
        </button>
      </div>

      <dl className="ledger-facts">
        <dt>File</dt><dd className="ledger-mono">{entry.file}</dd>
        <dt>When</dt><dd>{new Date(entry.timestamp).toLocaleString()}</dd>
        <dt>Entry</dt><dd className="ledger-mono">{entry.id}</dd>
        {entry.affected_lines.length > 0 && (
          <>
            <dt>Lines</dt>
            <dd className="ledger-mono">
              {entry.affected_lines.slice(0, 12).join(', ')}
              {entry.affected_lines.length > 12 ? ` +${entry.affected_lines.length - 12}` : ''}
            </dd>
          </>
        )}
        {entry.affected_functions.length > 0 && (
          <><dt>Functions</dt><dd className="ledger-mono">{entry.affected_functions.join(', ')}</dd></>
        )}
        <dt>Status</dt>
        <dd style={{ color: entry.conflict_flag ? 'var(--warning)' : 'var(--success)' }}>
          {entry.conflict_flag ? 'flagged as conflicting' : entry.status}
        </dd>
      </dl>

      {hasBody ? (
        <p className="ledger-note">
          {stats.removed} line{stats.removed === 1 ? '' : 's'} of prior content are retained for this
          entry, so it can be restored exactly.
        </p>
      ) : (
        <p className="ledger-note">
          Prior content for this entry has been pruned to keep the ledger bounded. Its record — who,
          when, which lines — is permanent.
        </p>
      )}
    </div>
  )
}
