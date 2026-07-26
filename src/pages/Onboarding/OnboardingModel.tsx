import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Key, Globe, Cpu, ChevronDown, Layers, Check } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import type { ModelConfig, ModelProvider } from '../../lib/types'
import {
  PROVIDER_PRESETS as PROVIDERS, presetFor, DEFAULT_PROVIDER, DEFAULT_MODEL,
  recommendedChain,
} from '../../lib/modelPresets'

export function OnboardingModel() {
  const { setModelConfig, setRotationList, setView } = useAppStore()
  // Gemini Flash is the first-run default: free, multimodal, and quota'd per day
  // rather than per minute — the per-minute ceiling is what broke agent runs.
  const [provider, setProvider] = useState<ModelProvider>(DEFAULT_PROVIDER)
  const [modelName, setModelName] = useState(DEFAULT_MODEL)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [ollamaModels, setOllamaModels] = useState<{ name: string; size?: number }[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')

  // ── Recommended stack ──────────────────────────────────────────────────
  // A failover chain rather than one model: quality first, then speed, then a
  // local model that cannot be rate limited. Only Gemini is required; the rest
  // are optional links the user can add now or later from the model pill.
  const [stackMode, setStackMode] = useState(true)
  const [geminiKey, setGeminiKey] = useState('')
  const [cerebrasKey, setCerebrasKey] = useState('')
  const [localModel, setLocalModel] = useState('')
  const [applying, setApplying] = useState(false)

  const stack = recommendedChain({
    gemini: geminiKey,
    cerebras: cerebrasKey,
    ollamaModel: localModel,
  })

  async function applyStack() {
    if (stack.length === 0) return
    setApplying(true)
    try {
      // First link is the primary; the rest become the ordered failover list,
      // which is exactly the shape rotation.rs already consumes.
      await setModelConfig(stack[0])
      await setRotationList(stack.slice(1))
      setView('onboarding_project')
    } finally {
      setApplying(false)
    }
  }

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

  const providerOpt = presetFor(provider)
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
      // Vendors with a known endpoint (Cerebras, Ollama Cloud) carry it in the
      // preset, so the user never has to know or type a base URL. A typed one
      // still wins, which keeps self-hosted and proxied setups working.
      base_url: baseUrl.trim() || providerOpt.fixedBaseUrl || undefined,
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

          {stackMode ? (
            <>
              {/* Recommended stack — a failover chain, not a single model. Only
                  the first key is required; the others make the chain resilient. */}
              <div className="rounded-xl border border-accent/25 bg-accent/[0.05] p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Layers size={14} className="text-accent" />
                  <span className="text-sm font-semibold text-text-primary">Recommended setup</span>
                </div>
                <p className="text-xs text-text-muted leading-relaxed">
                  0G falls back down this chain automatically, so one provider running out
                  never stops the editor. Add what you have — you can add the rest later.
                </p>

                <StackField
                  label="Gemini API key"
                  required
                  note="Free, multimodal, daily quota. The primary model."
                  linkLabel="Get a key"
                  href="https://aistudio.google.com/apikey"
                  value={geminiKey}
                  onChange={setGeminiKey}
                  placeholder="AIza..."
                  type="password"
                />
                <StackField
                  label="Cerebras API key"
                  note="Optional — fastest free tier, ~1M tokens/day. First fallback."
                  linkLabel="Get a key"
                  href="https://cloud.cerebras.ai"
                  value={cerebrasKey}
                  onChange={setCerebrasKey}
                  placeholder="csk-..."
                  type="password"
                />
                <StackField
                  label="Local Ollama model"
                  note="Optional — never rate limited, works offline. Final fallback."
                  value={localModel}
                  onChange={setLocalModel}
                  placeholder="qwen3-coder:30b"
                />

                {/* Show the chain being built, so the fallback order is obvious
                    before committing to it rather than a surprise later. */}
                {stack.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {stack.map((m, i) => (
                      <span key={m.label} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-text-muted text-xs">→</span>}
                        <span
                          className="text-xs px-2 py-0.5 rounded-full"
                          style={{
                            background: i === 0 ? 'rgba(56,189,248,0.14)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(150,190,255,0.18)',
                            color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)',
                          }}
                        >
                          {m.label}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={applyStack}
                disabled={stack.length === 0 || applying}
                className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Check size={14} />
                {applying
                  ? 'Setting up…'
                  : stack.length > 1
                    ? `Use this stack (${stack.length} models)`
                    : 'Use this stack'}
              </button>

              <button
                onClick={() => setStackMode(false)}
                className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Or configure a single model manually
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStackMode(true)}
                className="w-full text-xs text-accent hover:brightness-125 transition-all text-left"
              >
                ← Back to the recommended setup
              </button>

          {/* Provider */}
          <div>
            <label className="block text-xs text-text-secondary mb-2 font-medium">AI Provider</label>
            <div className="relative">
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as ModelProvider
                  setProvider(p)
                  const opt = presetFor(p)
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
              <p className="text-xs text-text-muted mt-1.5">
                {providerOpt.hint}
                {/* Where to actually get the key — the step that otherwise sends
                    the user searching mid-setup. */}
                {providerOpt.keyUrl && (
                  <>
                    {' '}
                    <a
                      href={providerOpt.keyUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ color: 'var(--accent)' }}
                    >
                      Get a key →
                    </a>
                  </>
                )}
              </p>
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
            </>
          )}

          {stackMode && (
            <button
              onClick={() => setView('onboarding_identity')}
              className="btn-ghost w-full justify-center py-2.5 rounded-xl text-sm"
            >
              Back
            </button>
          )}
        </div>
      </motion.div>
    </div>
  )
}

/**
 * One row of the recommended-stack form.
 *
 * Each field states what the key buys and where to get it, because the reason a
 * first-run setup stalls is almost never the typing — it is not knowing whether
 * a field is required or where the key comes from.
 */
function StackField({
  label, note, value, onChange, placeholder, type = 'text', required, href, linkLabel,
}: {
  label: string
  note: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: 'text' | 'password'
  required?: boolean
  href?: string
  linkLabel?: string
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        {required && <span className="text-xs text-accent">required</span>}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto text-xs"
            style={{ color: 'var(--accent)' }}
          >
            {linkLabel} →
          </a>
        )}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input-field font-mono text-xs"
        spellCheck={false}
      />
      <p className="text-xs text-text-muted mt-1">{note}</p>
    </div>
  )
}
