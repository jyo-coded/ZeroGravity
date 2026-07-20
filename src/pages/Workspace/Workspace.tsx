/**
 * Workspace - owns restore, network, filesystem, keyboard, and autosave
 * lifecycles. The visual workspace is mounted by OrbitalWorkspaceShell.
 */

import { useState, useEffect } from 'react'
import { useAppStore } from '../../store/appStore'
import { listen } from '@tauri-apps/api/event'
import * as api from '../../lib/api'
import { handleCrdtMessage, removePeer, isBound } from '../../lib/crdt'
import { StarField } from '../../components/Background/StarField'
import { NebulaLayer } from '../../components/Background/NebulaLayer'
import { OrbitalWorkspaceShell } from '../../components/Orbital/OrbitalWorkspaceShell'

export function Workspace() {
  const {
    project, projectPassphrase, identity,
    loadFileTree, selfAsCollaborator, clearProject, setView,
    addCollaborator, removeCollaborator, applyRemoteEntry, updateCollaboratorStatus,
    syncBackendState,
  } = useAppStore()

  const [restoring, setRestoring] = useState(false)

  // Project restore + P2P setup. This preserves the original backend flow.
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
            await api.startNetwork(project.invite_code, projectPassphrase, identity)
            listenerCleanups.push(listen('peer_joined', (e: any) => addCollaborator(e.payload)))
            listenerCleanups.push(listen('peer_left', (e: any) => removeCollaborator(e.payload.id)))
            listenerCleanups.push(listen('peer_entry', (e: any) => applyRemoteEntry(e.payload)))
            listenerCleanups.push(listen('peer_status', (e: any) => updateCollaboratorStatus(e.payload.id, e.payload.status, e.payload.current_file)))
          } catch (err) {
            console.error('Failed to start network:', err)
          }
        }
      } catch (err) {
        console.error('Failed to restore project:', err)
        clearProject()
        setView('onboarding_project')
      } finally {
        setRestoring(false)
      }
    })()

    return () => {
      listenerCleanups.forEach((p) => p.then((fn) => fn()).catch(() => {}))
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // External fs changes: refresh tree, reload clean buffers.
  useEffect(() => {
    let treeTimer: ReturnType<typeof setTimeout> | undefined
    const un = listen('fs_external_change', (e: any) => {
      const p: string | undefined = e.payload?.path
      clearTimeout(treeTimer)
      treeTimer = setTimeout(() => { useAppStore.getState().loadFileTree() }, 400)
      if (!p) return

      if (isBound(p)) return
      const s = useAppStore.getState()
      if (s.activeFile === p) {
        if (!s.isDirty) {
          s.openFile(p)
        } else {
          s.addNotification({
            type: 'conflict',
            detail: 'File changed on disk',
            message: `${p} was modified externally - save to overwrite, or close the tab to take the disk version`,
          })
        }
      } else {
        const buf = s.tabCache[p]
        if (buf && buf.content === buf.savedContent) {
          const cache = { ...s.tabCache }
          delete cache[p]
          useAppStore.setState({ tabCache: cache })
        }
      }
    })
    return () => { un.then((fn) => fn()).catch(() => {}); clearTimeout(treeTimer) }
  }, [])

  // Route CRDT relay + clean up peer cursors on disconnect.
  useEffect(() => {
    const subs = [
      listen('crdt_message', (e: any) => handleCrdtMessage(e.payload)),
      listen('peer_left', (e: any) => removePeer(e.payload?.id)),
      listen('chat_message', (e: any) => {
        const p = e.payload ?? {}
        useAppStore.getState().addTeamChat({
          id: `chat_${p.ts}_${p.from ?? ''}`,
          username: p.username ?? 'Peer',
          color: p.color ?? '#00C8FF',
          text: p.text ?? '',
          ts: p.ts ?? new Date().toISOString(),
          isSelf: false,
        })
      }),
    ]
    return () => { subs.forEach((p) => p.then((fn) => fn()).catch(() => {})) }
  }, [])

  // Persist today's usage counts across restarts.
  useEffect(() => {
    const un = listen('ai_write_complete', async () => {
      try {
        const stats = await api.getUsageStats()
        const seeds = stats.map((s) => [s.provider, s.day_count, new Date().toISOString().slice(0, 10)])
        localStorage.setItem('0g_usage_days', JSON.stringify(seeds))
      } catch { /* stats unavailable; skip */ }
    })
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

  // Model rotation toasts.
  useEffect(() => {
    const un = listen('model_rotated', (e: any) => {
      const { from, to, reason } = e.payload ?? {}
      useAppStore.getState().addNotification({
        type: 'change',
        detail: 'Model Rotation',
        message: `Switched to backup model: ${to ?? '?'} - ${reason ?? 'error'} on ${from ?? '?'}`,
      })
    })
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

  // Keyboard: Ctrl+K S (save all), Ctrl+Shift+T (reopen tab).
  useEffect(() => {
    let chordArmed = false
    let chordTimer: ReturnType<typeof setTimeout> | undefined
    const handler = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'p') {
        e.preventDefault()
        useAppStore.getState().setQuickOpen('commands')
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'p') {
        e.preventDefault()
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

  if (restoring) {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen relative overflow-hidden" style={{ background: '#000408' }}>
        <StarField />
        <NebulaLayer />
        <div className="relative z-10 text-center">
          <div className="text-3xl font-display font-bold text-gradient mb-4">0G</div>
          <p className="text-xs text-text-muted animate-pulse font-mono">Restoring workspace...</p>
        </div>
      </div>
    )
  }

  return (
    <OrbitalWorkspaceShell>
      <AutoSaveDaemon />
    </OrbitalWorkspaceShell>
  )
}

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