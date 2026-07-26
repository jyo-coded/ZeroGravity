/**
 * ProblemsPanel — aggregated LSP diagnostics (A4).
 * Grouped by file, severity-colored, click → open at line.
 */

import { motion } from 'framer-motion'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { basename } from '../../lib/utils'

const SEV = {
  1: { icon: AlertCircle, color: '#FF453A', label: 'error' },
  2: { icon: AlertTriangle, color: '#FFA500', label: 'warning' },
  3: { icon: Info, color: '#00C8FF', label: 'info' },
  4: { icon: Info, color: '#64748B', label: 'hint' },
} as const

export function ProblemsPanel() {
  const { problems, openFileAtLine } = useAppStore()

  const files = Object.entries(problems).sort(([a], [b]) => a.localeCompare(b))
  const total = files.reduce((n, [, items]) => n + items.length, 0)
  const errors = files.reduce((n, [, items]) => n + items.filter((i) => i.severity === 1).length, 0)

  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 300, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="shrink-0 flex flex-col glass-panel overflow-hidden relative z-30"
      style={{ borderRight: '1px solid rgba(255,255,255,0.05)' }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
      >
        <span className="text-[12px] font-mono tracking-[0.2em] uppercase"
          style={{ color: 'rgba(0,200,255,0.5)' }}
        >
          Problems
        </span>
        <span className="text-[12px] font-mono text-text-muted/40">
          {total === 0 ? 'none' : `${total} (${errors} error${errors !== 1 ? 's' : ''})`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {files.length === 0 && (
          <p className="text-[12px] text-text-muted/40 text-center mt-6 px-4">
            No diagnostics — open a Rust/TS/Python file to start its language server
          </p>
        )}
        {files.map(([file, items]) => (
          <div key={file}>
            <div className="flex items-center gap-1.5 px-3 py-1">
              <span className="text-[12px] font-mono text-cyan/80 truncate">{basename(file)}</span>
              <span className="text-[12px] font-mono text-text-muted/50 truncate flex-1">{file}</span>
              <span className="text-[12px] font-mono text-text-muted shrink-0">{items.length}</span>
            </div>
            {items.slice(0, 50).map((p, i) => {
              const s = SEV[(p.severity as 1 | 2 | 3 | 4)] ?? SEV[3]
              const Icon = s.icon
              return (
                <button
                  key={`${file}:${p.line}:${p.col}:${i}`}
                  onClick={() => openFileAtLine(file, p.line, p.col - 1)}
                  className="w-full flex items-start gap-1.5 pl-5 pr-2 py-0.5 text-left hover:bg-surface/20 transition-colors"
                  title={p.message}
                >
                  <Icon size={10} className="shrink-0 mt-0.5" style={{ color: s.color }} />
                  <span className="text-[12px] text-text-secondary leading-snug line-clamp-2 flex-1">
                    {p.message}
                  </span>
                  <span className="text-[12px] font-mono text-text-muted/50 shrink-0">
                    {p.line}:{p.col}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </motion.div>
  )
}
