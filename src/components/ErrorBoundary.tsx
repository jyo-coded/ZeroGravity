import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('0G ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0A0A0F] flex items-center justify-center">
          <div className="text-center max-w-md mx-4">
            <div className="text-4xl font-black text-gradient mb-4">0G</div>
            <h2 className="text-base font-semibold text-[#F1F5F9] mb-2">Something went wrong</h2>
            <p className="text-xs text-[#94A3B8] mb-4 font-mono break-all">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-[#38BDF8] text-[#0A0A0F] rounded-lg text-sm font-semibold hover:brightness-110 transition-all"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
