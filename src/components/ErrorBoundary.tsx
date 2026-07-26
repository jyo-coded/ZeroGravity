import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

interface Props { children: ReactNode }

interface State {
  hasError: boolean
  error: Error | null
  stack: string | null
  copied: boolean
}

/**
 * The last line of defence.
 *
 * A crash screen's job is to stop the user losing work and give them a way
 * forward — not to apologise. Three things matter here:
 *
 *  1. It says what is safe. Unsaved buffers live in memory and are gone on
 *     reload, but everything already written is in the encrypted ledger. Saying
 *     so is the difference between "I lost my project" and "I lost a paragraph".
 *  2. Recovery is graduated: try again without a reload first, since most render
 *     errors come from one bad state and re-rendering clears them.
 *  3. The technical detail is available but folded away, and copyable in one
 *     click — a screenshot of a stack trace helps nobody file a useful report.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, stack: null, copied: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('0G crashed:', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? null })
  }

  private retry = () => this.setState({ hasError: false, error: null, stack: null, copied: false })

  private copy = () => {
    const report = [
      `0G error: ${this.state.error?.message ?? 'unknown'}`,
      this.state.error?.stack ?? '',
      '--- component stack ---',
      this.state.stack ?? '',
    ].join('\n')
    navigator.clipboard.writeText(report)
      .then(() => this.setState({ copied: true }))
      .catch(() => { /* clipboard blocked — the details are still on screen */ })
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="crash">
        <div className="crash-card">
          <h1 className="crash-title">0G hit an error and stopped rendering</h1>
          <p className="crash-body">
            Anything you had already saved is safe — every write is recorded in this project&apos;s
            encrypted ledger. Unsaved edits in open tabs will be lost if you reload, so try
            continuing first.
          </p>

          <div className="crash-actions">
            <button className="btn btn-primary" onClick={this.retry}>Try to continue</button>
            <button className="btn" onClick={() => window.location.reload()}>Reload 0G</button>
            <button className="btn btn-ghost" onClick={this.copy}>
              {this.state.copied ? 'Copied' : 'Copy details'}
            </button>
          </div>

          <details className="crash-details">
            <summary>Technical details</summary>
            <pre>{this.state.error?.message}{'\n\n'}{this.state.error?.stack}</pre>
          </details>
        </div>
      </div>
    )
  }
}
