/**
 * UtilityDisc — corner-anchored orbital nav wheel, geometry fitted to the
 * reference image (circle regression through its actual icon positions):
 *   LEFT : center (-1.2%vw, 76%vh),   r ≈ 25%vh,   sweep -64.8° → +23.8°
 *   RIGHT: center (101.8%vw, 90.6%vh), r ≈ 23.3%vh, sweep -127.9° → -183.6°
 * Recomputes from live viewport on resize.
 *
 * THE RING: previous builds drew hairline borders (1.2px @ 0.22 alpha) which
 * never read as the reference's broad luminous arc. It is now an actual BAND —
 * a circle with a thick translucent border plus inner/outer glow — with crisp
 * concentric detail lines layered over it.
 *
 * Color split per spec: LEFT = cyan family, RIGHT = purple/magenta family.
 * Icon badges grow toward the outer/bottom end of the arc (File Explorer is
 * the largest, Constellation the smallest), matching the reference.
 */

import { useEffect, useState, cloneElement, isValidElement } from 'react'

/** "#62d8ff" → "98, 216, 255" (null if not a hex triple) */
function hexToRgbTriple(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}`
}

export interface DiscItem {
  id: string
  label: string
  icon: React.ReactNode
  hue: string
  sublabel?: string
  onClick: () => void
}

interface UtilityDiscProps {
  side: 'left' | 'right'
  items: DiscItem[]
}

const DEG = Math.PI / 180

export function UtilityDisc({ side, items }: UtilityDiscProps) {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [hovered, setHovered] = useState<string | null>(null)
  const mirror = side === 'right'
  const n = items.length

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ── Image-fitted geometry ────────────────────────────────────────────
  const radius = mirror
    ? Math.max(150, Math.min(280, vp.h * 0.233))
    : Math.max(170, Math.min(300, vp.h * 0.25))
  const cx = mirror ? vp.w * 1.018 : -0.012 * vp.w - 6
  const cy = mirror ? vp.h * 0.906 : vp.h * 0.76
  const startAngle = mirror ? -127.9 : -64.8   // deg
  const sweep = mirror ? -55.7 : 88.6          // deg, end-to-end
  const step = n > 1 ? sweep / (n - 1) : 0

  // Band thickness scales with radius so it stays proportional at any size
  const band = Math.round(radius * 0.30)

  // Disc family color — cyan on the left, purple/magenta on the right
  const familyRgb = mirror ? '168, 110, 255' : '90, 190, 255'

  const placeIcon = (i: number) => {
    const a = (startAngle + i * step) * DEG
    return {
      left: cx + Math.cos(a) * radius,
      top: cy + Math.sin(a) * radius,
      angleDeg: startAngle + i * step,
    }
  }

  // Badge size ramp: index 0 (File Explorer / Team Chat) is the outermost,
  // largest node; the last item is the smallest. Matches the reference.
  const badgeSize = (i: number) => {
    const t = n > 1 ? i / (n - 1) : 0
    return Math.round(56 - t * 14)  // 56px → 42px
  }
  const glyphSize = (i: number) => Math.round(badgeSize(i) * 0.42)

  return (
    <div className={`utility-wheel utility-wheel-${side} absolute inset-0 pointer-events-none z-[28]`}>
      {/* ── The luminous BAND — the element that kept failing before ───── */}
      <div
        className="wheel-band"
        style={{
          left: cx - radius,
          top: cy - radius,
          width: radius * 2,
          height: radius * 2,
          // 0.10 alpha was invisible against near-black — this is the third
          // attempt at this band; it now carries real luminance.
          borderWidth: band,
          borderColor: `rgba(${familyRgb}, 0.22)`,
          boxShadow:
            `0 0 90px 14px rgba(${familyRgb}, 0.30),` +
            `inset 0 0 90px 12px rgba(${familyRgb}, 0.26)`,
        }}
      />

      {/* Crisp concentric detail lines over the band */}
      {[radius + band / 2, radius, radius - band / 2, radius - band].map((r, i) => (
        <div
          key={i}
          className="wheel-line"
          style={{
            left: cx - r,
            top: cy - r,
            width: r * 2,
            height: r * 2,
            borderColor: `rgba(${familyRgb}, ${0.72 - i * 0.10})`,
            borderStyle: i === 3 ? 'dashed' : 'solid',
            boxShadow: `0 0 12px rgba(${familyRgb}, 0.35)`,
          }}
        />
      ))}

      {/* Corner glow core */}
      <div
        className="utility-wheel-core"
        style={{
          left: cx, top: cy,
          width: radius * 2.2, height: radius * 2.2,
          background: `radial-gradient(circle, rgba(${familyRgb}, 0.13) 0%, rgba(${familyRgb}, 0.04) 45%, transparent 70%)`,
        }}
      />

      {/* Icons */}
      {items.map((item, i) => {
        const pos = placeIcon(i)
        const active = hovered === item.id
        const rgb = hexToRgbTriple(item.hue) ?? familyRgb
        const size = badgeSize(i)
        return (
          <button
            key={item.id}
            type="button"
            className={`disc-icon pointer-events-auto ${active ? 'disc-icon-active' : ''}`}
            style={{
              left: pos.left,
              top: pos.top,
              transform: `translate(-50%, -50%) scale(${active ? 1.1 : 1})`,
              flexDirection: mirror ? 'row-reverse' : 'row',
              ['--hue-glow' as string]: `rgba(${rgb}, 0.55)`,
              ['--hue-light' as string]: `rgba(${rgb}, 0.5)`,
              ['--hue-border' as string]: `rgba(${rgb}, 0.55)`,
            }}
            onClick={item.onClick}
            onMouseEnter={() => setHovered(item.id)}
            onMouseLeave={() => setHovered(null)}
            title={item.sublabel ? `${item.label} — ${item.sublabel}` : item.label}
          >
            <span
              className="disc-icon-bubble"
              style={{ width: size, height: size }}
            >
              <span style={{ color: `rgb(${rgb})`, filter: `drop-shadow(0 0 8px rgba(${rgb}, 0.75))`, display: 'flex' }}>
                {/* Re-size the glyph to match this node's ramped badge */}
                {isValidElement(item.icon)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ? cloneElement(item.icon as any, { size: glyphSize(i) })
                  : item.icon}
              </span>
            </span>
            {/* Label BESIDE the icon (never below), per the reference */}
            <span className="flex flex-col" style={{ alignItems: mirror ? 'flex-end' : 'flex-start' }}>
              <span className="disc-icon-label">{item.label}</span>
              {item.sublabel && <span className="disc-icon-sublabel">{item.sublabel}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}
