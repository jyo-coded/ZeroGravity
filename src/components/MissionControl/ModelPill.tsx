/**
 * ModelPill — the Mission Control model dropdown (B6).
 *
 * Click the purple pill →
 *   ACTIVE   current primary model
 *   ROTATION ordered failover list: reorder (↑↓), promote to primary (▶ swaps
 *            the old primary into the vacated slot), remove (✕)
 *   ADD      quick add a backup: provider + model + key
 *   USAGE    per-provider request counts vs known free-tier caps
 */

import { useState, useEffect } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { GripVertical, X, Play, Plus, Activity } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import { invoke } from '@tauri-apps/api/core'
import type { ModelConfig, ModelProvider } from '../../lib/types'
import { PROVIDER_PRESETS, presetFor } from '../../lib/modelPresets'


export function ModelPill() {
  const { modelConfig, setModelConfig, rotationList, setRotationList } = useAppStore()
  const [open, setOpen] = useState(false)
  const [stats, setStats] = useState<api.UsageStat[]>([])

  // Add-backup form
  const [addProvider, setAddProvider] = useState<ModelProvider>('google')
  const [addModel, setAddModel] = useState(presetFor('google').models[0] ?? '')
  const [addKey, setAddKey] = useState('')

  // Connection test. Verifying a key here is the difference between finding a
  // bad key now and discovering it mid-demo when the rotation quietly falls
  // through to a backup.
  const [probe, setProbe] = useState<Record<string, string>>({})

  const testModel = async (cfg: ModelConfig) => {
    const id = `${cfg.provider}:${cfg.model_name}`
    setProbe((p) => ({ ...p, [id]: 'testing…' }))
    try {
      await invoke<string>('test_model', { config: cfg })
      setProbe((p) => ({ ...p, [id]: 'ok' }))
    } catch (e) {
      // Keep the provider's own words — "API key not valid" and "quota exceeded"
      // need completely different fixes.
      setProbe((p) => ({ ...p, [id]: String(e).slice(0, 140) }))
    }
  }

  useEffect(() => {
    if (!open) return
    api.getUsageStats().then(setStats).catch(() => setStats([]))
  }, [open])

  if (!modelConfig) return null

  const promote = (i: number) => {
    // Backup becomes primary; old primary takes its slot in the chain
    const next = [...rotationList]
    const promoted = next[i]
    next[i] = modelConfig
    setRotationList(next)
    setModelConfig(promoted)
  }

  const remove = (i: number) => {
    setRotationList(rotationList.filter((_, k) => k !== i))
  }

  const addBackup = () => {
    const model = addModel.trim()
    if (!model) return
    const cfg: ModelConfig = {
      provider: addProvider,
      model_name: model,
      api_key: addKey.trim() || undefined,
      // Vendors with a known endpoint carry it in the preset, so adding a
      // Cerebras or Ollama Cloud backup needs only a key.
      base_url: presetFor(addProvider).fixedBaseUrl,
      label: model,
    }
    setRotationList([...rotationList, cfg])
    setAddKey('')
  }

  return (
    <div className="relative">
      {/* Pill */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-3 py-1 rounded-full text-[12px] transition-all hover:brightness-125"
        style={{
          background: 'rgba(139,92,246,0.12)',
          border: '0.5px solid rgba(139,92,246,0.5)',
          color: '#A78BFA',
        }}
      >
        <span className="truncate max-w-[80px]">{modelConfig.label}</span>
        {rotationList.length > 0 && (
          <span className="text-[11px] opacity-70">+{rotationList.length}</span>
        )}
        <span style={{ fontSize: '11px', opacity: 0.6 }}>▾</span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Click-away layer */}
            <div className="fixed inset-0 z-[65]" onClick={() => setOpen(false)} />

            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.14 }}
              className="absolute right-0 top-full mt-2 w-72 glass-elevated rounded-xl overflow-hidden z-[70]"
              style={{
                border: '0.6px solid rgba(139,92,246,0.35)',
                boxShadow: '0 0 30px rgba(139,92,246,0.12), 0 16px 48px rgba(0,0,0,0.6)',
              }}
            >
              {/* Active */}
              <div className="px-3 py-2.5" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[11px] font-mono tracking-[0.2em] uppercase text-text-muted mb-1">Active</p>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-green" style={{ boxShadow: '0 0 5px rgba(0,255,136,0.5)' }} />
                  <span className="text-[12px] font-mono text-text-primary truncate">{modelConfig.label}</span>
                  <span className="text-[12px] font-mono text-purple-light ml-auto shrink-0">{modelConfig.provider}</span>
                  <button
                    onClick={() => testModel(modelConfig)}
                    className="p-0.5 text-text-muted hover:text-cyan shrink-0"
                    title="Send a one-token probe to check this key works"
                  >
                    <Activity size={11} />
                  </button>
                </div>
                <ProbeResult result={probe[`${modelConfig.provider}:${modelConfig.model_name}`]} />
              </div>

              {/* Rotation list */}
              <div className="px-3 py-2.5" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[11px] font-mono tracking-[0.2em] uppercase text-text-muted mb-1.5">
                  Rotation — auto-failover order
                </p>
                {rotationList.length === 0 && (
                  <p className="text-[12px] text-text-muted/60">
                    No backups — add one below and 429s stop hurting.
                  </p>
                )}
                <Reorder.Group axis="y" values={rotationList} onReorder={setRotationList} as="div">
                  {rotationList.map((m, i) => (
                    <Reorder.Item
                      key={`${m.provider}::${m.model_name}`}
                      value={m}
                      as="div"
                      className="flex items-center gap-1.5 py-1 group cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical size={10} className="text-text-muted/40 shrink-0" />
                      <span className="text-[12px] font-mono text-text-muted w-3 shrink-0">{i + 1}</span>
                      <span className="text-[12px] font-mono text-text-secondary truncate flex-1" title={m.model_name}>
                        {m.label}
                      </span>
                      <span className="text-[11px] font-mono text-text-muted shrink-0">{m.provider}</span>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button onClick={() => promote(i)} className="p-0.5 text-text-muted hover:text-green" title="Make primary (swaps with current)">
                          <Play size={10} />
                        </button>
                        <button onClick={() => testModel(m)} className="p-0.5 text-text-muted hover:text-cyan" title="Test this key">
                          <Activity size={10} />
                        </button>
                        <button onClick={() => remove(i)} className="p-0.5 text-text-muted hover:text-red" title="Remove">
                          <X size={10} />
                        </button>
                      </div>
                    </Reorder.Item>
                  ))}
                </Reorder.Group>
              </div>

              {/* Add backup */}
              <div className="px-3 py-2.5 space-y-1.5" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
                <p className="text-[11px] font-mono tracking-[0.2em] uppercase text-text-muted">Add backup</p>
                <div className="flex items-center gap-1.5">
                  <select
                    value={addProvider}
                    onChange={(e) => {
                      const p = e.target.value as ModelProvider
                      setAddProvider(p)
                      setAddModel(presetFor(p as ModelProvider).models[0] ?? '')
                    }}
                    className="text-[12px] font-mono py-1 px-1.5 rounded outline-none shrink-0"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.1)', color: '#94A3B8' }}
                  >
                    {/* Driven by the shared presets so a provider added there
                        is immediately available as a failover here too. */}
                    {PROVIDER_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>{p.value}</option>
                    ))}
                  </select>
                  <input
                    value={addModel}
                    onChange={(e) => setAddModel(e.target.value)}
                    placeholder="model id"
                    className="flex-1 min-w-0 text-[12px] font-mono py-1 px-1.5 rounded outline-none bg-transparent text-text-primary placeholder-text-dim"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  {addProvider !== 'ollama' && (
                    <input
                      type="password"
                      value={addKey}
                      onChange={(e) => setAddKey(e.target.value)}
                      placeholder={presetFor(addProvider).placeholder || 'api key'}
                      className="flex-1 min-w-0 text-[12px] font-mono py-1 px-1.5 rounded outline-none bg-transparent text-text-primary placeholder-text-dim"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.1)' }}
                    />
                  )}
                  <button
                    onClick={addBackup}
                    disabled={!addModel.trim()}
                    className="flex items-center gap-1 text-[12px] font-mono px-2 py-1 rounded-full disabled:opacity-30 shrink-0 ml-auto"
                    style={{ background: 'rgba(0,200,255,0.1)', border: '0.5px solid rgba(0,200,255,0.4)', color: '#00C8FF' }}
                  >
                    <Plus size={9} />
                    <span>Add</span>
                  </button>
                </div>
              </div>

              {/* Usage */}
              <div className="px-3 py-2.5">
                <p className="text-[11px] font-mono tracking-[0.2em] uppercase text-text-muted mb-1">Usage</p>
                {stats.length === 0 && (
                  <p className="text-[12px] text-text-muted/60">No requests yet this session.</p>
                )}
                {stats.map((s) => (
                  <div key={s.provider} className="flex items-center gap-2 py-0.5 text-[12px] font-mono">
                    <span className="text-text-secondary w-16 truncate">{s.provider}</span>
                    <span className="text-text-muted">
                      {s.minute_count}{s.minute_cap ? `/${s.minute_cap}` : ''} rpm
                    </span>
                    {s.day_cap && (
                      <span className="text-text-muted">{s.day_count}/{s.day_cap} today</span>
                    )}
                    {s.last_used && (
                      <span className="text-text-muted/50 ml-auto">
                        {new Date(s.last_used).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Outcome of a connection probe.
 *
 * Shows the provider's own error text rather than a generic "failed": an invalid
 * key, an unknown model name, and an exhausted quota look identical in a summary
 * and need completely different fixes.
 */
function ProbeResult({ result }: { result?: string }) {
  if (!result) return null
  const ok = result === 'ok'
  const testing = result === 'testing…'
  return (
    <p
      className="text-[11px] font-mono mt-1 break-words"
      style={{ color: testing ? 'var(--text-muted)' : ok ? 'var(--success)' : 'var(--danger)' }}
    >
      {testing ? 'testing…' : ok ? '✓ responding' : result}
    </p>
  )
}
