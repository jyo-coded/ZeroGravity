/**
 * CockpitRing — floating cockpit pill matching SVG concept.
 *
 * SVG: rounded pill (148x36) at bottom-center of canvas area.
 *   - Green status dot (left)
 *   - "3 peers ⬡" text (cyan)
 *   - Dark bg with cyan border + glow
 *
 * Expandable to show: share code, team list.
 * Wires to: collaborators, project
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Copy, Check } from 'lucide-react'
import { useAppStore } from '../../store/appStore'

const STATUS_COLORS: Record<string, string> = {
  idle:      '#64748B',
  writing:   '#00C8FF',
  reviewing: '#FFA500',
  offline:   '#2D3748',
}

const PERMISSION_STYLES: Record<string, { color: string; border: string }> = {
  owner: { color: '#00C8FF', border: 'rgba(0,200,255,0.3)' },
  alter: { color: '#00FF88', border: 'rgba(0,255,136,0.3)' },
  read:  { color: '#64748B', border: 'rgba(100,116,139,0.3)' },
}

export function CockpitRing() {
  const { collaborators, project } = useAppStore()
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const online = collaborators.filter((c) => c.status !== 'offline')
  const inviteCode = project?.invite_code ?? ''

  function copyCode() {
    if (!inviteCode) return
    navigator.clipboard.writeText(inviteCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className="fixed bottom-6 z-50 flex flex-col items-center"
      style={{ left: 'calc(50% - 182px)' }}  /* offset left since mission control takes right side */
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* ─── Expanded panel ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="w-72 glass-elevated rounded-2xl overflow-hidden mb-3 origin-bottom"
            style={{
              border: '0.6px solid rgba(0,200,255,0.3)',
              boxShadow: '0 0 20px rgba(0,200,255,0.15), 0 8px 32px rgba(0,0,0,0.4)',
            }}
          >
            {/* Share section */}
            <div className="p-4" style={{ borderBottom: '0.5px solid rgba(255,255,255,0.06)' }}>
              <p className="text-[9px] uppercase font-mono tracking-[0.2em] mb-2"
                style={{ color: 'rgba(0,200,255,0.5)' }}
              >
                Workspace Code
              </p>
              <div
                onClick={copyCode}
                className="flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-colors group"
                style={{
                  background: 'rgba(0,4,14,0.5)',
                  border: '0.5px solid rgba(255,255,255,0.08)',
                }}
                title="Copy Invite Code"
              >
                <code className="text-sm font-mono text-text-primary tracking-[0.3em]">
                  {inviteCode || '------'}
                </code>
                {copied
                  ? <Check size={14} className="text-green" />
                  : <Copy size={14} className="text-text-muted group-hover:text-cyan transition-colors" />
                }
              </div>
            </div>

            {/* Team list */}
            <div className="p-2 max-h-52 overflow-y-auto">
              {collaborators.length === 0 ? (
                <p className="text-xs text-text-muted text-center py-4">No team members</p>
              ) : (
                collaborators.map((collab) => {
                  const permStyle = PERMISSION_STYLES[collab.permission] ?? PERMISSION_STYLES.read
                  return (
                    <div key={collab.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-surface/30 transition-colors">
                      <div className="relative shrink-0">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                          style={{ backgroundColor: collab.avatar_color, color: '#000408' }}
                        >
                          {collab.username.slice(0, 2).toUpperCase()}
                        </div>
                        <div
                          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2"
                          style={{
                            backgroundColor: STATUS_COLORS[collab.status],
                            borderColor: '#02040C',
                          }}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-primary font-medium truncate">
                          {collab.username} {collab.is_self && <span className="text-text-muted">(You)</span>}
                        </p>
                        <p className="text-[10px] text-text-muted truncate capitalize">
                          {collab.status === 'writing' && collab.current_file
                            ? `Writing in ${collab.current_file.split('/').pop()}`
                            : collab.status}
                        </p>
                      </div>
                      <div className="shrink-0 px-2 py-0.5 rounded text-[9px] uppercase tracking-wider font-mono"
                        style={{ color: permStyle.color, border: `0.5px solid ${permStyle.border}` }}
                      >
                        {collab.permission}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Cockpit pill — matches SVG exactly ────────────────────────── */}
      <motion.div
        className="relative flex items-center gap-2.5 cursor-default z-10"
        style={{
          padding: '8px 20px',
          borderRadius: '18px',
          background: 'rgba(4,8,22,0.9)',
          border: '1.2px solid rgba(0,200,255,0.65)',
          boxShadow: expanded
            ? '0 0 20px rgba(0,200,255,0.3), 0 4px 16px rgba(0,0,0,0.4)'
            : '0 0 12px rgba(0,200,255,0.2)',
        }}
        whileHover={{ scale: 1.03 }}
      >
        {/* Green status dot */}
        <div
          className="w-[9px] h-[9px] rounded-full"
          style={{
            backgroundColor: '#00FF88',
            boxShadow: '0 0 6px rgba(0,255,136,0.5)',
            opacity: 0.95,
          }}
        />

        {/* Peer count + icon */}
        <span className="text-[10px] font-mono" style={{ color: '#00C8FF', opacity: 0.9 }}>
          {online.length} peer{online.length !== 1 ? 's' : ''} ⬡
        </span>
      </motion.div>
    </div>
  )
}
