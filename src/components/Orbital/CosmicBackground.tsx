/**
 * CosmicBackground — Orbital UI v2 backdrop (Phase 1).
 *
 * Deep radial cosmos + ~90 seeded twinkling stars + 2 shooting stars on
 * independent 8–12s loops + faint decorative constellation lines (pure
 * atmosphere — NOT the functional Constellation card).
 *
 * Deliberately low prominence: foreground cards must always win.
 * Deterministic (mulberry32) — no Math.random(), stable across renders.
 */

import { useMemo } from 'react'

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Star {
  x: number; y: number; size: number
  opacity: number; delay: number; duration: number; color: string
}

export function CosmicBackground() {
  const { stars, lines } = useMemo(() => {
    const rng = mulberry32(0x0602 ^ 0x51ab)
    const stars: Star[] = []
    for (let i = 0; i < 92; i++) {
      const roll = rng()
      stars.push({
        x: rng() * 100,
        y: rng() * 100,
        size: 0.8 + rng() * 1.8,
        opacity: 0.25 + rng() * 0.55,
        delay: rng() * 9,
        duration: 3 + rng() * 6,
        color: roll < 0.12 ? '#9fd4ff' : roll < 0.18 ? '#c9b8ff' : '#e8f2ff',
      })
    }
    // Faint constellation lines: connect a few nearby star pairs
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = []
    for (let i = 0; i < stars.length && lines.length < 14; i++) {
      const a = stars[i]
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j]
        const dx = a.x - b.x, dy = a.y - b.y
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d > 4 && d < 11 && rng() < 0.5) {
          lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
          break
        }
      }
    }
    return { stars, lines }
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
      {/* Deep cosmic base */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 120% 90% at 50% 30%, #101b3f 0%, #0a1130 34%, #060a22 62%, #030614 100%)',
        }}
      />
      {/* Soft nebula tints */}
      <div className="absolute inset-0" style={{
        background:
          'radial-gradient(ellipse 60% 45% at 18% 22%, rgba(60,110,220,0.10) 0%, transparent 70%),' +
          'radial-gradient(ellipse 50% 40% at 84% 72%, rgba(120,80,230,0.09) 0%, transparent 70%)',
      }} />

      {/* Decorative constellation lines (atmosphere only) */}
      <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="rgba(150,200,255,0.10)" strokeWidth="0.06"
          />
        ))}
      </svg>

      {/* Stars */}
      {stars.map((s, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            left: `${s.x}%`, top: `${s.y}%`,
            width: s.size, height: s.size,
            backgroundColor: s.color,
            opacity: s.opacity,
            boxShadow: s.size > 2 ? `0 0 ${s.size * 3}px rgba(180,220,255,0.5)` : undefined,
            animation: `twinkle ${s.duration}s ease-in-out ${s.delay}s infinite`,
            ['--star-base-opacity' as string]: s.opacity * 0.35,
            ['--star-peak-opacity' as string]: s.opacity,
          }}
        />
      ))}

      {/* Two shooting stars, independent loops (8–12s) */}
      <div
        className="shooting-star"
        style={{
          top: '14%', right: '-140px',
          ['--shoot-dx' as string]: '-72vw', ['--shoot-dy' as string]: '30vh',
          ['--shoot-angle' as string]: '-160deg',
          animation: 'shoot 9.5s linear 2s infinite',
        }}
      />
      <div
        className="shooting-star"
        style={{
          top: '52%', right: '-140px',
          ['--shoot-dx' as string]: '-58vw', ['--shoot-dy' as string]: '18vh',
          ['--shoot-angle' as string]: '-168deg',
          animation: 'shoot 11.8s linear 7.3s infinite',
        }}
      />
    </div>
  )
}
