/**
 * OrbitalDisc — corner-anchored arc of utility icons.
 *
 * A large ring is anchored mostly off-canvas in a bottom corner; the visible
 * sweep carries the icons, positioned by trig against live window size (recomputed
 * on resize, not just mount). `mirror` flips it to the right corner.
 *
 * Per-icon accent hue drives bubble glow, active-state ring, label shadow, and
 * icon color — via CSS custom properties (--hue-*), the styling all lives in
 * index.css so component code stays clean.
 *
 * Clicking an icon calls onClick (which typically toggles its GlassCard).
 */

import { useState, useEffect, useCallback } from 'react'

export interface DiscItem {
  id: string
  label: string
  icon: React.ReactNode
  /** Base RGB, e.g. "0, 200, 255" — used to build --hue-glow/light/border */
  hue: string
  active?: boolean
  onClick: () => void
  extra?: React.ReactNode  // e.g. live join code beside Peer Info
}

interface OrbitalDiscProps {
  items: DiscItem[]
  mirror?: boolean       // false = bottom-left, true = bottom-right
}

export function OrbitalDisc({ items, mirror = false }: OrbitalDiscProps) {
  const [dim, setDim] = useState({ w: window.innerWidth, h: window.innerHeight })

  useEffect(() => {
    const onResize = () => setDim({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Ring geometry — radius scales gently with the smaller viewport dimension.
  const radius = Math.max(260, Math.min(dim.w, dim.h) * 0.46)
  // Anchor the ring center just outside the bottom corner so a quarter shows.
  const cx = mirror ? dim.w + radius * 0.30 : -radius * 0.30
  const cy = dim.h + radius * 0.28

  const placeIcon = useCallback((index: number, count: number) => {
    // Sweep the visible arc — a bit under a quarter turn
    const spread = Math.PI * 0.44
    const startBase = mirror ? Math.PI * 1.06 : -Math.PI * 0.06
    const t = count === 1 ? 0.5 : index / (count - 1)
    const angle = mirror ? startBase - spread * t : startBase + spread * t
    return {
      left: cx + radius * Math.cos(angle),
      top: cy - radius * Math.sin(angle),
    }
  }, [cx, cy, radius, mirror])

  return (
    <div className="absolute inset-0 pointer-events-none z-[5]">
      {/* Concentric ring arcs — decorative */}
      {[radius * 1.05, radius, radius * 0.82, radius * 0.64].map((r, i) => (
        <div
          key={i}
          className="orbital-ring"
          style={{
            width: r * 2, height: r * 2,
            left: cx - r, top: cy - r,
            opacity: 0.45 - i * 0.08,
          }}
        />
      ))}

      {/* Icons */}
      {items.map((item, i) => {
        const pos = placeIcon(i, items.length)
        // Split a "r, g, b" hue into semantic tokens for the CSS variables
        const hueStyle = {
          ['--hue-glow' as string]: `rgba(${item.hue}, 0.55)`,
          ['--hue-light' as string]: `rgba(${item.hue}, 0.55)`,
          ['--hue-border' as string]: `rgba(${item.hue}, 0.55)`,
        }
        return (
          <div
            key={item.id}
            className={`disc-icon pointer-events-auto ${item.active ? 'disc-icon-active' : ''}`}
            style={{
              ...hueStyle,
              left: pos.left,
              top: pos.top,
              transform: 'translate(-50%, -50%)',
              flexDirection: mirror ? 'row-reverse' : 'row',
            }}
            onClick={item.onClick}
          >
            <div className="disc-icon-bubble">
              <span style={{ color: `rgb(${item.hue})`, filter: `drop-shadow(0 0 8px rgba(${item.hue}, 0.65))` }}>
                {item.icon}
              </span>
            </div>
            <div className="flex flex-col" style={{ alignItems: mirror ? 'flex-end' : 'flex-start' }}>
              <span className="disc-icon-label">{item.label}</span>
              {item.extra}
            </div>
          </div>
        )
      })}
    </div>
  )
}
