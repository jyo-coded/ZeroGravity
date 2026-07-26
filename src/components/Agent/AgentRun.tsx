import { useEffect, useRef } from 'react'
import {
  Search, FileText, FolderTree, Stethoscope, TerminalSquare, Sparkles,
  AlertTriangle, Check, Square, ShieldAlert,
} from 'lucide-react'
import { useAgent, type AgentStep } from '../../store/agentStore'

const ICONS: Record<string, React.ReactNode> = {
  read_file: <FileText size={13} />,
  list_dir: <FolderTree size={13} />,
  grep: <Search size={13} />,
  diagnostics: <Stethoscope size={13} />,
  run: <TerminalSquare size={13} />,
}

/**
 * The agent run log.
 *
 * Shows every step the agent took — which file it read, what it searched for,
 * what came back. This is the honesty surface: if the agent claims it checked
 * something, there is a line here proving it did, and if there is no line, it
 * didn't.
 */
export function AgentRun() {
  const { running, task, steps, model, cancel, pendingApproval, approve } = useAgent()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [steps.length])

  if (steps.length === 0 && !running) return null

  return (
    <div className="agent-run">
      <header className="agent-head">
        <Sparkles size={14} style={{ color: 'var(--ai)' }} />
        <div className="min-w-0">
          <div className="agent-task truncate" title={task}>{task}</div>
          <div className="agent-sub">
            {running ? 'Working…' : 'Finished'}{model ? ` · ${model}` : ''} · {steps.length} step{steps.length === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {running && (
          <button className="btn btn-ghost" onClick={cancel} title="Stop the agent">
            <Square size={12} fill="currentColor" /> Stop
          </button>
        )}
      </header>

      <ol className="agent-steps">
        {steps.map((s) => <Step key={s.id} step={s} />)}
        {running && (
          <li className="agent-step">
            <span className="agent-dot is-live" />
            <span className="agent-label" style={{ color: 'var(--text-muted)' }}>thinking…</span>
          </li>
        )}
        <div ref={endRef} />
      </ol>

      {/* Shell commands are the one thing the agent can't do unilaterally. */}
      {pendingApproval && (
        <div className="agent-approval" role="alertdialog" aria-label="Approve command">
          <div className="flex items-center gap-2">
            <ShieldAlert size={14} style={{ color: 'var(--warning)' }} />
            <span className="agent-approval-title">The agent wants to run a command</span>
          </div>
          <code className="agent-command">{pendingApproval.command}</code>
          <p className="agent-approval-note">
            This runs on your machine with your permissions. Only allow it if you recognise the command.
          </p>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => approve(false)}>Don&apos;t run</button>
            <button className="btn btn-primary" onClick={() => approve(true)}>
              <Check size={13} /> Run it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Step({ step }: { step: AgentStep }) {
  const tone =
    step.kind === 'error' ? 'var(--danger)'
    : step.kind === 'edits' ? 'var(--ai)'
    : step.kind === 'done' ? 'var(--success)'
    : 'var(--text-muted)'

  const icon =
    step.kind === 'error' ? <AlertTriangle size={13} />
    : step.kind === 'edits' ? <Sparkles size={13} />
    : step.kind === 'done' ? <Check size={13} />
    : ICONS[step.label.split(' ')[0]] ?? null

  return (
    <li className="agent-step">
      <span className="agent-dot" style={{ background: tone }} />
      <span className="agent-icon" style={{ color: tone }}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="agent-label truncate" title={step.label}>{step.label}</div>
        {step.detail && <div className="agent-detail">{step.detail}</div>}
      </div>
    </li>
  )
}
