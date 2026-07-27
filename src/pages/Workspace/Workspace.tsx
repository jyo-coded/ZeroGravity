/**
 * Workspace - owns restore, network, filesystem, keyboard, and autosave
 * lifecycles. The visual workspace is mounted by WorkspaceShell.
 */

import { useState, useEffect } from 'react'
import { useAppStore } from '../../store/appStore'
import { listen } from '@tauri-apps/api/event'
import * as api from '../../lib/api'
import { handleCrdtMessage, removePeer, isBound } from '../../lib/crdt'
import { parseEditBlocks } from '../../lib/editProtocol'
import { useChangeSet } from '../../store/changeSetStore'
import { useConflicts } from '../../store/conflictStore'
import { useDebug } from '../../store/debugStore'
import { onDapEvent } from '../../lib/dapApi'
import { StarField } from '../../components/Background/StarField'
import { NebulaLayer } from '../../components/Background/NebulaLayer'
import { WorkspaceShell } from '../../components/Workspace/WorkspaceShell'
import { ConflictResolver } from '../../components/Conflict/ConflictResolver'

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
            // A remote write that diverged from local work is held by the backend
            // and surfaced here — clean merges auto-apply, real collisions queue.
            listenerCleanups.push(listen('conflict://detected', (e: any) => useConflicts.getState().ingest(e.payload)))
            useConflicts.getState().hydrate()
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

  // Debug adapter events (stopped, output, terminated, …) drive the debug store.
  // Registered once for the workspace; the handler reads state via getState().
  useEffect(() => {
    const un = onDapEvent((e) => { useDebug.getState().ingest(e) })
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

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

  // AI streaming lifecycle — registered ONCE for the workspace, not per message.
  // These drive the live token stream and the terminal (complete/error) events.
  // Handlers read the store via getState() so they never capture stale closures.
  useEffect(() => {
    const subs = [
      listen<{ file: string; delta: string }>('ai_chunk', (e) => {
        const delta = e.payload?.delta ?? ''
        if (!delta) return
        useAppStore.setState((s) => ({ streamingText: (s.streamingText ?? '') + delta }))
      }),
      listen<{ file: string; output?: string; error?: string }>('ai_write_complete', (e) => {
        const output = e.payload?.output ?? ''
        useAppStore.setState({ isAiWriting: false, streamingText: null })

        // Split the reply into prose and structured edits. Edits become a
        // reviewable change set instead of code the user has to copy by hand —
        // this is the difference between an assistant and an editing engine.
        const { prose, edits } = parseEditBlocks(output)
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: prose || (edits.length ? `Proposed changes to ${edits.length} file(s).` : output),
        })

        if (edits.length > 0) {
          const s = useAppStore.getState()
          const intent = [...s.chatHistory].reverse().find((m) => m.role === 'user')?.content?.slice(0, 120)
            ?? 'AI edit'
          useChangeSet.getState()
            .proposeEdits(edits, intent, s.modelConfig?.label ?? 'AI')
            .catch((err) => s.addNotification({
              type: 'error', detail: 'Could not prepare review', message: String(err),
            }))
        }
      }),
      listen<{ error: string }>('ai_write_error', (e) => {
        // Keep whatever streamed before the failure as a visible partial.
        const partial = useAppStore.getState().streamingText
        useAppStore.setState({ isAiWriting: false, streamingText: null })
        useAppStore.getState().addChatMessage({
          role: 'assistant',
          content: partial
            ? `${partial}\n\n*(interrupted: ${e.payload?.error})*`
            : `**AI Error:** ${e.payload?.error}`,
        })
      }),
    ]
    return () => { subs.forEach((p) => p.then((fn) => fn()).catch(() => {})) }
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
    <WorkspaceShell>
      <AutoSaveDaemon />
      <ConflictResolver />
    </WorkspaceShell>
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