import type * as Monaco from 'monaco-editor'
import { invoke } from '@tauri-apps/api/core'
import { useSettings } from '../store/settingsStore'

/**
 * Inline (ghost-text) completion.
 *
 * The single most-felt AI feature in an editor, and the one most easily made
 * unusable: it fires on nearly every keystroke, so it must be debounced,
 * cancellable, cached, and silent on failure. A completion engine that lags or
 * throws is worse than none.
 *
 * Cost controls, in order of how much they save:
 *  1. Debounce — no request until typing pauses.
 *  2. Suppression — never ask mid-word, mid-comment, or on a trivial prefix.
 *  3. Cache — the same cursor context never asks twice.
 *  4. Cancellation — a superseded request is dropped before it costs anything.
 */

interface CompletionResponse { text: string; model: string }

const cache = new Map<string, string>()
const CACHE_MAX = 200

let inflight: AbortController | null = null
let debounceTimer: ReturnType<typeof setTimeout> | undefined

function remember(key: string, value: string) {
  if (cache.size >= CACHE_MAX) {
    // Simple FIFO eviction; recency isn't worth a heavier structure here.
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  cache.set(key, value)
}

/**
 * Should we even ask? Each rule here removes a class of request that is almost
 * never useful, which is what keeps this affordable on a rate-limited key.
 */
function shouldSuggest(prefix: string, suffix: string): boolean {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)

  // Mid-identifier: the LSP's own completion is better and instant.
  if (/[A-Za-z0-9_$]$/.test(line) && line.trim().length < 3) return false
  // Inside a line comment — the model would write prose, not code.
  if (/(^|\s)(\/\/|#)/.test(line)) return false
  // Nothing to go on yet.
  if (prefix.trim().length < 12) return false
  // Immediately before a non-trivial character: an insertion there is usually wrong.
  const nextChar = suffix.replace(/^[ \t]*/, '')[0]
  if (nextChar && !'\n)]},;'.includes(nextChar)) return false
  return true
}

let registered = false

/**
 * Register the provider once per Monaco instance. Registering per editor mount
 * would stack providers and fire N duplicate requests per keystroke.
 */
export function registerInlineCompletion(monaco: typeof Monaco) {
  if (registered) return
  registered = true

  monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
    async provideInlineCompletions(model, position, _ctx, token) {
      const settings = useSettings.getState()
      if (!settings.inlineCompletion) return { items: [] }

      const prefix = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      })
      const lastLine = model.getLineCount()
      const suffix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: lastLine,
        endColumn: model.getLineMaxColumn(lastLine),
      })

      if (!shouldSuggest(prefix, suffix)) return { items: [] }

      // Key on the immediate context rather than the whole file: the same local
      // situation should hit cache even in a file that changed elsewhere.
      const key = `${model.uri.toString()}|${prefix.slice(-400)}|${suffix.slice(0, 120)}`
      const cached = cache.get(key)
      if (cached !== undefined) {
        return cached ? { items: [{ insertText: cached, range: rangeAt(position) }] } : { items: [] }
      }

      // Debounce. Resolving empty on supersession is important: rejecting would
      // surface as an error in Monaco's provider pipeline.
      clearTimeout(debounceTimer)
      const waited = await new Promise<boolean>((resolve) => {
        debounceTimer = setTimeout(() => resolve(true), settings.inlineCompletionDelayMs)
        token.onCancellationRequested(() => resolve(false))
      })
      if (!waited || token.isCancellationRequested) return { items: [] }

      inflight?.abort()
      const controller = new AbortController()
      inflight = controller
      token.onCancellationRequested(() => controller.abort())

      try {
        const res = await invoke<CompletionResponse>('ai_complete', {
          prefix,
          suffix,
          language: model.getLanguageId(),
        })
        if (controller.signal.aborted || token.isCancellationRequested) return { items: [] }

        const text = (res?.text ?? '').replace(/^\n+/, '')
        remember(key, text)
        if (!text.trim()) return { items: [] }

        return { items: [{ insertText: text, range: rangeAt(position) }] }
      } catch {
        // Rate limits and offline models are normal here. Cache the miss so a
        // burst of keystrokes doesn't retry a failing provider on every one.
        remember(key, '')
        return { items: [] }
      } finally {
        if (inflight === controller) inflight = null
      }
    },

    freeInlineCompletions() { /* nothing retained per-result */ },
  })
}

function rangeAt(position: Monaco.Position): Monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  }
}

/** Clear cached suggestions — used when the model changes. */
export function clearCompletionCache() {
  cache.clear()
}
