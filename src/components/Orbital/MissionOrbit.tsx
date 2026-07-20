import { useEffect, useMemo, useState } from 'react'
import { motion, useMotionValue } from 'framer-motion'
import { Radio, Settings, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { MissionControl } from '../MissionControl/MissionControl'

export function MissionOrbit() {
  const {
    spherePos, setSpherePos, modelConfig, rotationList, setModelConfig,
    collaborators, setQuickOpen,
  } = useAppStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextScope, setContextScope] = useState('Project')

  // Sphere is the anchor for the whole assembly. Its Y must leave room for the
  // card stack ABOVE it (card 430 + 18 gap + titlebar clearance ≈ 500), and its
  // X must leave room for the card's 214px right overhang.
  const defaultPos = useMemo(() => ({
    x: Math.min(Math.max(window.innerWidth - 340, 260), window.innerWidth - 230),
    y: Math.max(500, window.innerHeight - 150),
  }), [])

  const x = useMotionValue(spherePos?.x ?? defaultPos.x)
  const y = useMotionValue(spherePos?.y ?? defaultPos.y)
  const onlineCount = collaborators.filter((c) => c.status !== 'offline').length
  const modelOptions = rotationList.length > 0
    ? rotationList
    : modelConfig
      ? [modelConfig]
      : []

  useEffect(() => {
    if (!spherePos) setSpherePos(defaultPos)
  }, [defaultPos, setSpherePos, spherePos])

  useEffect(() => {
    const onResize = () => {
      const next = {
        x: Math.min(Math.max(x.get(), 260), window.innerWidth - 230),
        y: Math.min(Math.max(y.get(), 500), window.innerHeight - 80),
      }
      x.set(next.x)
      y.set(next.y)
      setSpherePos(next)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setSpherePos, x, y])

  return (
    <motion.div
      className="absolute top-0 left-0 z-[35]"
      style={{ x, y }}
      drag
      dragMomentum={false}
      dragElastic={0.08}
      onDragEnd={() => {
        // Clamps keep the anchored card fully on-screen wherever the sphere lands
        const nx = Math.min(Math.max(x.get(), 260), window.innerWidth - 230)
        const ny = Math.min(Math.max(y.get(), 500), window.innerHeight - 80)
        x.set(nx)
        y.set(ny)
        setSpherePos({ x: nx, y: ny })
      }}
    >
      {/* Sphere 98→72px (−27%). Center axis = 36px. Every anchored child is
          centered on that axis by arithmetic, so sphere / beam / card share
          ONE vertical line:
            card  left = 36 − 200 = −164   (width 400 → center 36) ✓
            beam  left = 36 − 130 = −94    (width 260 → center 36) ✓
          Card bottom sits 16px above the sphere → short, direct beam. */}
      <div className="relative w-[72px] h-[72px] mission-projector">
        <div className="sphere-ring w-[190px] h-[50px] -left-[59px] top-[40px]" />
        <div className="sphere-ring w-[136px] h-[38px] -left-[32px] top-[46px]" />
        <button
          type="button"
          className="mission-sphere absolute inset-0 flex items-center justify-center"
          onClick={() => setSettingsOpen((v) => !v)}
          title="Mission settings"
        >
          <Radio size={24} className="text-[#c7d8ff]/85" strokeWidth={1.6} />
        </button>

        <div className="holo-particles" />
        {/* Short beam: from card bottom (−16) into the sphere top */}
        <div className="holo-beam left-[-94px] top-[-16px] w-[260px] h-[60px]" />

        {/* Card: 400×430, bottom edge 16px above the sphere → top = −(430+16) */}
        <div className="orbital-hologram absolute left-[-164px] top-[-446px] w-[400px] h-[430px] glasscard-surface overflow-hidden">
          <div className="flex items-center gap-2 h-9 px-3" style={{ borderBottom: '1px solid rgba(160,220,255,0.10)' }}>
            <Sparkles size={14} className="text-cyan" />
            <span className="text-[11px] font-mono text-text-primary">Mission Control</span>
          </div>
          <div className="h-[calc(100%-36px)] mission-hologram-body">
            <MissionControl />
          </div>
        </div>

        {settingsOpen && (
          /* Beside the sphere, clear of the card above it */
          <div className="absolute left-[88px] top-[-8px] w-[264px] glasscard-surface p-3 mission-settings-popover">
            <div className="flex items-center gap-2 mb-3">
              <Settings size={14} className="text-cyan" />
              <span className="text-[11px] font-mono text-text-primary">Mission Settings</span>
              <button
                className="ml-auto text-text-muted hover:text-text-primary"
                onClick={() => setSettingsOpen(false)}
                title="Close"
              >
                x
              </button>
            </div>

            <label className="block text-[9px] font-mono text-text-muted mb-1">Model</label>
            <select
              value={modelConfig?.label ?? ''}
              onChange={(e) => {
                const next = modelOptions.find((m) => m.label === e.target.value)
                if (next) setModelConfig(next)
              }}
              className="w-full rounded-md bg-white/5 border border-white/10 px-2 py-1.5 text-[10px] text-text-primary outline-none"
            >
              {modelOptions.length === 0 && <option value="">No model configured</option>}
              {modelOptions.map((m) => <option key={`${m.provider}:${m.model_name}`} value={m.label}>{m.label}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-2 my-3">
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
                <p className="text-[9px] text-text-muted">Active Sessions</p>
                <p className="text-sm font-mono text-cyan">{onlineCount}</p>
              </div>
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
                <p className="text-[9px] text-text-muted">Context</p>
                <select
                  value={contextScope}
                  onChange={(e) => setContextScope(e.target.value)}
                  className="mt-1 w-full bg-transparent text-[10px] text-text-primary outline-none"
                >
                  <option>Project</option>
                  <option>Active file</option>
                  <option>Selection</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              className="w-full flex items-center justify-center gap-2 rounded-md border border-cyan/30 bg-cyan/10 px-3 py-2 text-[10px] text-cyan hover:bg-cyan/15"
              onClick={() => setQuickOpen('commands')}
            >
              <SlidersHorizontal size={13} />
              Open Full Control Panel
            </button>
          </div>
        )}
      </div>
    </motion.div>
  )
}
