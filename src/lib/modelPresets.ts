import type { ModelConfig, ModelProvider } from './types'

/**
 * Model presets — the ready-made stacks a user can pick without knowing which
 * base URL belongs to which vendor.
 *
 * Everything here routes through providers the backend already understands:
 * `google` for Gemini, `ollama` for a local daemon, and the OpenAI-compatible
 * fallback (any provider value with a `base_url`) for Cerebras and Ollama Cloud.
 * No new transport code exists for these — only configuration.
 */

export interface ProviderPreset {
  value: ModelProvider
  label: string
  models: string[]
  needsKey: boolean
  placeholder: string
  /** Pinned for OpenAI-compatible vendors so the user never types a base URL. */
  fixedBaseUrl?: string
  urlPlaceholder?: string
  hint?: string
  keyUrl?: string
}

/**
 * Ordered by what we actually recommend, not by vendor size.
 *
 * Gemini Flash leads because it is the only free option that is simultaneously
 * multimodal, fast, and quota'd per DAY rather than per minute — the per-minute
 * token ceiling is what makes a chatty agent loop fail on other free tiers.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'google',
    label: 'Google Gemini — recommended, free',
    // 'gemini-flash-latest' is an ALIAS that tracks whatever the current Flash
    // model is. Pinning a version (gemini-2.5-flash) is what broke: Google
    // retired the 2.5 series and pinned names stop working for new keys with no
    // warning. The alias survives those transitions; use "Refresh" in the model
    // picker to see exactly what a key can access today.
    models: ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-pro-latest'],
    needsKey: true,
    placeholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    hint: 'Free key at aistudio.google.com. Multimodal, ~1M-token context, and a daily quota instead of a per-minute one — the reason agent runs stop hitting 429.',
  },
  {
    value: 'cerebras',
    label: 'Cerebras — fastest free tier',
    models: ['llama-3.3-70b', 'qwen-3-32b', 'gpt-oss-120b'],
    needsKey: true,
    placeholder: 'csk-...',
    fixedBaseUrl: 'https://api.cerebras.ai/v1',
    keyUrl: 'https://cloud.cerebras.ai',
    hint: 'Roughly 1M tokens/day and by far the fastest responses. Text only — best as the failover behind Gemini.',
  },
  {
    value: 'ollama',
    label: 'Ollama — local, no limits, offline',
    models: [], // discovered from the running daemon
    needsKey: false,
    placeholder: '',
    urlPlaceholder: 'http://localhost:11434',
    hint: 'Runs entirely on your machine: no rate limits, no key, works offline. Pull qwen3-coder for the best local coding quality.',
  },
  {
    value: 'ollama-cloud',
    label: 'Ollama Cloud — hosted big models',
    models: ['kimi-k2', 'qwen3-coder:480b', 'deepseek-v3.1'],
    needsKey: true,
    placeholder: 'Ollama API key',
    fixedBaseUrl: 'https://ollama.com/v1',
    keyUrl: 'https://ollama.com/settings/keys',
    hint: 'Frontier-scale open models without local hardware. This is a paid subscription, not a free tier.',
  },
  {
    value: 'groq',
    label: 'Groq — fast, tight rate limits',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'qwen/qwen3-32b'],
    needsKey: true,
    placeholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Very fast, but the free tier is capped per MINUTE, so long agent runs can hit 429 mid-task.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter — many free models',
    models: ['openrouter/free', 'deepseek/deepseek-chat-v3.1:free', 'qwen/qwen3-coder:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    needsKey: true,
    placeholder: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    hint: '"openrouter/free" auto-picks whichever free model is available.',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Claude — paid, frontier',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    needsKey: true,
    placeholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Best coding quality available. Paid — bring your own key.',
  },
  {
    value: 'openai',
    label: 'OpenAI — paid',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    needsKey: true,
    placeholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    value: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    models: [],
    needsKey: true,
    placeholder: 'sk-...',
    urlPlaceholder: 'https://your-api.com/v1',
  },
]

export const DEFAULT_PROVIDER: ModelProvider = 'google'
export const DEFAULT_MODEL = 'gemini-flash-latest'

export const presetFor = (p: ModelProvider): ProviderPreset =>
  PROVIDER_PRESETS.find((x) => x.value === p) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]

/**
 * Build the recommended failover chain from whichever keys the user has.
 *
 * The order encodes the trade-off deliberately: quality and multimodality first
 * (Gemini), then raw speed and a large daily budget (Cerebras), then a local
 * model that can never be rate limited at all. Because the chain ends on-device,
 * the editor keeps working when every cloud quota is exhausted — which is the
 * whole point of a bring-your-own-model design.
 */
export function recommendedChain(keys: {
  gemini?: string
  cerebras?: string
  ollamaModel?: string
  ollamaUrl?: string
}): ModelConfig[] {
  const chain: ModelConfig[] = []

  if (keys.gemini?.trim()) {
    chain.push({
      provider: 'google',
      model_name: DEFAULT_MODEL,
      api_key: keys.gemini.trim(),
      label: 'Gemini Flash',
    })
  }
  if (keys.cerebras?.trim()) {
    chain.push({
      provider: 'cerebras',
      model_name: 'llama-3.3-70b',
      api_key: keys.cerebras.trim(),
      base_url: 'https://api.cerebras.ai/v1',
      label: 'Cerebras Llama 3.3 70B',
    })
  }
  if (keys.ollamaModel?.trim()) {
    chain.push({
      provider: 'ollama',
      model_name: keys.ollamaModel.trim(),
      base_url: keys.ollamaUrl?.trim() || 'http://localhost:11434',
      label: `${keys.ollamaModel.trim()} (local)`,
    })
  }
  return chain
}
