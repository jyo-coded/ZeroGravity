/**
 * Cost and failure policy for the agent loop.
 *
 * These are pure decisions about whether to spend a request and how much context
 * to spend it on. They live outside the store so they can be tested directly —
 * they are the difference between an agent that works on a free-tier key and one
 * that 429s three steps in.
 */

/** Accumulated tool output kept in the prompt (~6k tokens).
 *
 *  The transcript is resent on EVERY step, so an unbounded one multiplies token
 *  cost by the step count. That — not request frequency — is what trips a
 *  provider's tokens-per-minute ceiling after a couple of file reads. */
export const TRANSCRIPT_BUDGET = 24_000

/**
 * Messages that plainly need no investigation.
 *
 * Running a multi-step tool loop for "hi" wastes requests, burns rate limit, and
 * makes the product look broken. Matching is deliberately narrow — an exact
 * phrase list, not a length heuristic — so a genuine short task like
 * "fix the parser" is never misread as small talk.
 */
export function isTrivial(task: string): boolean {
  const t = task.trim().toLowerCase().replace(/[!.?,]+$/, '')
  if (t.length <= 2) return true
  return /^(hi|hey|hello|yo|sup|thanks|thank you|ty|ok|okay|cool|nice|good morning|good afternoon|good evening|how are you|who are you|what can you do|help)$/.test(t)
}

/**
 * Keep the transcript under budget by dropping the OLDEST tool results.
 *
 * The first two entries (task, active file) are never dropped — losing them
 * would leave the model working without knowing what it was asked. The drop is
 * disclosed in the transcript so the model can re-read a file it still needs
 * rather than silently reasoning from a gap.
 */
export function trimTranscript(lines: string[]): string[] {
  let total = lines.reduce((n, l) => n + l.length, 0)
  if (total <= TRANSCRIPT_BUDGET) return lines

  const head = lines.slice(0, 2)
  const rest = lines.slice(2)
  total = head.reduce((n, l) => n + l.length, 0) + rest.reduce((n, l) => n + l.length, 0)

  let dropped = 0
  while (total > TRANSCRIPT_BUDGET && rest.length > 1) {
    total -= rest.shift()!.length
    dropped++
  }
  if (dropped > 0) {
    rest.unshift(
      `[NOTE] ${dropped} earlier tool result(s) were dropped to stay within the context budget. Re-read a file if you still need it.`,
    )
  }
  return [...head, ...rest]
}

/** True when a provider refused because of rate limiting rather than a real fault. */
export function isRateLimit(err: unknown): boolean {
  return /\b429\b|rate limit|too many requests|quota/i.test(String(err))
}

/** Turn a provider error into something the user can act on. */
export function friendlyError(e: unknown): string {
  const raw = String(e)
  if (isRateLimit(raw)) {
    return 'The model provider is rate limiting this key. Wait about a minute, or switch to another model from the picker in this panel’s header.'
  }
  if (/\b401\b|unauthor|invalid api key/i.test(raw)) {
    return 'The provider rejected the API key. Check it in the model picker.'
  }
  if (/network|fetch|connect|timeout|dns/i.test(raw)) {
    return 'Could not reach the model provider. Check your connection and try again.'
  }
  return raw
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
