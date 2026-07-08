import { useState } from 'react'
import { motion } from 'framer-motion'
import { FolderOpen, Hash, Sparkles, Users, Loader2, RotateCcw } from 'lucide-react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'

export function OnboardingProject() {
  const { identity, initProject, joinProjectByCode, setView } = useAppStore()
  const [mode, setMode] = useState<'create' | 'join'>('create')
  const [projectName, setProjectName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [joinPassphrase, setJoinPassphrase] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const canCreate = projectName.trim() && passphrase.trim().length >= 8 && rootPath.trim()
  const canJoin = inviteCode.trim().length === 6 && rootPath.trim() && joinPassphrase.trim().length >= 8

  async function pickFolder() {
    setError('')
    // Primary: backend-driven native picker (most reliable). Fall back to the
    // frontend dialog plugin, and surface any failure instead of swallowing it.
    try {
      const selected = await api.pickFolder()
      if (selected) setRootPath(selected)
      return
    } catch (e) {
      try {
        const selected = await openDialog({ directory: true, multiple: false, title: 'Select project folder' })
        if (selected && typeof selected === 'string') setRootPath(selected)
        return
      } catch (e2) {
        setError(`Couldn't open the folder picker: ${e2 instanceof Error ? e2.message : String(e2)}. You can paste the full path manually.`)
      }
    }
  }

  async function proceed() {
    setError('')
    setLoading(true)
    try {
      if (mode === 'create') {
        await initProject(projectName.trim(), passphrase.trim(), rootPath.trim())
      } else {
        await joinProjectByCode(inviteCode.trim(), joinPassphrase.trim(), rootPath.trim())
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  async function resetAll() {
    localStorage.clear()
    // Reset store to initial state by reloading the page
    window.location.reload()
  }

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center">
      <div className="absolute inset-0 bg-gradient-radial pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="glass-elevated rounded-2xl border border-bg-border/60 w-full max-w-md mx-4 overflow-hidden"
      >
        <div className="px-8 pt-8 pb-5 border-b border-bg-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Users size={14} className="text-accent" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-bold text-text-primary">Set up your workspace</h2>
              <p className="text-xs text-text-muted">Create a new project or join a teammate's</p>
            </div>
            {identity && (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-bg-base text-xs font-bold shrink-0"
                style={{ backgroundColor: identity.avatar_color }}
                title={identity.username}
              >
                {identity.username.slice(0, 2).toUpperCase()}
              </div>
            )}
          </div>
        </div>

        <div className="px-8 py-6">
          <p className="text-xs text-text-muted uppercase tracking-widest mb-5 font-semibold">
            Step 3 of 3 — Project
          </p>

          {/* Mode toggle */}
          <div className="flex gap-1 p-1 bg-bg-elevated rounded-xl mb-6">
            {(['create', 'join'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError('') }}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                  mode === m
                    ? 'bg-accent text-bg-base shadow-glow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {m === 'create' ? '✦ Create' : '+ Join'}
              </button>
            ))}
          </div>

          {mode === 'create' ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-text-secondary mb-2 font-medium">Project name</label>
                <input
                  type="text"
                  placeholder="my-startup-backend"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="input-field"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-2 font-medium">
                  Encryption passphrase
                </label>
                <input
                  type="password"
                  placeholder="Min. 8 characters — share with teammates"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  className="input-field"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Encrypts the changelog — all teammates need this
                </p>
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-2 font-medium">
                  <FolderOpen size={11} />
                  Project root folder
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="C:\Projects\my-project"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    className="input-field font-mono text-xs flex-1"
                  />
                  <button
                    type="button"
                    onClick={pickFolder}
                    className="btn-ghost px-3 rounded-lg text-xs shrink-0"
                  >
                    Browse
                  </button>
                </div>
                <p className="text-xs text-text-muted mt-1.5">The folder 0G will watch and sync</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-2 font-medium">
                  <Hash size={11} />
                  Invite code
                </label>
                <input
                  type="text"
                  placeholder="ZG4X7K"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                  className="input-field font-mono tracking-widest text-center text-lg"
                  autoFocus
                />
                <p className="text-xs text-text-muted mt-1.5 text-center">
                  Get this code from your Team Lead
                </p>
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-2 font-medium">
                  Shared passphrase
                </label>
                <input
                  type="password"
                  placeholder="The passphrase your team set"
                  value={joinPassphrase}
                  onChange={(e) => setJoinPassphrase(e.target.value)}
                  className="input-field"
                />
              </div>
              <div>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-2 font-medium">
                  <FolderOpen size={11} />
                  Local folder
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="C:\Projects\shared-workspace"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    className="input-field font-mono text-xs flex-1"
                  />
                  <button type="button" onClick={pickFolder} className="btn-ghost px-3 rounded-lg text-xs shrink-0">
                    Browse
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 px-3 py-2 bg-error/10 border border-error/30 rounded-lg">
              <p className="text-xs text-error">{error}</p>
            </div>
          )}

          <div className="flex gap-3 mt-6">
            <button onClick={() => setView('onboarding_model')} className="btn-ghost flex-1 justify-center py-2.5 rounded-xl text-sm">
              Back
            </button>
            <button
              onClick={proceed}
              disabled={loading || (mode === 'create' ? !canCreate : !canJoin)}
              className="btn-primary flex-1 justify-center py-2.5 rounded-xl text-sm flex items-center gap-2 disabled:opacity-40"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {loading ? 'Setting up…' : mode === 'create' ? 'Create workspace' : 'Join workspace'}
            </button>
          </div>

          {/* Reset link */}
          <div className="mt-4 text-center">
            <button
              onClick={resetAll}
              className="text-xs text-text-muted/50 hover:text-text-muted flex items-center gap-1 mx-auto transition-colors"
            >
              <RotateCcw size={10} />
              Start over (clear saved data)
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
