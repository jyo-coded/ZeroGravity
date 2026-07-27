import { Play, Pause, Square, ArrowRight, ArrowDown, ArrowUp, Bug, ChevronRight, ChevronDown } from 'lucide-react'
import { useDebug } from '../../store/debugStore'
import { useAppStore } from '../../store/appStore'
import type { Variable } from '../../lib/dapApi'
import { basename } from '../../lib/utils'

/**
 * Debug panel — Python debugging via debugpy.
 *
 * Everything a debug session needs in one place: step controls, the call stack
 * at the current stop, the variables in scope, and the program's console output.
 * Breakpoints live in the editor gutter; this panel drives execution across them.
 */
export function DebugPanel() {
  const {
    status, error, program, frames, selectedFrameId, scopes, varsByRef, expanded, output,
    start, stop, cont, stepOver, stepIn, stepOut, pause, selectFrame, toggleVar,
  } = useDebug()
  const activeFile = useAppStore((s) => s.activeFile)

  const running = status === 'running'
  const paused = status === 'paused'
  const active = running || paused || status === 'starting'

  return (
    <div className="debug">
      <div className="debug-toolbar">
        {!active ? (
          <button className="btn btn-primary" onClick={start} title="Start debugging the active Python file">
            <Play size={13} /> Debug
          </button>
        ) : (
          <>
            <button className="btn btn-ghost btn-icon" onClick={cont} disabled={!paused} title="Continue (F5)" aria-label="Continue">
              <Play size={14} style={{ color: paused ? 'var(--success)' : undefined }} />
            </button>
            <button className="btn btn-ghost btn-icon" onClick={stepOver} disabled={!paused} title="Step over" aria-label="Step over">
              <ArrowRight size={14} />
            </button>
            <button className="btn btn-ghost btn-icon" onClick={stepIn} disabled={!paused} title="Step into" aria-label="Step into">
              <ArrowDown size={14} />
            </button>
            <button className="btn btn-ghost btn-icon" onClick={stepOut} disabled={!paused} title="Step out" aria-label="Step out">
              <ArrowUp size={14} />
            </button>
            <button className="btn btn-ghost btn-icon" onClick={pause} disabled={!running} title="Pause" aria-label="Pause">
              <Pause size={14} />
            </button>
            <button className="btn btn-ghost btn-icon" onClick={stop} title="Stop" aria-label="Stop">
              <Square size={13} style={{ color: 'var(--danger)' }} />
            </button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span className="debug-status" data-state={status}>{statusLabel(status, program)}</span>
      </div>

      {error && (
        <div className="debug-error">
          <p className="debug-error-title">Debugger error</p>
          <p className="debug-error-msg">{error}</p>
          {/debugpy/i.test(error) && (
            <p className="debug-error-hint">Install it in the interpreter on your PATH: <code>pip install debugpy</code></p>
          )}
        </div>
      )}

      {status === 'idle' && !error && (
        <div className="empty-state">
          <Bug size={22} style={{ color: 'var(--accent)', opacity: 0.7 }} />
          <p className="empty-state-title">Debug Python</p>
          <p className="empty-state-hint">
            Open a <code>.py</code> file, click the gutter to set a breakpoint, then press Debug.
            {activeFile && !/\.py$/i.test(activeFile) && <><br />The active file isn&apos;t Python.</>}
          </p>
        </div>
      )}

      {(paused || running) && (
        <>
          <Section title="Call stack">
            {frames.length === 0 ? (
              <p className="debug-muted">{running ? 'Running…' : 'No frames.'}</p>
            ) : (
              <ol className="debug-frames">
                {frames.map((f) => (
                  <li key={f.id}>
                    <button
                      className="debug-frame"
                      aria-selected={f.id === selectedFrameId}
                      onClick={() => selectFrame(f.id)}
                      title={f.source?.path ?? f.name}
                    >
                      <span className="debug-frame-name truncate">{f.name}</span>
                      <span className="debug-frame-loc">
                        {f.source?.name ?? (f.source?.path ? basename(f.source.path) : '')}:{f.line}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Variables">
            {scopes.length === 0 ? (
              <p className="debug-muted">{paused ? 'No variables.' : 'Paused state only.'}</p>
            ) : (
              <div className="debug-vars">
                {scopes.map((sc) => (
                  <div key={sc.reference} className="debug-scope">
                    <div className="debug-scope-name">{sc.name}</div>
                    <VarList
                      vars={varsByRef[sc.reference] ?? []}
                      varsByRef={varsByRef}
                      expanded={expanded}
                      onToggle={toggleVar}
                      depth={0}
                    />
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {output.length > 0 && (
        <Section title="Console">
          <pre className="debug-console">
            {output.map((o, i) => (
              <span key={i} className={o.stderr ? 'debug-stderr' : undefined}>{o.text}</span>
            ))}
          </pre>
        </Section>
      )}
    </div>
  )
}

function VarList({ vars, varsByRef, expanded, onToggle, depth }: {
  vars: Variable[]
  varsByRef: Record<number, Variable[]>
  expanded: Record<number, boolean>
  onToggle: (ref: number) => void
  depth: number
}) {
  return (
    <ul className="debug-varlist">
      {vars.map((v, i) => {
        const expandable = v.variablesReference > 0
        const open = expandable && expanded[v.variablesReference]
        return (
          <li key={`${v.name}-${i}`}>
            <button
              className="debug-var"
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => expandable && onToggle(v.variablesReference)}
              disabled={!expandable}
            >
              {expandable
                ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
                : <span className="debug-var-nochev" />}
              <span className="debug-var-name">{v.name}</span>
              <span className="debug-var-val truncate" title={v.value}>{v.value}</span>
            </button>
            {open && (
              <VarList
                vars={varsByRef[v.variablesReference] ?? []}
                varsByRef={varsByRef}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="debug-section">
      <div className="debug-section-head">{title}</div>
      <div className="debug-section-body">{children}</div>
    </div>
  )
}

function statusLabel(status: string, program: string | null): string {
  switch (status) {
    case 'starting': return 'starting…'
    case 'running': return program ? `running ${basename(program)}` : 'running'
    case 'paused': return 'paused'
    case 'terminated': return 'finished'
    default: return 'idle'
  }
}
