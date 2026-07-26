import React from 'react'
import ReactDOM from 'react-dom/client'
import './lib/monacoSetup' // bundle Monaco locally — must run before any editor mounts
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// Lets the UI render in a plain browser for fast design iteration. No-ops in
// the desktop app, and the whole module is dropped from production builds.
if (import.meta.env.DEV) {
  const { installDevTauriShim } = await import('./lib/devTauriShim')
  installDevTauriShim()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
