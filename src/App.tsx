import { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useAppStore } from './store/appStore'
import { OnboardingIdentity } from './pages/Onboarding/OnboardingIdentity'
import { OnboardingModel } from './pages/Onboarding/OnboardingModel'
import { OnboardingProject } from './pages/Onboarding/OnboardingProject'
import { Workspace } from './pages/Workspace/Workspace'
import * as api from './lib/api'

function App() {
  const { view, identity, modelConfig } = useAppStore()

  // On every app start: sync localStorage state into the Tauri Rust backend
  // This is needed because Rust AppState is in-memory only and
  // resets on every launch while localStorage persists across restarts.
  useEffect(() => {
    if (identity) {
      api.saveIdentity(identity).catch(() => {})
    }
    if (modelConfig) {
      api.configureModel(modelConfig).catch(() => {})
    }
  }, []) // run once on mount

  return (
    <AnimatePresence mode="wait">
      {view === 'onboarding_identity' && <OnboardingIdentity key="identity" />}
      {view === 'onboarding_model' && <OnboardingModel key="model" />}
      {view === 'onboarding_project' && <OnboardingProject key="project" />}
      {view === 'workspace' && <Workspace key="workspace" />}
    </AnimatePresence>
  )
}

export default App
