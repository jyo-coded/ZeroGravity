/**
 * MissionLog — horizontal timeline strip at bottom of canvas.
 *
 * SVG Concept: glass panel at bottom of canvas area, labeled "MISSION LOG".
 * Timeline track with color-coded event cards connected by dots and lines.
 * Entries fade as they get older.
 *
 * Wires to: changelog, changelogFilter, revertEntry, activeFile, isAiWriting
 */

import { useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useAppStore } from '../../store/appStore'
import { timeAgo, basename } from '../../lib/utils'

// SVG-matched model/user colors
const ENTRY_COLORS: Record<string, string> = {
  'claude-sonnet': '#8B5CF6',
  'claude-opus':   '#8B5CF6',
  'gpt-4o':        '#00FF88',
  'gpt-4':         '#FFA500',
  'gemini-pro':    '#00C8FF',
  'ollama':        '#FFA500',
  'qwen':          '#00FF88',
}

function getEntryColor(model: string): string {
  const lower = model.toLowerCase()
  for (const [key, color] of Object.entries(ENTRY_COLORS)) {
    if (lower.includes(key.toLowerCase())) return color
  }
  return '#8B5CF6' // default purple
}

export function MissionLog() {
  const { changelog, changelogFilter, setChangelogFilter } = useAppStore()
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = changelog.filter((e) => {
    if (changelogFilter.file && !e.file.includes(changelogFilter.file)) return false
    if (changelogFilter.user && e.changed_by !== changelogFilter.user) return false
    return true
  })

  const uniqueUsers = [...new Set(changelog.map((e) => e.changed_by))]
  const uniqueFiles = [...new Set(changelog.map((e) => e.file))]

  // Auto-scroll to end on new entries
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  }, [changelog.length])

  return (
    <div className="flex flex-col overflow-hidden" style={{
      height: '120px',
      background: 'rgba(0,5,16,0.65)',
      borderRadius: '12px',
      border: '0.5px solid rgba(255,255,255,0.06)',
      margin: '0 16px 12px 16px',
    }}>
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 shrink-0">
        <span className="text-[9px] font-mono tracking-[0.15em] uppercase"
          style={{ color: 'rgba(0,200,255,0.5)' }}
        >
          MISSION LOG
        </span>
        <span className="text-[9px] text-text-muted/30 font-mono">{filtered.length} entries</span>

        {/* Filters */}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={changelogFilter.user ?? ''}
            onChange={(e) => setChangelogFilter({ ...changelogFilter, user: e.target.value || undefined })}
            className="text-[9px] py-0.5 px-1.5 rounded font-mono outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', color: '#64748B' }}
          >
            <option value="">All users</option>
            {uniqueUsers.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <select
            value={changelogFilter.file ?? ''}
            onChange={(e) => setChangelogFilter({ ...changelogFilter, file: e.target.value || undefined })}
            className="text-[9px] py-0.5 px-1.5 rounded font-mono outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', color: '#64748B' }}
          >
            <option value="">All files</option>
            {uniqueFiles.map((f) => <option key={f} value={f}>{basename(f)}</option>)}
          </select>
        </div>
      </div>

      {/* ─── Horizontal Timeline ────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden px-4 pb-2">
        <div className="flex items-center gap-2 h-full min-w-max">
          {filtered.length === 0 && (
            <div className="flex items-center justify-center w-full text-text-muted/40 text-[10px]">
              No entries
            </div>
          )}

          {[...filtered].reverse().map((entry, i) => {
            const color = getEntryColor(entry.model)
            // Fade older entries
            const fadeLevel = Math.max(0.3, 1 - i * 0.15)

            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: fadeLevel, x: 0 }}
                transition={{ delay: i * 0.02, duration: 0.15 }}
                className="flex items-center gap-2 shrink-0"
              >
                {/* Timeline dot */}
                <div className="shrink-0" style={{
                  width: Math.max(6, 10 - i),
                  height: Math.max(6, 10 - i),
                  borderRadius: '50%',
                  backgroundColor: color,
                  boxShadow: `0 0 6px ${color}60`,
                  opacity: fadeLevel,
                }} />

                {/* Entry card */}
                <div className="shrink-0 rounded-lg px-3 py-1.5 text-center"
                  style={{
                    background: `${color}0F`,
                    border: `0.5px solid ${color}40`,
                    minWidth: '100px',
                    opacity: fadeLevel,
                  }}
                >
                  <div className="text-[8px] font-medium" style={{ color }}>
                    {entry.changed_by} · {entry.model.split('-').pop()}
                  </div>
                  <div className="text-[9px] text-text-primary mt-0.5 line-clamp-1">
                    {entry.summary}
                  </div>
                  <div className="text-[8px] text-text-muted mt-0.5">
                    {basename(entry.file)} · {timeAgo(entry.timestamp)}
                  </div>
                </div>

                {/* Connecting line */}
                <div className="shrink-0 h-[1px] w-4"
                  style={{ background: `rgba(255,255,255,${0.08 * fadeLevel})` }}
                />
              </motion.div>
            )
          })}

          {/* NOW marker */}
          {filtered.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 ml-1">
              <div className="w-3 h-3 rounded-full animate-pulse"
                style={{ backgroundColor: '#00C8FF', boxShadow: '0 0 8px rgba(0,200,255,0.5)' }}
              />
              <span className="text-[9px] font-mono tracking-widest" style={{ color: '#00C8FF' }}>NOW</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
