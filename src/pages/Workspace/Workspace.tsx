/**
 * Workspace — the main workspace shell for Zero Gravity Canvas.
 *
 * Radical UI Concept Layout:
 *   TopBar (44px)
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  StarField + NebulaLayer (absolute, behind everything)        │
 *   │  ┌──────┐ ┌──────────────────────────┐ ┌───────────────────┐  │
 *   │  │ Left │ │  Canvas Area             │ │ Mission Control   │  │
 *   │  │ Dock │ │  ├ FloatingCards          │ │   (364px right)   │  │
 *   │  │ 52px │ │  ├ InlineConstellation   │ │   AI chat panel   │  │
 *   │  │      │ │  └ MissionLog (bottom)    │ │   beam border     │  │
 *   │  └──────┘ └──────────────────────────┘ └───────────────────┘  │
 *   └────────────────────────────────────────────────────────────────┘
 *   CockpitRing (floating bottom-center)
 *   NotificationStack (floating above cockpit)
 *
 * CRITICAL: All P2P/restore logic is preserved EXACTLY as-is.
 */

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '../../store/appStore'
import { listen } from '@tauri-apps/api/event'
import * as api from '../../lib/api'
import { handleCrdtMessage, removePeer, isBound } from '../../lib/crdt'

// Components
import { TopBar } from '../../components/TopBar/TopBar'
import { LeftDock } from '../../components/LeftDock/LeftDock'
import { StarField } from '../../components/Background/StarField'
import { NebulaLayer } from '../../components/Background/NebulaLayer'
import { FloatingCards } from '../../components/Canvas/FloatingCards'
import { FileExplorer } from '../../components/Explorer/FileExplorer'
import { SearchPanel } from '../../components/Search/SearchPanel'
import { ProblemsPanel } from '../../components/Problems/ProblemsPanel'
import { TeamPanel } from '../../components/Team/TeamPanel'
import { QuickOpen } from '../../components/QuickOpen/QuickOpen'
import { MissionControl } from '../../components/MissionControl/MissionControl'
import { MissionLog } from '../../components/MissionLog/MissionLog'
import { CockpitRing } from '../../components/CockpitRing/CockpitRing'
import { ConstellationBg } from '../../components/Constellation/ConstellationBg'
import { NotificationStack } from '../../components/Notifications/NotificationStack'

export function Workspace() {
  const {
    project, projectPassphrase, identity,
    loadFileTree, selfAsCollaborator, clearProject, setView,
    addCollaborator, removeCollaborator, applyRemoteEntry, updateCollaboratorStatus,
    syncBackendState, collaborators, changelog, explorerOpen, searchOpen, problemsOpen, teamPanelOpen,
    workspaceView: activeView, setWorkspaceView: setActiveView,
  } = useAppStore()

  const [restoring, setRestoring] = useState(false)

  // ─── CRITICAL: Project restore + P2P setup ───────────────────────────
  // This effect is preserved EXACTLY from the original Workspace.tsx.
  // It handles: backend state sync, project re-creation, file tree load,
  // network start, and P2P event listeners with proper cleanup.
  useEffect(() => {
    if (!project) return
    setRestoring(true)
    const listenerCleanups: Array<Promise<() => void>> = []

    if (!projectPassphrase) {
      clearProject()
      setView('onboarding_project')
      setRestoring(false)
      return
    }

    ;(async () => {
      try {
        await syncBackendState()
        await api.createProject({
          name: project.name,
          passphrase: projectPassphrase,
          root_path: project.root_path,
        })
        selfAsCollaborator()
        await loadFileTree()
        if (identity && project.invite_code) {
          try {
            // T0-8: passphrase derives the shared wire cipher (Argon2id)
            await api.startNetwork(project.invite_code, projectPassphrase, identity)
            listenerCleanups.push(listen('peer_joined', (e: any) => addCollaborator(e.payload)))
            listenerCleanups.push(listen('peer_left', (e: any) => removeCollaborator(e.payload.id)))
            listenerCleanups.push(listen('peer_entry', (e: any) => applyRemoteEntry(e.payload)))
            listenerCleanups.push(listen('peer_status', (e: any) => updateCollaboratorStatus(e.payload.id, e.payload.status, e.payload.current_file)))
          } catch (err) {
            console.error("Failed to start network:", err)
          }
        }
      } catch (err) {
        console.error("Failed to restore project:", err)
        clearProject()
        setView('onboarding_project')
      } finally {
        setRestoring(false)
      }
    })()

    return () => {
      listenerCleanups.forEach(p => p.then(fn => fn()).catch(() => {}))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── A1: External fs changes → refresh tree, reload clean buffers ────
  useEffect(() => {
    let treeTimer: ReturnType<typeof setTimeout> | undefined
    const un = listen('fs_external_change', (e: any) => {
      const p: string | undefined = e.payload?.path
      // Debounced tree refresh — the watcher fires in bursts
      clearTimeout(treeTimer)
      treeTimer = setTimeout(() => { useAppStore.getState().loadFileTree() }, 400)
      if (!p) return
      // T1: while a file is live-CRDT-bound, the shared doc is the truth —
      // a disk change (e.g. a peer's save) is already reflected via CRDT, so
      // reloading from disk would clobber the live buffer. Skip it.
      if (isBound(p)) return
      const s = useAppStore.getState()
      if (s.activeFile === p) {
        if (!s.isDirty) {
          // Clean active buffer → silent reload from disk
          s.openFile(p)
        } else {
          s.addNotification({
            type: 'conflict',
            detail: 'File changed on disk',
            message: `${p} was modified externally — save to overwrite, or close the tab to take the disk version`,
          })
        }
      } else {
        const buf = s.tabCache[p]
        if (buf && buf.content === buf.savedContent) {
          // Clean background buffer → drop cache so next activation reloads
          const cache = { ...s.tabCache }
          delete cache[p]
          useAppStore.setState({ tabCache: cache })
        }
      }
    })
    return () => { un.then((fn) => fn()).catch(() => {}); clearTimeout(treeTimer) }
  }, [])

  // ─── T1: route CRDT relay + clean up peer cursors on disconnect ───────
  useEffect(() => {
    const subs = [
      listen('crdt_message', (e: any) => handleCrdtMessage(e.payload)),
      listen('peer_left', (e: any) => removePeer(e.payload?.id)),
      listen('chat_message', (e: any) => {
        const p = e.payload ?? {}
        useAppStore.getState().addTeamChat({
          id: `chat_${p.ts}_${p.from ?? ''}`,
          username: p.username ?? 'Peer', color: p.color ?? '#00C8FF',
          text: p.text ?? '', ts: p.ts ?? new Date().toISOString(), isSelf: false,
        })
      }),
    ]
    return () => { subs.forEach((p) => p.then((fn) => fn()).catch(() => {})) }
  }, [])

  // ─── #5: persist today's usage counts across restarts ─────────────────
  useEffect(() => {
    const un = listen('ai_write_complete', async () => {
      try {
        const stats = await api.getUsageStats()
        const seeds = stats.map((s) => [s.provider, s.day_count, new Date().toISOString().slice(0, 10)])
        localStorage.setItem('0g_usage_days', JSON.stringify(seeds))
      } catch { /* stats unavailable — skip */ }
    })
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

  // ─── B4: Model rotation toasts ────────────────────────────────────────
  useEffect(() => {
    const un = listen('model_rotated', (e: any) => {
      const { from, to, reason } = e.payload ?? {}
      useAppStore.getState().addNotification({
        type: 'change',
        detail: 'Model Rotation',
        message: `Switched to backup model: ${to ?? '?'} — ${reason ?? 'error'} on ${from ?? '?'}`,
      })
    })
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

  // ─── A1: Keyboard — Ctrl+K S (save all), Ctrl+Shift+T (reopen tab) ───
  useEffect(() => {
    let chordArmed = false
    let chordTimer: ReturnType<typeof setTimeout> | undefined
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      // Arm the Ctrl+K chord WITHOUT preventDefault so Monaco's own
      // Ctrl+K chords keep working when the editor has focus.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && key === 'k') {
        chordArmed = true
        clearTimeout(chordTimer)
        chordTimer = setTimeout(() => { chordArmed = false }, 1500)
        return
      }
      if (chordArmed && key === 's') {
        e.preventDefault()
        chordArmed = false
        useAppStore.getState().saveAll()
        return
      }
      if (chordArmed && key !== 'control' && key !== 'meta') chordArmed = false
      // Non-chord alias for Save All
      if ((e.ctrlKey || e.metaKey) && e.altKey && key === 's') {
        e.preventDefault()
        useAppStore.getState().saveAll()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 't') {
        e.preventDefault()
        useAppStore.getState().reopenClosedTab()
        return
      }
      // A3/A5: navigation + palette shortcuts
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'p') {
        e.preventDefault()
        useAppStore.getState().setQuickOpen('commands')
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'p') {
        e.preventDefault() // also blocks the webview print dialog
        useAppStore.getState().setQuickOpen('files')
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 't') {
        e.preventDefault()
        useAppStore.getState().setQuickOpen('symbols')
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'f') {
        e.preventDefault()
        useAppStore.getState().toggleSearch()
      }
    }
    window.addEventListener('keydown', handler)
    return () => { window.removeEventListener('keydown', handler); clearTimeout(chordTimer) }
  }, [])

  // ─── Restoring splash screen ─────────────────────────────────────────
  if (restoring) {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen relative overflow-hidden"
        style={{ background: '#000408' }}
      >
        <StarField />
        <NebulaLayer />
        <div className="relative z-10 text-center">
          <div className="text-3xl font-display font-bold text-gradient mb-4">0G</div>
          <p className="text-xs text-text-muted animate-pulse font-mono">Restoring workspace...</p>
        </div>
      </div>
    )
  }

  // ─── Main workspace layout ───────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden" style={{ background: '#000408' }}>
      {/* Background layers */}
      <StarField />
      <NebulaLayer />

      {/* TopBar */}
      <TopBar />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Left Dock — 52px icon rail */}
        <LeftDock activeView={activeView} onViewChange={setActiveView} />

        {/* File Explorer — slide-in panel (A1) */}
        <AnimatePresence>
          {explorerOpen && <FileExplorer />}
        </AnimatePresence>

        {/* Search — slide-in panel (A3) */}
        <AnimatePresence>
          {searchOpen && <SearchPanel />}
        </AnimatePresence>

        {/* Problems — slide-in panel (A4) */}
        <AnimatePresence>
          {problemsOpen && <ProblemsPanel />}
        </AnimatePresence>

        {/* Team & chat — slide-in panel (T1) */}
        <AnimatePresence>
          {teamPanelOpen && <TeamPanel />}
        </AnimatePresence>

        {/* Center content — switches based on active view */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <AnimatePresence mode="wait">
            {activeView === 'canvas' && (
              <motion.div
                key="canvas"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col min-h-0"
              >
                {/* FloatingCards (includes inline constellation) */}
                <div className="flex-1 min-h-0 flex flex-col">
                  <FloatingCards />
                </div>

                {/* MissionLog at the bottom of canvas */}
                <MissionLog />
              </motion.div>
            )}

            {activeView === 'constellation' && (
              <motion.div
                key="constellation"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 relative"
              >
                <ConstellationBg interactive />
                <div className="absolute bottom-4 left-4 text-[10px] text-text-muted/30 font-mono pointer-events-none">
                  Click a file node to open it
                </div>
              </motion.div>
            )}

            {activeView === 'timeline' && (
              <motion.div
                key="timeline"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col p-6"
              >
                <h2 className="text-lg font-display font-bold text-text-primary mb-4">
                  Project Timeline
                </h2>
                <div className="flex-1 overflow-y-auto space-y-3">
                  {changelog.length === 0 ? (
                    <p className="text-text-muted text-sm">No changes recorded yet.</p>
                  ) : (
                    changelog.map((entry) => (
                      <div key={entry.id} className="glass-card p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-semibold text-text-primary">{entry.changed_by}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
                            style={{
                              border: '0.5px solid rgba(139,92,246,0.3)',
                              color: '#A78BFA',
                            }}
                          >
                            {entry.model}
                          </span>
                          <span className="ml-auto text-[10px] text-text-muted">{new Date(entry.timestamp).toLocaleString()}</span>
                        </div>
                        <p className="text-sm text-text-secondary">{entry.summary}</p>
                        <p className="text-[10px] font-mono text-text-muted mt-1">{entry.file}</p>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            )}

            {activeView === 'team' && (
              <motion.div
                key="team"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 flex flex-col p-6"
              >
                <h2 className="text-lg font-display font-bold text-text-primary mb-4">
                  Team Overview
                </h2>
                <div className="grid grid-cols-2 gap-4 max-w-2xl">
                  {collaborators.map((c) => (
                    <div key={c.id} className="glass-card p-4 flex items-center gap-4">
                      <div
                        className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                        style={{ backgroundColor: c.avatar_color, color: '#000408' }}
                      >
                        {c.username.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">
                          {c.username} {c.is_self && <span className="text-text-muted font-normal">(You)</span>}
                        </p>
                        <p className="text-xs text-text-muted capitalize">{c.status}</p>
                        {c.current_file && (
                          <p className="text-[10px] font-mono text-cyan mt-0.5">{c.current_file}</p>
                        )}
                      </div>
                      <div className="ml-auto">
                        <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded"
                          style={{
                            color: c.permission === 'owner' ? '#00C8FF' : c.permission === 'alter' ? '#00FF88' : '#64748B',
                            border: `0.5px solid ${c.permission === 'owner' ? 'rgba(0,200,255,0.3)' : c.permission === 'alter' ? 'rgba(0,255,136,0.3)' : 'rgba(100,116,139,0.3)'}`,
                          }}
                        >
                          {c.permission}
                        </span>
                      </div>
                    </div>
                  ))}
                  {collaborators.length === 0 && (
                    <p className="text-text-muted text-sm col-span-2">No team members yet.</p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* MissionControl — right panel (always visible in canvas/constellation view) */}
        {(activeView === 'canvas' || activeView === 'constellation') && (
          <MissionControl />
        )}
      </div>

      {/* Floating elements */}
      <CockpitRing />
      <NotificationStack />
      <QuickOpen />
      <AutoSaveDaemon />
    </div>
  )
}

/**
 * AutoSaveDaemon — renders nothing; saves the active buffer 1s after the
 * last keystroke when auto-save is set to 'idle'. Lives as a separate
 * component so its per-keystroke re-renders cost nothing.
 */
function AutoSaveDaemon() {
  const autoSave = useAppStore((s) => s.autoSave)
  const isDirty = useAppStore((s) => s.isDirty)
  const content = useAppStore((s) => s.activeFileContent)
  const isAiWriting = useAppStore((s) => s.isAiWriting)

  useEffect(() => {
    if (autoSave !== 'idle' || !isDirty || isAiWriting) return
    const t = setTimeout(() => { useAppStore.getState().saveFile() }, 1000)
    return () => clearTimeout(t)
  }, [content, isDirty, autoSave, isAiWriting])

  return null
}
