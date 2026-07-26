import * as api from './api'
import { useAppStore } from '../store/appStore'
import { ptySpawn, ptyWrite, onPtyOutput, onPtyExit, decodePtyChunk } from './terminalApi'

/**
 * The agent's tools.
 *
 * Deliberately small and read-biased. Every tool here either reads the project
 * or runs something the user explicitly approved — none of them write files.
 * Writing happens exactly once, at the end, through the reviewed change set, so
 * there is a single place a human can stop the agent from touching disk.
 */

export interface ToolCall { name: string; args: Record<string, unknown> }

export interface ToolResult {
  ok: boolean
  /** What gets fed back to the model. Kept terse — this is prompt budget. */
  observation: string
  /** Short human label for the run log. */
  label: string
}

/** Output caps. A tool that dumps a whole repo into the prompt ends the run. */
const MAX_FILE_CHARS = 12_000
const MAX_LIST = 200
const MAX_MATCHES = 60

const truncate = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n)}\n… [truncated, ${s.length - n} more characters]`

export const TOOL_CONTRACT = `
[TOOLS]
You can inspect the project before deciding what to change. To call a tool, emit
ONE fenced block and nothing else after it — stop and wait for the result:

\`\`\`tool
{"name": "read_file", "args": {"path": "src/main.ts"}}
\`\`\`

Available tools:
- read_file   {"path": string}                  — read a project file
- list_dir    {"path": string}                  — list a directory (use "" for the project root)
- grep        {"query": string}                 — search the project's text for a string
- diagnostics {}                                — current errors and warnings from the language server
- run         {"command": string}               — run a shell command (the user must approve it first)

Rules:
- One tool call per message. Never guess a file's contents — read it.
- When you have enough information, STOP calling tools and emit your edit blocks.
- If the task needs no code change, just answer in prose.
`.trim()

/** Parse a tool call from a model response, if it made one. */
export function parseToolCall(text: string): ToolCall | null {
  const m = /```tool\s*\n([\s\S]*?)```/.exec(text)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1].trim()) as ToolCall
    if (!parsed || typeof parsed.name !== 'string') return null
    return { name: parsed.name, args: parsed.args ?? {} }
  } catch {
    return null
  }
}

/**
 * Ask the user before running a shell command.
 *
 * The agent may read freely, but executing a command is the one action that can
 * do arbitrary damage, so it is gated on an explicit human yes every time —
 * never remembered, never inferred from a previous approval.
 */
export type ApprovalFn = (command: string) => Promise<boolean>

export async function runTool(
  call: ToolCall,
  approve: ApprovalFn,
): Promise<ToolResult> {
  const store = useAppStore.getState()

  try {
    switch (call.name) {
      case 'read_file': {
        const path = String(call.args.path ?? '')
        if (!path) return { ok: false, observation: 'read_file needs a "path".', label: 'read_file' }
        const raw = await api.openFile(path) as unknown as { content?: string; is_binary?: boolean }
        if (raw?.is_binary) {
          return { ok: false, observation: `${path} is a binary file.`, label: `read ${path}` }
        }
        const content = raw?.content ?? ''
        // Numbered so the model can cite lines and copy SEARCH text accurately.
        const numbered = content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n')
        return {
          ok: true,
          observation: `Contents of ${path}:\n${truncate(numbered, MAX_FILE_CHARS)}`,
          label: `read ${path}`,
        }
      }

      case 'list_dir': {
        const path = String(call.args.path ?? '')
        const tree = await api.getFileTree()
        const flat: string[] = []
        const walk = (nodes: unknown[]) => {
          for (const n of nodes as { path: string; is_dir: boolean; children?: unknown[] }[]) {
            flat.push(n.is_dir ? `${n.path}/` : n.path)
            if (n.children?.length) walk(n.children)
          }
        }
        walk(tree as unknown[])
        const scoped = path ? flat.filter((f) => f.startsWith(path)) : flat
        return {
          ok: true,
          observation: `Project files${path ? ` under ${path}` : ''} (${scoped.length}):\n${scoped.slice(0, MAX_LIST).join('\n')}`,
          label: `list ${path || 'project'}`,
        }
      }

      case 'grep': {
        const query = String(call.args.query ?? '')
        if (!query) return { ok: false, observation: 'grep needs a "query".', label: 'grep' }
        const results = await api.searchProject({ query }) as unknown as
          { file: string; line: number; text: string }[]
        if (!results?.length) {
          return { ok: true, observation: `No matches for "${query}".`, label: `grep "${query}"` }
        }
        const lines = results.slice(0, MAX_MATCHES)
          .map((r) => `${r.file}:${r.line}: ${r.text.trim()}`)
          .join('\n')
        return {
          ok: true,
          observation: `${results.length} match(es) for "${query}":\n${lines}`,
          label: `grep "${query}" — ${results.length}`,
        }
      }

      case 'diagnostics': {
        const all = Object.entries(store.problems).flatMap(([file, items]) =>
          (items as { severity: number; message: string; line?: number }[]).map(
            (d) => `${d.severity === 1 ? 'error' : 'warning'} ${file}:${d.line ?? '?'} — ${d.message}`,
          ),
        )
        return {
          ok: true,
          observation: all.length ? `Diagnostics (${all.length}):\n${all.slice(0, 80).join('\n')}` : 'No diagnostics reported.',
          label: `diagnostics — ${all.length}`,
        }
      }

      case 'run': {
        const command = String(call.args.command ?? '')
        if (!command) return { ok: false, observation: 'run needs a "command".', label: 'run' }
        const allowed = await approve(command)
        if (!allowed) {
          return { ok: false, observation: `The user declined to run: ${command}`, label: `declined: ${command}` }
        }
        const output = await runInPty(command, store.project?.root_path)
        return {
          ok: true,
          observation: `$ ${command}\n${truncate(output, 6000)}`,
          label: `ran ${command}`,
        }
      }

      default:
        return { ok: false, observation: `Unknown tool "${call.name}".`, label: call.name }
    }
  } catch (e) {
    return { ok: false, observation: `Tool failed: ${String(e)}`, label: `${call.name} failed` }
  }
}

/**
 * Run one command in a throwaway PTY and collect its output.
 *
 * A dedicated session per command keeps the agent out of the user's interactive
 * terminals, and the hard timeout means a command that waits for input can never
 * stall the whole run.
 */
function runInPty(command: string, cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    const id = `agent-${Date.now().toString(36)}`
    let out = ''
    let settled = false
    let unOut: (() => void) | undefined
    let unExit: (() => void) | undefined

    const finish = () => {
      if (settled) return
      settled = true
      unOut?.()
      unExit?.()
      clearTimeout(timer)
      resolve(out.trim() || '(no output)')
    }
    const timer = setTimeout(() => {
      out += '\n[timed out after 60s]'
      finish()
    }, 60_000)

    ;(async () => {
      unOut = await onPtyOutput((p) => {
        if (p.id === id) out += new TextDecoder().decode(decodePtyChunk(p.data))
      })
      unExit = await onPtyExit((p) => { if (p.id === id) finish() })
      try {
        await ptySpawn(id, 120, 30, cwd)
        // `exit` closes the shell when the command finishes, which fires pty://exit.
        await ptyWrite(id, `${command}\rexit\r`)
      } catch (e) {
        out += `\n[could not start a shell: ${String(e)}]`
        finish()
      }
    })()
  })
}
