import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Key, Globe, Cpu, ChevronDown } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import type { ModelConfig, ModelProvider } from '../../lib/types'

interface ProviderOption {
  value: ModelProvider
  label: string
  models: string[]
  needsKey: boolean
  placeholder: string
  urlPlaceholder?: string
  hint?: string
}

const PROVIDERS: ProviderOption[] = [
  {
    value: 'groq',
    label: 'Groq (Recommended — free tier)',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-120b',
      'qwen/qwen3-32b',
    ],
    needsKey: true,
    placeholder: 'gsk_...',
    hint: 'Free API key at console.groq.com — no credit card. 70B-class model, instant responses.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter (free models)',
    models: [
      'openrouter/free',
      'deepseek/deepseek-chat-v3.1:free',
      'qwen/qwen3-coder:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    needsKey: true,
    placeholder: 'sk-or-...',
    hint: 'Free key at openrouter.ai — "openrouter/free" auto-picks an available free model.',
  },
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    needsKey: true,
    placeholder: 'sk-ant-...',
  },
  {
    value: 'openai',
    label: 'OpenAI (GPT)',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    needsKey: true,
    placeholder: 'sk-...',
  },
  {
    value: 'google',
    label: 'Google (Gemini)',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    needsKey: true,
    placeholder: 'AIza...',
  },
  {
    value: 'ollama',
    label: 'Ollama (Local — private)',
    models: [], // populated dynamically via detect_ollama
    needsKey: false,
    placeholder: '',
    urlPlaceholder: 'http://localhost:11434',
    hint: 'Best for privacy — everything runs on your machine.',
  },
  {
    value: 'custom',
    label: 'Custom Endpoint',
    models: [],
    needsKey: true,
    placeholder: 'sk-...',
    urlPlaceholder: 'https://your-api.com/v1',
  },
]

export function OnboardingModel() {
  const { setModelConfig, setView } = useAppStore()
  // B3: Groq llama-3.3-70b is the first-run default — zero cost, zero local
  // hardware, and (unlike the old 1.5B local default) it actually works.
  const [provider, setProvider] = useState<ModelProvider>('groq')
  const [modelName, setModelName] = useState('llama-3.3-70b-versatile')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size?: number }[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')

  // B2: When Ollama is selected, detect local models via the backend
  // (avoids webview CORS issues with the tauri:// origin)
  useEffect(() => {
    if (provider !== 'ollama') return
    setOllamaStatus('loading')
    api.detectOllama(baseUrl.trim() || undefined)
      .then((data) => {
        const models = (data?.models ?? []).map((m) => ({ name: m.name, size: m.size }))
        setOllamaModels(models)
        if (models.length > 0) setModelName(models[0].name)
        setOllamaStatus('ok')
      })
      .catch(() => {
        setOllamaModels([])
        setOllamaStatus('error')
      })
  }, [provider, baseUrl])

  const providerOpt = PROVIDERS.find((p) => p.value === provider)!
  const isOllama = provider === 'ollama'
  const isCustom = provider === 'custom'
  const effectiveModelName = isOllama ? modelName : isCustom ? customModel : modelName
  const canContinue =
    (isOllama ? effectiveModelName.trim().length > 0 : true) &&
    (isCustom ? customModel.trim().length > 0 : true) &&
    (!providerOpt.needsKey || apiKey.trim().length > 0)

  async function proceed() {
    const name = isCustom ? customModel : modelName
    const config: ModelConfig = {
      provider,
      model_name: name,
      api_key: apiKey || undefined,
      base_url: baseUrl || undefined,
      label: name,
    }
    await setModelConfig(config)
    setView('onboarding_project')
  }

  return (
    <div className="min-h-screen bg-bg-base flex items-center justify-center">
      <div className="absolute inset-0 bg-gradient-radial pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="glass-elevated rounded-2xl border border-bg-border/60 w-full max-w-md mx-4 overflow-hidden"
      >
        <div className="px-8 pt-8 pb-5 border-b border-bg-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center">
              <Cpu size={14} className="text-accent" />
            </div>
            <div>
              <h2 className="text-base font-bold text-text-primary">Configure your model</h2>
              <p className="text-xs text-text-muted">Bring Your Own Model — keys stay on your machine</p>
            </div>
          </div>
        </div>

        <div className="px-8 py-6 space-y-5">
          <p className="text-xs text-text-muted uppercase tracking-widest font-semibold">
            Step 2 of 3 — Model
          </p>

          {/* Provider */}
          <div>
            <label className="block text-xs text-text-secondary mb-2 font-medium">AI Provider</label>
            <div className="relative">
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as ModelProvider
                  setProvider(p)
                  const opt = PROVIDERS.find((x) => x.value === p)!
                  setModelName(opt.models[0] ?? '')
                  setApiKey('')
                  setBaseUrl('')
                }}
                className="input-field pr-8 appearance-none cursor-pointer"
              >
                {PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            </div>
            {providerOpt.hint && (
              <p className="text-xs text-text-muted mt-1.5">{providerOpt.hint}</p>
            )}
          </div>

          {/* Model selector — Ollama: live list or free-text */}
          {isOllama ? (
            <div>
              <label className="block text-xs text-text-secondary mb-2 font-medium">Model</label>
              {ollamaStatus === 'loading' && (
                <p className="text-xs text-text-muted animate-pulse">Connecting to Ollama…</p>
              )}
              {ollamaStatus === 'ok' && ollamaModels.length > 0 ? (
                <div className="relative">
                  <select
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="input-field pr-8 appearance-none cursor-pointer font-mono"
                  >
                    {ollamaModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}{m.size ? ` (${(m.size / 1e9).toFixed(1)} GB)` : ''}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                </div>
              ) : ollamaStatus === 'error' ? (
                <div className="space-y-1.5">
                  <input
                    type="text"
                    placeholder="qwen2.5-coder:1.5b (exact name from ollama list)"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="input-field font-mono"
                  />
                  <p className="text-xs text-warning">
                    Ollama not running — start it with <code className="font-mono">ollama serve</code>, or type a model name manually.
                  </p>
                </div>
              ) : (
                <input
                  type="text"
                  placeholder="qwen2.5-coder:1.5b"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="input-field font-mono"
                />
              )}
              {ollamaStatus === 'ok' && (
                <p className="text-xs text-success mt-1.5 flex items-center gap-1">
                  <span>●</span> {ollamaModels.length} model{ollamaModels.length !== 1 ? 's' : ''} found in Ollama
                </p>
              )}
            </div>
          ) : !isCustom && providerOpt.models.length > 0 ? (
            <div>
              <label className="block text-xs text-text-secondary mb-2 font-medium">Model</label>
              <div className="relative">
                <select
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="input-field pr-8 appearance-none cursor-pointer font-mono"
                >
                  {providerOpt.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                </div>
              </div>
            ) : null}

          {/* Custom model name */}
          {isCustom && (
            <div>
              <label className="block text-xs text-text-secondary mb-2 font-medium">Model Name</label>
              <input
                type="text"
                placeholder="gpt-4, my-model-v2, ..."
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                className="input-field font-mono"
              />
            </div>
          )}

          {/* API Key */}
          {!isOllama && (
            <div>
              <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-2 font-medium">
                <Key size={11} />
                API Key
              </label>
              <input
                type="password"
                placeholder={providerOpt.placeholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="input-field font-mono"
              />
              <p className="text-xs text-text-muted mt-1.5 flex items-center gap-1">
                <span className="text-success">●</span>
                Stored locally — never shared with teammates
              </p>
            </div>
          )}

          {/* Base URL */}
          {(isOllama || isCustom) && (
            <div>
              <label className="flex items-center gap-1.5 text-xs text-text-secondary mb-2 font-medium">
                <Globe size={11} />
                Endpoint URL
              </label>
              <input
                type="text"
                placeholder={providerOpt.urlPlaceholder}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="input-field font-mono"
              />
              {isOllama && (
                <p className="text-xs text-text-muted mt-1.5">
                  Zero cost — runs entirely on your machine
                </p>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button onClick={() => setView('onboarding_identity')} className="btn-ghost flex-1 justify-center py-2.5 rounded-xl text-sm">
              Back
            </button>
            <button
              onClick={proceed}
              disabled={!canContinue}
              className="btn-primary flex-1 justify-center py-2.5 rounded-xl text-sm disabled:opacity-40"
            >
              Continue
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
