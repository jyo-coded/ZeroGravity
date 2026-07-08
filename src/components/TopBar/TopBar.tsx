/**
 * TopBar — 44px navigation bar matching SVG radical concept.
 *
 * SVG Layout (left to right):
 *   [0G / project-name] [branch pill] ... [peer avatars] [model pill] [Live pill]
 *
 * View switcher has moved to LeftDock — this is just project info + status.
 */

import { useAppStore } from '../../store/appStore'
import { followPeer } from '../../lib/crdt'

export function TopBar() {
  const {
    project, modelConfig, collaborators, gitBranch,
  } = useAppStore()

  const onlinePeers = collaborators.filter((c) => c.status !== 'offline')

  return (
    <div className="topbar drag-region relative z-50">
      {/* ─── Logo + Project Name ─────────────────────────────────────────── */}
      <div className="no-drag flex items-center gap-2">
        <span className="text-sm font-display font-bold text-gradient tracking-tight">0G</span>
        <span className="text-text-muted/20 text-xs">/</span>
        <span className="text-xs text-text-secondary font-medium truncate max-w-[160px]">
          {project?.name ?? 'zero-gravity'}
        </span>
      </div>

      {/* ─── Mission bar: real git branch (A6 — hidden when not a repo) ── */}
      {gitBranch && (
        <div className="no-drag flex items-center gap-2 ml-4">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono"
            style={{
              background: 'rgba(0,200,255,0.06)',
              borderColor: 'rgba(0,200,255,0.2)',
              color: '#94A3B8',
            }}
            title={`Git branch: ${gitBranch}`}
          >
            <span style={{ color: '#00C8FF', fontSize: '9px' }}>⎇</span>
            <span className="truncate max-w-[120px]">{gitBranch}</span>
          </div>
        </div>
      )}

      {/* ─── Spacer ─────────────────────────────────────────────────────── */}
      <div className="flex-1" />

      {/* ─── Peer avatars ───────────────────────────────────────────────── */}
      <div className="no-drag flex items-center -space-x-1.5 mr-3">
        {onlinePeers.slice(0, 5).map((peer) => (
          <button
            key={peer.id}
            onClick={() => {
              if (peer.is_self) return
              if (!followPeer(peer.id)) {
                useAppStore.getState().addNotification({
                  type: 'peer_join', detail: 'Follow', message: `${peer.username} — no live cursor yet`,
                })
              }
            }}
            className="no-drag w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold border-2 transition-transform hover:scale-110 hover:z-10"
            style={{
              backgroundColor: peer.avatar_color,
              borderColor: '#000510',
              color: '#000408',
            }}
            title={peer.is_self
              ? `${peer.username} (you)`
              : `Follow ${peer.username}${peer.current_file ? ` → ${peer.current_file}` : ''}`}
          >
            {peer.username.slice(0, 2).toUpperCase()}
          </button>
        ))}
        {onlinePeers.length > 5 && (
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-mono text-text-muted bg-surface border-2"
            style={{ borderColor: '#000510' }}
          >
            +{onlinePeers.length - 5}
          </div>
        )}
      </div>

      {/* ─── Model pill (purple) ─────────────────────────────────────────── */}
      {modelConfig && (
        <div className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-mono mr-2"
          style={{
            background: 'rgba(139,92,246,0.12)',
            border: '0.5px solid rgba(139,92,246,0.5)',
            color: '#A78BFA',
          }}
        >
          <span className="truncate max-w-[100px]">{modelConfig.label}</span>
          <span style={{ fontSize: '8px', opacity: 0.6 }}>▾</span>
        </div>
      )}

      {/* ─── Live pill (green) ───────────────────────────────────────────── */}
      {onlinePeers.length > 0 && (
        <div className="no-drag flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono"
          style={{
            background: 'rgba(0,255,136,0.1)',
            border: '0.5px solid rgba(0,255,136,0.4)',
            color: '#00FF88',
          }}
        >
          <div
            className="w-[6px] h-[6px] rounded-full bg-green"
            style={{ animation: 'livePulse 2s ease-in-out infinite' }}
          />
          <span>Live</span>
        </div>
      )}
    </div>
  )
}
