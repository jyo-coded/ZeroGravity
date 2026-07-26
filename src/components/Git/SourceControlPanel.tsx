import { useCallback, useEffect, useState } from 'react'
import { Check, Plus, Minus, RotateCcw, RefreshCw, GitBranch, History, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import {
  gitStatusFull, gitStage, gitUnstage, gitDiscard, gitCommit, gitLog, gitBranches, gitCheckout,
  describeCode, codeBadge,
  type GitStatus, type Commit, type FileChange,
} from '../../lib/gitApi'
import { basename } from '../../lib/utils'

/**
 * Source control.
 *
 * Staged and unstaged changes are shown as two labelled groups, because "what
 * will be in my next commit" is the only question this panel exists to answer,
 * and a single flat list of files never answers it.
 */
export function SourceControlPanel() {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<Commit[]>([])
  const [branches, setBranches] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showBranches, setShowBranches] = useState(false)

  const openFile = useAppStore((s) => s.openFile)
  const addNotification = useAppStore((s) => s.addNotification)
  const changelogLength = useAppStore((s) => s.changelog.length)

  const refresh = useCallback(async () => {
    try {
      const s = await gitStatusFull()
      // Never trust the shape blindly: a null or partial payload should read as
      // "no repository", not crash the panel with a property access on null.
      const safe: GitStatus = s && typeof s.is_repo === 'boolean'
        ? { ...s, changes: Array.isArray(s.changes) ? s.changes : [] }
        : { is_repo: false, branch: '', upstream: null, ahead: 0, behind: 0, changes: [] }
      setStatus(safe)
      setError(null)
      if (safe.is_repo) {
        gitLog(30).then(setLog).catch(() => {})
        gitBranches().then((b) => setBranches(b.local)).catch(() => {})
      }
    } catch (e) {
      setError(String(e))
    }
  }, [])

  // Refresh on mount and whenever a change lands in the ledger — an edit through
  // the orchestrator is exactly when the working tree has moved.
  useEffect(() => { refresh() }, [refresh, changelogLength])

  const act = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      addNotification({ type: 'error', detail: failure, message: String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">Couldn&apos;t read git status</p>
        <p className="empty-state-hint">{error}</p>
        <button className="btn" onClick={refresh}>Try again</button>
      </div>
    )
  }

  if (!status) {
    return <div className="empty-state"><p className="empty-state-hint">Reading repository…</p></div>
  }

  if (!status.is_repo) {
    return (
      <div className="empty-state">
        <p className="empty-state-title">Not a git repository</p>
        <p className="empty-state-hint">
          This project folder isn&apos;t under version control. Run <code>git init</code> in it to
          track changes here.
        </p>
      </div>
    )
  }

  const staged = status.changes.filter((c) => c.staged && !c.conflicted)
  const unstaged = status.changes.filter((c) => !c.staged && !c.conflicted)
  const conflicts = status.changes.filter((c) => c.conflicted)
  const canCommit = message.trim().length > 0 && (staged.length > 0 || unstaged.length > 0) && !busy

  const commit = () =>
    act(async () => {
      const sha = await gitCommit(message.trim(), staged.length === 0)
      setMessage('')
      addNotification({ type: 'change', detail: 'Committed', message: `${sha} — ${message.trim()}` })
    }, 'Commit failed')

  return (
    <div className="git-panel">
      {/* Branch + sync state */}
      <div className="git-branchbar">
        <button className="btn btn-ghost" onClick={() => setShowBranches((v) => !v)} title="Switch branch">
          <GitBranch size={13} />
          <span className="truncate">{status.branch}</span>
          <ChevronDown size={12} />
        </button>
        {status.upstream && (status.ahead > 0 || status.behind > 0) && (
          <span className="git-sync" title={`${status.ahead} ahead, ${status.behind} behind ${status.upstream}`}>
            {status.ahead > 0 && <>↑{status.ahead}</>}
            {status.behind > 0 && <>↓{status.behind}</>}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-icon" onClick={refresh} title="Refresh" aria-label="Refresh">
          <RefreshCw size={13} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => setShowHistory((v) => !v)}
          aria-pressed={showHistory}
          title="History"
          aria-label="History"
        >
          <History size={13} />
        </button>
      </div>

      {showBranches && (
        <div className="git-branchlist">
          {branches.map((b) => (
            <button
              key={b}
              className="list-row"
              aria-selected={b === status.branch}
              onClick={() => { setShowBranches(false); act(() => gitCheckout(b), 'Could not switch branch') }}
            >
              <GitBranch size={12} />
              <span className="truncate">{b}</span>
            </button>
          ))}
          {branches.length === 0 && <p className="git-empty">No local branches.</p>}
        </div>
      )}

      {/* Commit box */}
      <div className="git-commitbox">
        <textarea
          className="input git-message"
          placeholder={staged.length ? `Commit ${staged.length} staged file${staged.length === 1 ? '' : 's'}…` : 'Message (commits all changes)'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) commit() }}
          rows={2}
        />
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={!canCommit} onClick={commit}>
          <Check size={13} />
          {staged.length > 0 ? `Commit ${staged.length} staged` : 'Commit all changes'}
        </button>
      </div>

      <div className="git-lists">
        {showHistory ? (
          <Group title="History" count={log.length}>
            {log.map((c) => (
              <div key={c.sha} className="git-commit">
                <span className="git-sha">{c.sha}</span>
                <span className="truncate" style={{ flex: 1 }} title={c.subject}>{c.subject}</span>
                <span className="git-meta">{c.author.split(' ')[0]} · {c.date}</span>
              </div>
            ))}
            {log.length === 0 && <p className="git-empty">No commits yet.</p>}
          </Group>
        ) : (
          <>
            {conflicts.length > 0 && (
              <Group title="Conflicts" count={conflicts.length} tone="danger">
                {conflicts.map((c) => (
                  <Row key={c.path} change={c} onOpen={() => openFile(c.path)} actions={[]} />
                ))}
              </Group>
            )}

            <Group
              title="Staged changes"
              count={staged.length}
              action={staged.length > 0 ? {
                icon: <Minus size={13} />,
                label: 'Unstage all',
                run: () => act(() => gitUnstage(staged.map((c) => c.path)), 'Unstage failed'),
              } : undefined}
            >
              {staged.map((c) => (
                <Row
                  key={c.path}
                  change={c}
                  onOpen={() => openFile(c.path)}
                  actions={[{
                    icon: <Minus size={13} />, label: 'Unstage',
                    run: () => act(() => gitUnstage([c.path]), 'Unstage failed'),
                  }]}
                />
              ))}
              {staged.length === 0 && <p className="git-empty">Nothing staged.</p>}
            </Group>

            <Group
              title="Changes"
              count={unstaged.length}
              action={unstaged.length > 0 ? {
                icon: <Plus size={13} />,
                label: 'Stage all',
                run: () => act(() => gitStage(unstaged.map((c) => c.path)), 'Stage failed'),
              } : undefined}
            >
              {unstaged.map((c) => (
                <Row
                  key={c.path}
                  change={c}
                  onOpen={() => openFile(c.path)}
                  actions={[
                    ...(c.untracked ? [] : [{
                      icon: <RotateCcw size={13} />, label: 'Discard changes',
                      run: () => {
                        // Destructive and unrecoverable through git — always confirm.
                        if (!window.confirm(`Discard all changes to ${basename(c.path)}? This cannot be undone.`)) return
                        act(() => gitDiscard([c.path]), 'Discard failed')
                      },
                    }]),
                    {
                      icon: <Plus size={13} />, label: 'Stage',
                      run: () => act(() => gitStage([c.path]), 'Stage failed'),
                    },
                  ]}
                />
              ))}
              {unstaged.length === 0 && <p className="git-empty">No changes.</p>}
            </Group>
          </>
        )}
      </div>
    </div>
  )
}

function Group({ title, count, tone, action, children }: {
  title: string
  count: number
  tone?: 'danger'
  action?: { icon: React.ReactNode; label: string; run: () => void }
  children: React.ReactNode
}) {
  return (
    <section className="git-group">
      <header className="git-group-head">
        <span style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{title}</span>
        <span className="git-count">{count}</span>
        <span style={{ flex: 1 }} />
        {action && (
          <button className="btn btn-ghost btn-icon" onClick={action.run} title={action.label} aria-label={action.label}>
            {action.icon}
          </button>
        )}
      </header>
      {children}
    </section>
  )
}

function Row({ change, onOpen, actions }: {
  change: FileChange
  onOpen: () => void
  actions: { icon: React.ReactNode; label: string; run: () => void }[]
}) {
  const badge = codeBadge(change)
  const tone = change.conflicted ? 'var(--danger)'
    : change.untracked ? 'var(--success)'
    : badge === 'D' ? 'var(--danger)'
    : 'var(--warning)'

  return (
    <div className="git-row">
      <button className="git-row-main" onClick={onOpen} title={`${change.path} — ${describeCode(change)}`}>
        <span className="truncate">{basename(change.path)}</span>
        <span className="git-path truncate">{change.path.split('/').slice(0, -1).join('/')}</span>
      </button>
      <span className="git-actions">
        {actions.map((a) => (
          <button key={a.label} className="btn btn-ghost btn-icon" onClick={a.run} title={a.label} aria-label={a.label}>
            {a.icon}
          </button>
        ))}
      </span>
      <span className="git-badge" style={{ color: tone }} title={describeCode(change)}>{badge}</span>
    </div>
  )
}
