/**
 * StarField — deterministic procedural star background.
 *
 * Uses mulberry32 seeded PRNG — NOT Math.random().
 * Three density layers matching SVG concept:
 *   - Far stars:  tiny (0.5-1px), very dim, slow twinkle — 240 stars
 *   - Mid stars:  small (1-1.5px), medium opacity — 90 stars
 *   - Near stars: larger (1.5-2.5px), bright, faster twinkle, glow halos — 30 stars
 *
 * Star colors: primarily #E2E8F0 with occasional cyan (#00C8FF) and purple (#8B5CF6)
 */

import { useMemo } from 'react'

// ─── Mulberry32 seeded PRNG ─────────────────────────────────────────────
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
  id: number
  x: number    // percent
  y: number    // percent
  size: number  // px
  opacity: number
  delay: number // animation delay in seconds
  duration: number // animation duration in seconds
  color: string
  glow?: string // box-shadow for near stars
}

function generateStars(
  rng: () => number,
  count: number,
  sizeRange: [number, number],
  opacityRange: [number, number],
  durationRange: [number, number],
  layer: 'far' | 'mid' | 'near',
): Star[] {
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    const size = sizeRange[0] + rng() * (sizeRange[1] - sizeRange[0])

    // Color distribution: mostly white/silver, some cyan, rare purple
    let color = '#E2E8F0'
    let glow: string | undefined
    const colorRoll = rng()

    if (layer === 'near') {
      if (colorRoll < 0.15) {
        color = '#00C8FF'
        glow = `0 0 ${size * 4}px ${size * 1.5}px rgba(0,200,255,0.35)`
      } else if (colorRoll < 0.25) {
        color = '#8B5CF6'
        glow = `0 0 ${size * 4}px ${size * 1.5}px rgba(139,92,246,0.3)`
      } else {
        glow = `0 0 ${size * 3}px ${size}px rgba(226,232,240,0.15)`
      }
    } else if (layer === 'mid') {
      if (colorRoll < 0.08) color = '#00C8FF'
      else if (colorRoll < 0.12) color = '#94A3B8'
    }

    stars.push({
      id: i,
      x: rng() * 100,
      y: rng() * 100,
      size,
      opacity: opacityRange[0] + rng() * (opacityRange[1] - opacityRange[0]),
      delay: rng() * 12,
      duration: durationRange[0] + rng() * (durationRange[1] - durationRange[0]),
      color,
      glow,
    })
  }
  return stars
}

const SEED = 0x5A455247 // "ZERG" — Zero Gravity

export function StarField() {
  const layers = useMemo(() => {
    const rng = mulberry32(SEED)
    return {
      far:  generateStars(rng, 240, [0.5, 1],   [0.1, 0.3],  [5, 10], 'far'),
      mid:  generateStars(rng, 90,  [1, 1.5],   [0.2, 0.5],  [3, 7],  'mid'),
      near: generateStars(rng, 30,  [1.5, 2.5], [0.5, 0.9],  [2, 4],  'near'),
    }
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* Far layer */}
      {layers.far.map((star) => (
        <div
          key={`f${star.id}`}
          className="absolute rounded-full"
          style={{
            left: `${star.x}%`,
            top: `${star.y}%`,
            width: star.size,
            height: star.size,
            backgroundColor: star.color,
            opacity: star.opacity,
            animation: `twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
            ['--star-base-opacity' as string]: star.opacity * 0.4,
            ['--star-peak-opacity' as string]: star.opacity,
          }}
        />
      ))}

      {/* Mid layer */}
      {layers.mid.map((star) => (
        <div
          key={`m${star.id}`}
          className="absolute rounded-full"
          style={{
            left: `${star.x}%`,
            top: `${star.y}%`,
            width: star.size,
            height: star.size,
            backgroundColor: star.color,
            opacity: star.opacity,
            animation: `twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
            ['--star-base-opacity' as string]: star.opacity * 0.5,
            ['--star-peak-opacity' as string]: star.opacity,
          }}
        />
      ))}

      {/* Near layer — brighter with glow halos */}
      {layers.near.map((star) => (
        <div
          key={`n${star.id}`}
          className="absolute rounded-full"
          style={{
            left: `${star.x}%`,
            top: `${star.y}%`,
            width: star.size,
            height: star.size,
            backgroundColor: star.color,
            opacity: star.opacity,
            boxShadow: star.glow,
            animation: `twinkle ${star.duration}s ease-in-out ${star.delay}s infinite`,
            ['--star-base-opacity' as string]: star.opacity * 0.6,
            ['--star-peak-opacity' as string]: star.opacity,
          }}
        />
      ))}
    </div>
  )
}
