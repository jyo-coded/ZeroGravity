import { AlertTriangle, XCircle, GitBranch, Users, Cpu, Check, CircleDot, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useEditorStatus } from '../../store/editorStatus'
import { useLayoutStore } from '../../store/layoutStore'

/**
 * The global status bar — one honest line of machine state.
 *
 * Every item is either a live fact or absent; nothing here is decorative. Items
 * that can be acted on are buttons and say what they do, so the bar doubles as
 * a fast route into the panels that own each fact.
 */
export function StatusBar() {
  const {
    problems, collaborators, modelConfig, isDirty, activeFile, changelog, setQuickOpen,
    gitBranch, gitModified, gitUntracked,
  } = useAppStore()
  const dirtyCount = gitModified.length + gitUntracked.length
  const { line, col, indent, encoding, eol, language } = useEditorStatus()
  const { setSidebarView, showBottom } = useLayoutStore()

  // Severity is numeric here (1 = error), matching ProblemsPanel's convention.
  const diagnostics = Object.values(problems).flat()
  const errors = diagnostics.filter((d) => d.severity === 1).length
  const warnings = diagnostics.length - errors
  const peers = collaborators.filter((c) => !c.is_self && c.status !== 'offline').length

  return (
    <footer className="statusbar" aria-label="Status">
      {/* Real branch or nothing — never a placeholder name. A status bar that
          invents "main" for a folder with no repo is worse than an empty slot. */}
      <button
        className="status-item"
        onClick={() => setSidebarView('git')}
        title={gitBranch ? `On branch ${gitBranch} — ${dirtyCount} changed file${dirtyCount === 1 ? '' : 's'}` : 'Not a git repository'}
      >
        <GitBranch size={13} />
        <span>{gitBranch ?? 'No repo'}</span>
        {gitBranch && dirtyCount > 0 && <span style={{ color: 'var(--warning)' }}>{dirtyCount}</span>}
      </button>

      <button
        className="status-item"
        onClick={() => showBottom('problems')}
        title={`${errors} errors, ${warnings} warnings`}
      >
        <XCircle size={13} style={{ color: errors ? 'var(--danger)' : undefined }} />
        <span>{errors}</span>
        <AlertTriangle size={13} style={{ color: warnings ? 'var(--warning)' : undefined, marginLeft: 4 }} />
        <span>{warnings}</span>
      </button>

      {/* Ledger count — the moat, surfaced permanently rather than buried. */}
      <button
        className="status-item"
        onClick={() => setSidebarView('ledger')}
        title="Verified change ledger"
      >
        <ShieldCheck size={13} style={{ color: 'var(--accent)' }} />
        <span>{changelog.length} signed</span>
      </button>

      {peers > 0 && (
        <button className="status-item" onClick={() => setSidebarView('team')} title="Connected peers">
          <Users size={13} />
          <span>{peers} peer{peers === 1 ? '' : 's'}</span>
        </button>
      )}

      <div style={{ flex: 1 }} />

      {activeFile && (
        <>
          <span className="status-item" title="Cursor position">
            Ln {line}, Col {col}
          </span>
          <span className="status-item">{indent}</span>
          <span className="status-item">{encoding}</span>
          <span className="status-item">{eol}</span>
          <span className="status-item" style={{ textTransform: 'capitalize' }}>{language}</span>
          <span
            className="status-item"
            style={{ color: isDirty ? 'var(--warning)' : 'var(--success)' }}
            title={isDirty ? 'Unsaved changes' : 'Saved'}
          >
            {isDirty ? <CircleDot size={13} /> : <Check size={13} />}
            <span>{isDirty ? 'Unsaved' : 'Saved'}</span>
          </span>
        </>
      )}

      <button className="status-item" onClick={() => setQuickOpen('commands')} title="Change model">
        <Cpu size={13} style={{ color: 'var(--ai)' }} />
        <span>{modelConfig?.label ?? 'No model'}</span>
      </button>
    </footer>
  )
}
