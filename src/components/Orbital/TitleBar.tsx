/**
 * TitleBar — Orbital UI v2 custom window chrome (Phase 1).
 *
 * decorations:false window → we own the bar: traffic-light controls
 * (left, per the reference image), centered project title, translucent
 * background, and the live status pills (model / Live) on the right.
 * Window ops go through the real Tauri window API — not decorative dots.
 */

import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAppStore } from '../../store/appStore'
import { followPeer } from '../../lib/crdt'

export function TitleBar() {
  const { project, modelConfig, collaborators } = useAppStore()
  const onlinePeers = collaborators.filter((c) => c.status !== 'offline')
  const win = getCurrentWindow()

  return (
    <div className="orbital-titlebar relative z-[60] shrink-0" data-tauri-drag-region>
      {/* ─── Traffic lights (real window controls) ─────────────────────── */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          className="traffic-btn"
          style={{ background: '#ff5f57' }}
          onClick={() => win.close()}
          title="Close"
        />
        <button
          className="traffic-btn"
          style={{ background: '#febc2e' }}
          onClick={() => win.minimize()}
          title="Minimize"
        />
        <button
          className="traffic-btn"
          style={{ background: '#28c840' }}
          onClick={() => win.toggleMaximize()}
          title="Maximize"
        />
      </div>

      {/* ─── Centered title ────────────────────────────────────────────── */}
      <div
        className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-none"
        data-tauri-drag-region
      >
        <span className="text-[13px] font-mono font-bold text-gradient tracking-tight">0G</span>
        {project?.name && (
          <>
            <span className="text-text-muted/30 text-[12px]">·</span>
            <span className="text-[12px] text-text-secondary/80">{project.name}</span>
          </>
        )}
      </div>

      {/* ─── Right: peers / model / live ───────────────────────────────── */}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <div className="flex items-center -space-x-1.5 mr-1">
          {onlinePeers.slice(0, 4).map((peer) => (
            <button
              key={peer.id}
              onClick={() => { if (!peer.is_self) followPeer(peer.id) }}
              className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold border transition-transform hover:scale-110"
              style={{ backgroundColor: peer.avatar_color, borderColor: '#060a1a', color: '#000408' }}
              title={peer.is_self ? `${peer.username} (you)` : `Follow ${peer.username}`}
            >
              {peer.username.slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
        {modelConfig && (
          <div className="px-2.5 py-0.5 rounded-full text-[12px] font-mono truncate max-w-[130px]"
            style={{ background: 'rgba(139,92,246,0.14)', border: '0.5px solid rgba(139,92,246,0.45)', color: '#A78BFA' }}
          >
            {modelConfig.label}
          </div>
        )}
        {onlinePeers.length > 1 && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[12px] font-mono"
            style={{ background: 'rgba(0,255,136,0.10)', border: '0.5px solid rgba(0,255,136,0.4)', color: '#00FF88' }}
          >
            <span className="w-[5px] h-[5px] rounded-full bg-green" style={{ animation: 'livePulse 2s ease-in-out infinite' }} />
            Live
          </div>
        )}
      </div>
    </div>
  )
}
