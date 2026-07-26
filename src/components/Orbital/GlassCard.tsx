/**
 * GlassCard — the ONE shared floating window primitive of Orbital UI v2.
 * Every surface (editor, chat, explorer, search, problems, constellation,
 * team, peers, timeline, settings popup) is an instance of this.
 *
 * Performance contract (60fps target):
 *   - position, size, and tilt all live in Framer motion values —
 *     drag/hover/resize never cause a React re-render
 *   - tilt rotates an INNER wrapper; the outer element owns translation,
 *     so the two transforms never fight
 *   - rect is persisted to the store only on pointer-up
 *
 * Tilt spec (ported from the orbital concept): perspective(1400px),
 * rotateX/rotateY computed from cursor offset to card center, ~9° max,
 * smooth spring reset on mouseleave, disabled while dragging.
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { motion, useMotionValue, useSpring, useDragControls } from 'framer-motion'
import { X } from 'lucide-react'
import { useAppStore } from '../../store/appStore'

const TILT_MAX = 9 // degrees, per reference implementation

export interface GlassCardProps {
  id: string
  title: string
  icon?: React.ReactNode
  closable?: boolean
  draggable?: boolean
  resizable?: boolean
  tilt?: boolean
  minSize?: { width: number; height: number }
  /** Extra chrome rendered in the header, right side (before ✕) */
  headerExtra?: React.ReactNode
  /** Remove inner padding for content that manages its own (e.g. Monaco) */
  flush?: boolean
  onClose?: () => void
  children: React.ReactNode
}

export function GlassCard({
  id, title, icon, closable = true, draggable = true, resizable = true,
  tilt = true, minSize = { width: 240, height: 160 }, headerExtra,
  flush = false, onClose, children,
}: GlassCardProps) {
  const { orbitalCards, focusOrbitalCard, setOrbitalCardRect, closeOrbitalCard } = useAppStore()
  const card = orbitalCards[id]

  const rootRef = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()
  const draggingRef = useRef(false)
  const [resizing, setResizing] = useState(false)

  // Position + size as motion values — style-bound, zero re-renders on move
  const x = useMotionValue(card?.x ?? 200)
  const y = useMotionValue(card?.y ?? 120)
  const w = useMotionValue(card?.w ?? 360)
  const h = useMotionValue(card?.h ?? 420)

  // If the store rect changes externally (e.g. grid-arrange), adopt it
  useEffect(() => {
    if (!card) return
    if (Math.abs(x.get() - card.x) > 1) x.set(card.x)
    if (Math.abs(y.get() - card.y) > 1) y.set(card.y)
    if (Math.abs(w.get() - card.w) > 1) w.set(card.w)
    if (Math.abs(h.get() - card.h) > 1) h.set(card.h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.x, card?.y, card?.w, card?.h])

  // Cursor-tracked 3D tilt on the inner wrapper
  const rotateX = useSpring(useMotionValue(0), { stiffness: 260, damping: 24 })
  const rotateY = useSpring(useMotionValue(0), { stiffness: 260, damping: 24 })

  const handleTiltMove = useCallback((e: React.MouseEvent) => {
    if (!tilt || draggingRef.current || resizing) return
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5   // -0.5 .. 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    rotateY.set(px * TILT_MAX * 2)
    rotateX.set(-py * TILT_MAX * 2)
  }, [tilt, resizing, rotateX, rotateY])

  const resetTilt = useCallback(() => {
    rotateX.set(0)
    rotateY.set(0)
  }, [rotateX, rotateY])

  // Corner resize via raw pointer events on the handle
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)
    resetTilt()
    const startX = e.clientX
    const startY = e.clientY
    const startW = w.get()
    const startH = h.get()
    const move = (ev: PointerEvent) => {
      w.set(Math.max(minSize.width, startW + (ev.clientX - startX)))
      h.set(Math.max(minSize.height, startH + (ev.clientY - startY)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setResizing(false)
      setOrbitalCardRect(id, { w: Math.round(w.get()), h: Math.round(h.get()) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [id, minSize.width, minSize.height, w, h, setOrbitalCardRect, resetTilt])

  if (!card?.open) return null

  return (
    <motion.div
      ref={rootRef}
      drag={draggable}
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0.12}
      onDragStart={() => { draggingRef.current = true; resetTilt() }}
      onDragEnd={() => {
        const margin = 48
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = x.get()
        let ny = y.get()
        nx = Math.min(Math.max(nx, margin - w.get()), vw - margin)
        ny = Math.min(Math.max(ny, 36), vh - margin)
        x.set(nx)
        y.set(ny)
        setOrbitalCardRect(id, { x: Math.round(nx), y: Math.round(ny) })
      }}
      onPointerDown={() => focusOrbitalCard(id)}
      onMouseMove={handleTiltMove}
      onMouseLeave={resetTilt}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      className="absolute top-0 left-0"
      style={{ x, y, width: w, height: h, zIndex: card.z, ...(tilt ? { perspective: 1400 } : {}) }}
    >
      {/* Inner wrapper owns the tilt so it never fights the drag translate.
          When tilt is disabled we must NOT establish a preserve-3d / perspective
          context here: a WebGL <canvas> nested inside one renders blank in
          Chromium/WebView2 (that was the Constellation "black canvas" bug). */}
      <motion.div
        className="glasscard-surface w-full h-full flex flex-col overflow-hidden"
        style={tilt ? { rotateX, rotateY, transformStyle: 'preserve-3d' } : undefined}
      >
        {/* ── Header: drag handle + title + chrome ─────────────────────── */}
        <div
          className="flex items-center gap-2 px-3 h-8 shrink-0 select-none"
          style={{ borderBottom: '1px solid rgba(160,220,255,0.10)', cursor: draggable ? 'grab' : 'default' }}
          onPointerDown={(e) => {
            if (draggable) dragControls.start(e)
          }}
        >
          {/* three-dot grab handle, per reference chrome */}
          <div className="flex items-center gap-[3px] shrink-0" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-[3px] h-[3px] rounded-full" style={{ background: 'rgba(160,220,255,0.45)' }} />
            ))}
          </div>
          {icon && <span className="shrink-0 text-cyan/80">{icon}</span>}
          <span className="text-[12px] font-mono tracking-wide text-text-primary/90 truncate flex-1">
            {title}
          </span>
          {headerExtra}
          {closable && (
            <button
              onClick={() => { onClose ? onClose() : closeOrbitalCard(id) }}
              onPointerDown={(e) => e.stopPropagation()}
              className="p-0.5 rounded text-text-muted/50 hover:text-text-primary transition-colors shrink-0"
              title="Close"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {/* ── Content ──────────────────────────────────────────────────── */}
        <div className={`flex-1 min-h-0 relative ${flush ? '' : 'p-3'}`}>
          {children}
        </div>

        {/* ── Resize handle: diagonal corner marks ─────────────────────── */}
        {resizable && (
          <div
            onPointerDown={onResizeStart}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
            title="Resize"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" className="absolute bottom-0.5 right-0.5 opacity-40">
              <path d="M14 6 L6 14 M14 10 L10 14" stroke="rgba(160,220,255,0.8)" strokeWidth="1.2" fill="none" />
            </svg>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
