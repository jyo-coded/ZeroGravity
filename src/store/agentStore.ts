import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { parseToolCall, runTool, TOOL_CONTRACT, type ApprovalFn } from '../lib/agentTools'
import { parseEditBlocks, EDIT_PROTOCOL_PROMPT } from '../lib/editProtocol'
import { useChangeSet } from './changeSetStore'
import { useAppStore } from './appStore'

/**
 * agentStore — the tool-using loop.
 *
 * The agent alternates between thinking and calling one tool, accumulating
 * observations, until it has enough to propose edits. It never writes: the run
 * ends by handing a change set to review, which is the only path to disk.
 *
 * Two hard limits keep a confused model from running forever or bankrupting a
 * rate-limited key: a step cap, and a repeated-call detector.
 */

export type StepKind = 'thought' | 'tool' | 'result' | 'edits' | 'error' | 'done'

export interface AgentStep {
  id: string
  kind: StepKind
  label: string
  detail?: string
  at: string
}

const MAX_STEPS = 12

interface AgentState {
  running: boolean
  task: string
  steps: AgentStep[]
  model: string | null
  /** Set while a shell command is waiting on the user. */
  pendingApproval: { command: string; resolve: (ok: boolean) => void } | null

  start: (task: string) => Promise<void>
  cancel: () => void
  clear: () => void
  approve: (ok: boolean) => void
}

let cancelled = false
const stepId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export const useAgent = create<AgentState>((set, get) => {
  const push = (kind: StepKind, label: string, detail?: string) =>
    set((s) => ({
      steps: [...s.steps, { id: stepId(), kind, label, detail, at: new Date().toISOString() }],
    }))

  const approve: ApprovalFn = (command) =>
    new Promise<boolean>((resolve) => {
      set({ pendingApproval: { command, resolve } })
    })

  return {
    running: false,
    task: '',
    steps: [],
    model: null,
    pendingApproval: null,

    approve: (ok) => {
      const p = get().pendingApproval
      if (!p) return
      p.resolve(ok)
      set({ pendingApproval: null })
    },

    cancel: () => {
      cancelled = true
      // Release a waiting approval so the loop can unwind instead of hanging.
      get().pendingApproval?.resolve(false)
      set({ running: false, pendingApproval: null })
      push('done', 'Cancelled')
    },

    clear: () => set({ steps: [], task: '', model: null }),

    start: async (task) => {
      if (get().running) return
      cancelled = false
      set({ running: true, task, steps: [], model: null })

      const app = useAppStore.getState()
      const activeFile = app.activeFile
      const modelLabel = app.modelConfig?.label ?? 'AI'

      const system = [
        'You are a senior engineer working inside the 0G editor on the user\'s project.',
        'Investigate before you edit. Read the files you intend to change — never guess their contents.',
        TOOL_CONTRACT,
        EDIT_PROTOCOL_PROMPT,
      ].join('\n\n')

      // The transcript IS the context. Observations accumulate here rather than
      // re-enriching from the project each step, which keeps the window bounded.
      const transcript: string[] = [
        `[TASK]\n${task}`,
        activeFile ? `[ACTIVE FILE]\n${activeFile}` : '',
      ].filter(Boolean)

      const recentCalls: string[] = []

      try {
        for (let step = 0; step < MAX_STEPS; step++) {
          if (cancelled) return

          const prompt = `${system}\n\n${transcript.join('\n\n')}\n\n[YOUR TURN]`
          const res = await invoke<{ text: string; model: string }>('ai_raw', { prompt })
          if (cancelled) return

          const text = res?.text ?? ''
          set({ model: res?.model ?? modelLabel })

          const call = parseToolCall(text)

          if (!call) {
            // No tool call — the agent is answering or proposing edits.
            const { prose, edits } = parseEditBlocks(text)
            if (edits.length > 0) {
              push('edits', `Proposed changes to ${edits.length} file${edits.length === 1 ? '' : 's'}`, prose || undefined)
              await useChangeSet.getState().proposeEdits(edits, task.slice(0, 120), res?.model ?? modelLabel)
              push('done', 'Ready for review')
            } else {
              push('done', 'Answered', prose || text)
              useAppStore.getState().addChatMessage({ role: 'assistant', content: prose || text })
            }
            set({ running: false })
            return
          }

          // Loop guard: a model repeating the same call learned nothing from the
          // result, and will keep repeating it until the step cap.
          const sig = `${call.name}:${JSON.stringify(call.args)}`
          if (recentCalls.filter((c) => c === sig).length >= 2) {
            push('error', 'Stopped — the agent repeated the same lookup')
            transcript.push('[SYSTEM] You have already run that exact tool call twice. Use what you have and produce edits or an answer.')
            recentCalls.length = 0
            continue
          }
          recentCalls.push(sig)

          push('tool', call.name, JSON.stringify(call.args))
          const result = await runTool(call, approve)
          if (cancelled) return

          push('result', result.label, result.ok ? undefined : result.observation)
          transcript.push(`[TOOL] ${sig}`)
          transcript.push(`[RESULT]\n${result.observation}`)
        }

        push('error', `Stopped after ${MAX_STEPS} steps without finishing`)
        set({ running: false })
      } catch (e) {
        push('error', 'Run failed', String(e))
        set({ running: false })
      }
    },
  }
})
