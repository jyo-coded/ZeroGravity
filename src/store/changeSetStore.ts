import { create } from 'zustand'
import * as api from '../lib/api'
import { applyHunks, diffToHunks, diffStats, type Hunk } from '../lib/diff'
import { applyEditsToFile, groupByFile, type EditBlock } from '../lib/editProtocol'
import { useAppStore } from './appStore'

/**
 * changeSetStore — proposed AI edits awaiting human review.
 *
 * This is the product's central safety property: the agent never writes to disk.
 * It proposes a change set; a human accepts or rejects it hunk by hunk; only the
 * accepted hunks are written, and they go through the orchestrator so every
 * accepted change lands in the encrypted ledger attributed to the model that
 * proposed it.
 */

export interface FileChangeProposal {
  path: string
  /** File content before the change — the base every hunk is computed against. */
  original: string
  /** Content if every hunk were accepted. */
  proposed: string
  hunks: Hunk[]
  /** Hunk ids currently accepted. Starts as all of them. */
  accepted: Set<string>
  isNew: boolean
  /** Set when the edit could not be applied; the file is then non-actionable. */
  error?: string
}

export interface ChangeSet {
  id: string
  /** What the user asked for — shown as the review's heading. */
  intent: string
  /** Model label, recorded as the author of every accepted change. */
  model: string
  createdAt: string
  files: FileChangeProposal[]
}

interface ChangeSetState {
  changeSet: ChangeSet | null
  activePath: string | null
  applying: boolean

  proposeEdits: (edits: EditBlock[], intent: string, model: string) => Promise<void>
  setActivePath: (p: string | null) => void
  toggleHunk: (path: string, hunkId: string) => void
  setAllHunks: (path: string, accepted: boolean) => void
  acceptAll: () => Promise<void>
  applyFile: (path: string) => Promise<void>
  rejectFile: (path: string) => void
  discard: () => void
}

const nowId = () => `cs_${Date.now().toString(36)}`

export const useChangeSet = create<ChangeSetState>((set, get) => ({
  changeSet: null,
  activePath: null,
  applying: false,

  /**
   * Turn raw edit blocks into a reviewable change set.
   *
   * Reads each target's CURRENT content first — the file may have moved on since
   * the model saw it, and applying a stale edit silently is how AI tools corrupt
   * work. A block that no longer matches is surfaced as an error on that file.
   */
  proposeEdits: async (edits, intent, model) => {
    const grouped = groupByFile(edits)
    const files: FileChangeProposal[] = []

    for (const [path, blocks] of grouped) {
      let original = ''
      let isNew = false
      try {
        const raw = await api.openFile(path) as unknown as { content?: string; is_binary?: boolean }
        if (raw?.is_binary) {
          files.push({
            path, original: '', proposed: '', hunks: [], accepted: new Set(), isNew: false,
            error: 'binary file — cannot be edited as text',
          })
          continue
        }
        original = raw?.content ?? ''
      } catch {
        // Unreadable means it doesn't exist yet: a creation, not a failure.
        isNew = true
        original = ''
      }

      const result = applyEditsToFile(original, blocks)
      if (!result.ok) {
        files.push({ path, original, proposed: original, hunks: [], accepted: new Set(), isNew, error: result.reason })
        continue
      }

      const hunks = diffToHunks(original, result.content, path)
      files.push({
        path,
        original,
        proposed: result.content,
        hunks,
        accepted: new Set(hunks.map((h) => h.id)),
        isNew,
      })
    }

    set({
      changeSet: { id: nowId(), intent, model, createdAt: new Date().toISOString(), files },
      activePath: files.find((f) => !f.error)?.path ?? files[0]?.path ?? null,
    })
  },

  setActivePath: (p) => set({ activePath: p }),

  toggleHunk: (path, hunkId) =>
    set((s) => {
      if (!s.changeSet) return s
      return {
        changeSet: {
          ...s.changeSet,
          files: s.changeSet.files.map((f) => {
            if (f.path !== path) return f
            const accepted = new Set(f.accepted)
            if (accepted.has(hunkId)) accepted.delete(hunkId)
            else accepted.add(hunkId)
            return { ...f, accepted }
          }),
        },
      }
    }),

  setAllHunks: (path, acceptedAll) =>
    set((s) => {
      if (!s.changeSet) return s
      return {
        changeSet: {
          ...s.changeSet,
          files: s.changeSet.files.map((f) =>
            f.path === path
              ? { ...f, accepted: acceptedAll ? new Set(f.hunks.map((h) => h.id)) : new Set<string>() }
              : f,
          ),
        },
      }
    }),

  /** Write one file's accepted hunks through the orchestrator. */
  applyFile: async (path) => {
    const cs = get().changeSet
    const file = cs?.files.find((f) => f.path === path)
    if (!cs || !file || file.error) return

    set({ applying: true })
    const app = useAppStore.getState()
    try {
      const content = applyHunks(file.original, file.hunks, file.accepted)
      const chosen = file.hunks.filter((h) => file.accepted.has(h.id))
      const { added, removed } = diffStats(chosen)

      if (content === file.original) {
        // Everything was rejected — nothing to write, and writing anyway would
        // add a meaningless entry to the ledger.
        get().rejectFile(path)
        return
      }

      // Through the orchestrator, so the accepted change is recorded in the
      // encrypted ledger with the model named as its author.
      const entry = await api.commitWrite({
        file: path,
        content,
        summary: `${cs.model}: ${cs.intent}`.slice(0, 200),
        affected_lines: chosen.flatMap((h) =>
          Array.from({ length: Math.max(h.newLines.length, 1) }, (_, i) => h.oldStart + i),
        ),
        affected_functions: [],
        // Tag every file in this review with the change-set id, so the whole run
        // is one group in the ledger and can be undone in a single action.
        session_id: cs.id,
      })
      app.addChangelogEntry(entry)

      // Reflect the write in any open buffer so the editor never shows stale text.
      if (app.activeFile === path) await app.openFile(path)
      await app.loadFileTree()

      app.addNotification({
        type: 'change',
        detail: 'Applied',
        message: `${path} — ${added} added, ${removed} removed (${cs.model})`,
      })
      get().rejectFile(path) // remove from the pending set now it's on disk
    } catch (e) {
      app.addNotification({ type: 'error', detail: 'Could not apply', message: String(e) })
    } finally {
      set({ applying: false })
    }
  },

  acceptAll: async () => {
    const cs = get().changeSet
    if (!cs) return
    for (const f of cs.files.filter((x) => !x.error)) {
      await get().applyFile(f.path)
    }
  },

  rejectFile: (path) =>
    set((s) => {
      if (!s.changeSet) return s
      const files = s.changeSet.files.filter((f) => f.path !== path)
      if (files.length === 0) return { changeSet: null, activePath: null }
      return {
        changeSet: { ...s.changeSet, files },
        activePath: s.activePath === path ? files[0].path : s.activePath,
      }
    }),

  discard: () => set({ changeSet: null, activePath: null }),
}))
