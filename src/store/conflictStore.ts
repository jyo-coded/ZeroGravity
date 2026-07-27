import { create } from 'zustand'
import * as api from '../lib/api'
import type { ConflictInfo } from '../lib/api'
import { merge3, autoMerged } from '../lib/merge3'
import { useAppStore } from './appStore'

/**
 * Conflict queue for P2P divergence.
 *
 * A remote write only lands here when the local copy has genuinely diverged from
 * what the peer edited. The moment one arrives we try a 3-way merge:
 *   • if it merges with no overlapping regions, we apply it silently — the user
 *     never sees a modal for changes that don't actually collide;
 *   • only real collisions are queued for the resolver.
 *
 * Nothing is written to disk by the backend while a conflict is outstanding, so
 * this store is the single place that decides what the reconciled file becomes.
 */

interface ConflictState {
  queue: ConflictInfo[]
  /** The conflict currently shown in the resolver, or null when the queue is empty. */
  current: ConflictInfo | null
  /** Ingest a conflict from the backend event (or a reload). Auto-merges when clean. */
  ingest: (info: ConflictInfo) => Promise<void>
  /** Repopulate from the backend — call on mount so a reload never strands a conflict. */
  hydrate: () => Promise<void>
  /** Commit a resolved file, drop the conflict, and refresh the buffer. */
  resolve: (id: string, file: string, content: string, summary: string) => Promise<void>
}

/** Write the reconciled content through the orchestrator and clear the conflict. */
async function commitResolution(file: string, content: string, summary: string) {
  await api.commitWrite({
    file,
    content,
    summary,
    affected_lines: [],
    affected_functions: [],
  })
  // The resolved content is now canonical on disk; pull it into the editor so the
  // open buffer matches, and refresh the tree/changelog decorations.
  const app = useAppStore.getState()
  app.loadFileTree()
  if (app.activeFile === file) app.openFile(file)
}

export const useConflicts = create<ConflictState>((set, get) => ({
  queue: [],
  current: null,

  ingest: async (info) => {
    // Skip a duplicate id already queued (re-delivery or a double event).
    if (get().queue.some((c) => c.id === info.id)) return

    const merged = autoMerged(merge3(info.base ?? '', info.ours, info.theirs), info.ours)
    if (merged !== null) {
      // Clean merge — apply without bothering the user, but say so: a silent
      // change to their file, however correct, should never be invisible.
      try {
        await commitResolution(
          info.file,
          merged,
          `Auto-merged ${info.their_user}'s changes to ${info.file}`,
        )
        await api.dismissConflict(info.id)
        useAppStore.getState().addNotification({
          type: 'change',
          detail: 'Auto-merged',
          message: `${info.their_user}'s changes to ${info.file} merged cleanly with yours`,
        })
      } catch (e) {
        // If the auto-apply fails, fall back to showing it in the resolver rather
        // than dropping the change on the floor.
        set((s) => ({ queue: [...s.queue, info], current: s.current ?? info }))
      }
      return
    }

    set((s) => {
      const queue = [...s.queue, info]
      return { queue, current: s.current ?? queue[0] }
    })
    useAppStore.getState().addNotification({
      type: 'conflict',
      detail: 'Merge conflict',
      message: `${info.their_user} edited ${info.file} where you did — resolve to continue`,
    })
  },

  hydrate: async () => {
    try {
      const pending = await api.listConflicts()
      for (const info of pending) await get().ingest(info)
    } catch {
      /* backend not ready / no project — nothing to hydrate */
    }
  },

  resolve: async (id, file, content, summary) => {
    await commitResolution(file, content, summary)
    await api.dismissConflict(id)
    set((s) => {
      const queue = s.queue.filter((c) => c.id !== id)
      return { queue, current: queue[0] ?? null }
    })
  },
}))
