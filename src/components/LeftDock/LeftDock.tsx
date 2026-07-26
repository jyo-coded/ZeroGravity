/**
 * LeftDock — 52px vertical icon rail (replaces top bar view switcher).
 *
 * SVG Layout:
 *   - 0G logo at top
 *   - ◈ Chat/Canvas (active default)
 *   - ⬡ Constellation graph
 *   - ≋ Timeline
 *   - ⬖ Team
 *   - ── spacer ──
 *   - ⚙ Settings (at bottom)
 *   - ⌘K command bar hint
 *
 * Wires to: activeView, onViewChange, clearProject, setView
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, LogOut, FolderTree, Search, ShieldAlert, Users } from 'lucide-react'
import { useAppStore } from '../../store/appStore'

import type { WorkspaceView } from '../../lib/types'
export type { WorkspaceView }

interface LeftDockProps {
  activeView: WorkspaceView
  onViewChange: (view: WorkspaceView) => void
}

const DOCK_ITEMS: { id: WorkspaceView; icon: string; label: string }[] = [
  { id: 'canvas',        icon: '◈', label: 'Canvas' },
  { id: 'constellation', icon: '⬡', label: 'Constellation' },
  { id: 'timeline',      icon: '≋', label: 'Timeline' },
  { id: 'team',          icon: '⬖', label: 'Team' },
]

export function LeftDock({ activeView, onViewChange }: LeftDockProps) {
  const {
    identity, clearProject, setView, explorerOpen, toggleExplorer,
    searchOpen, toggleSearch, problems, problemsOpen, toggleProblems,
    teamPanelOpen, toggleTeamPanel, teamUnread,
  } = useAppStore()
  const problemCount = Object.values(problems).reduce((n, arr) => n + arr.length, 0)
  const [showSettings, setShowSettings] = useState(false)
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)

  return (
    <div className="left-dock flex flex-col items-center py-3 shrink-0 relative z-40">
      {/* ─── 0G Logo ───────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-center justify-center">
        <span className="text-[13px] font-display font-bold text-gradient tracking-tight">
          0G
        </span>
      </div>

      {/* ─── Explorer toggle ───────────────────────────────────────────── */}
      <motion.button
        onClick={toggleExplorer}
        className={`dock-icon mb-1.5 ${explorerOpen ? 'dock-icon-active' : ''}`}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        title="File Explorer"
      >
        <FolderTree size={15} />
      </motion.button>
      <motion.button
        onClick={toggleSearch}
        className={`dock-icon mb-1.5 ${searchOpen ? 'dock-icon-active' : ''}`}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        title="Search (Ctrl+Shift+F)"
      >
        <Search size={15} />
      </motion.button>
      <motion.button
        onClick={toggleProblems}
        className={`dock-icon mb-3 relative ${problemsOpen ? 'dock-icon-active' : ''}`}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        title={`Problems (${problemCount})`}
      >
        <ShieldAlert size={15} />
        {problemCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{ background: 'rgba(255,69,58,0.9)', color: '#000408' }}
          >
            {problemCount > 99 ? '99' : problemCount}
          </span>
        )}
      </motion.button>
      <motion.button
        onClick={toggleTeamPanel}
        className={`dock-icon mb-3 relative ${teamPanelOpen ? 'dock-icon-active' : ''}`}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        title="Team & chat"
      >
        <Users size={15} />
        {teamUnread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{ background: 'rgba(0,255,136,0.9)', color: '#000408' }}
          >
            {teamUnread > 99 ? '99' : teamUnread}
          </span>
        )}
      </motion.button>

      {/* ─── Navigation Icons ──────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-1.5 flex-1">
        {DOCK_ITEMS.map((item) => {
          const isActive = activeView === item.id
          return (
            <div key={item.id} className="relative">
              <motion.button
                onClick={() => onViewChange(item.id)}
                onMouseEnter={() => setHoveredItem(item.id)}
                onMouseLeave={() => setHoveredItem(null)}
                className={`dock-icon ${isActive ? 'dock-icon-active' : ''}`}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.95 }}
                title={item.label}
              >
                <span className="text-base leading-none">{item.icon}</span>
              </motion.button>

              {/* Active indicator bar */}
              {isActive && (
                <motion.div
                  layoutId="dock-active-bar"
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-cyan rounded-r"
                  style={{ boxShadow: '0 0 6px rgba(0,200,255,0.5)' }}
                />
              )}

              {/* Hover tooltip */}
              <AnimatePresence>
                {hoveredItem === item.id && !isActive && (
                  <motion.div
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -4 }}
                    className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded-md bg-card border border-border/40 text-[12px] text-text-secondary font-mono whitespace-nowrap z-50"
                  >
                    {item.label}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>

      {/* ─── Bottom section ────────────────────────────────────────────── */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        {/* Settings */}
        <div className="relative">
          <motion.button
            onClick={() => setShowSettings(!showSettings)}
            className="dock-icon"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.95 }}
            title="Settings"
          >
            <Settings size={16} />
          </motion.button>

          {/* Settings dropdown */}
          <AnimatePresence>
            {showSettings && (
              <motion.div
                initial={{ opacity: 0, x: -4, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -4, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="absolute left-full bottom-0 ml-2 w-48 glass-elevated rounded-xl border border-border overflow-hidden shadow-panel z-50"
              >
                {identity && (
                  <div className="px-3 py-2.5 border-b border-border/50">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold text-void"
                        style={{ backgroundColor: identity.avatar_color }}
                      >
                        {identity.username.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="text-xs text-text-primary font-medium">{identity.username}</span>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => { clearProject(); setView('onboarding_project'); setShowSettings(false) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
                >
                  <LogOut size={12} />
                  <span>Leave Project</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Command palette (A5) */}
        <button
          onClick={() => useAppStore.getState().setQuickOpen('commands')}
          className="text-[12px] font-mono text-text-muted/40 hover:text-cyan transition-colors mt-1"
          title="Command Palette (Ctrl+Shift+P)"
        >
          ⌘K
        </button>
      </div>
    </div>
  )
}
