/**
 * ConstellationBg — ambient code graph visualization.
 *
 * Renders a simplified force-directed graph in the background
 * of the workspace. Purely ambient/decorative by default, but
 * becomes interactive in "constellation" view mode.
 *
 * Wires to: getGraphJson (via api)
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as api from '../../lib/api'
import type { GraphNode, GraphEdge } from '../../lib/types'
import { useAppStore } from '../../store/appStore'

const COLOR: Record<string, string> = {
  File:     '#00E5FF',
  Function: '#30D158',
  TypeDef:  '#BF5AF2',
}

interface SimNode extends GraphNode {
  x: number; y: number; vx: number; vy: number
}

export function ConstellationBg({ interactive = false }: { interactive?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<SimNode[]>([])
  const edgesRef = useRef<GraphEdge[]>([])
  const idMapRef = useRef<Map<string, SimNode>>(new Map())
  const rafRef = useRef<number>(0)
  const frameRef = useRef(0)
  const { openFile } = useAppStore()

  const [loaded, setLoaded] = useState(false)

  // ── Load graph data ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.getGraphJson()
        if (cancelled) return
        const canvas = canvasRef.current
        const cx = (canvas?.width ?? 800) / 2
        const cy = (canvas?.height ?? 600) / 2

        // Build sim nodes (files only for ambient, all for interactive)
        const nodes: SimNode[] = []
        const angle = (2 * Math.PI) / Math.max(data.nodes.filter(n => interactive || n.kind === 'File').length, 1)
        let i = 0
        for (const n of data.nodes) {
          if (!interactive && n.kind !== 'File') continue
          const r = 120 + Math.random() * 80
          nodes.push({ ...n, x: cx + r * Math.cos(angle * i), y: cy + r * Math.sin(angle * i), vx: 0, vy: 0 })
          i++
        }

        const ids = new Set(nodes.map(n => n.id))
        const edges = data.edges.filter(e => {
          if (!interactive && e.kind !== 'Imports') return false
          return ids.has(e.from) && ids.has(e.to)
        })

        nodesRef.current = nodes
        edgesRef.current = edges
        idMapRef.current = new Map(nodes.map(n => [n.id, n]))
        setLoaded(true)
      } catch {
        // Gracefully degrade — empty constellation
      }
    })()
    return () => { cancelled = true }
  }, [interactive])

  // ── Animation loop ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !loaded) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const W = canvas.width
      const H = canvas.height
      const cx = W / 2
      const cy = H / 2
      const nodes = nodesRef.current
      const edges = edgesRef.current
      const idMap = idMapRef.current

      ctx.clearRect(0, 0, W, H)

      // Light physics (only first ~300 frames then settle)
      if (frameRef.current < 300) {
        // Repulsion
        for (let a = 0; a < nodes.length; a++) {
          for (let b = a + 1; b < nodes.length; b++) {
            const na = nodes[a], nb = nodes[b]
            const dx = nb.x - na.x, dy = nb.y - na.y
            const d2 = dx * dx + dy * dy + 1
            const f = 1500 / d2
            const d = Math.sqrt(d2)
            na.vx -= (dx / d) * f; na.vy -= (dy / d) * f
            nb.vx += (dx / d) * f; nb.vy += (dy / d) * f
          }
        }
        // Springs
        for (const e of edges) {
          const na = idMap.get(e.from), nb = idMap.get(e.to)
          if (!na || !nb) continue
          const dx = nb.x - na.x, dy = nb.y - na.y
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01
          const f = 0.02 * (d - 120)
          na.vx += (dx / d) * f; na.vy += (dy / d) * f
          nb.vx -= (dx / d) * f; nb.vy -= (dy / d) * f
        }
        // Gravity + integrate
        for (const n of nodes) {
          n.vx += (cx - n.x) * 0.004; n.vy += (cy - n.y) * 0.004
          n.vx *= 0.8; n.vy *= 0.8
          n.x += n.vx; n.y += n.vy
        }
      }
      frameRef.current++

      // Draw edges
      for (const e of edges) {
        const src = idMap.get(e.from), tgt = idMap.get(e.to)
        if (!src || !tgt) continue
        ctx.beginPath()
        ctx.moveTo(src.x, src.y)
        ctx.lineTo(tgt.x, tgt.y)
        ctx.strokeStyle = interactive ? 'rgba(0,229,255,0.15)' : 'rgba(0,229,255,0.06)'
        ctx.lineWidth = 0.5
        ctx.stroke()
      }

      // Draw nodes
      const alpha = interactive ? 1 : 0.5
      for (const n of nodes) {
        const r = n.kind === 'File' ? (interactive ? 6 : 3) : 2
        const col = COLOR[n.kind] ?? '#8B92A8'

        // Glow
        if (n.kind === 'File') {
          ctx.beginPath()
          ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2)
          ctx.fillStyle = col.replace(')', `,${0.08 * alpha})`)
            .replace('rgb', 'rgba')
            .replace('#', '')
          // Use hex-aware approach
          const glowAlpha = 0.08 * alpha
          ctx.fillStyle = `rgba(${hexToRgb(col)},${glowAlpha})`
          ctx.fill()
        }

        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = col
        ctx.globalAlpha = alpha
        ctx.fill()
        ctx.globalAlpha = 1

        // Label (interactive mode only)
        if (interactive && n.kind === 'File') {
          ctx.font = '9px "JetBrains Mono", monospace'
          ctx.fillStyle = `rgba(232,236,244,${0.6 * alpha})`
          ctx.textAlign = 'center'
          const label = n.name.length > 18 ? n.name.slice(0, 16) + '...' : n.name
          ctx.fillText(label, n.x, n.y + r + 10)
        }
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [loaded, interactive])

  // ── Resize ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    })
    ro.observe(canvas)
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight
    return () => ro.disconnect()
  }, [])

  // ── Click handler (interactive mode) ─────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!interactive) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    for (const n of nodesRef.current) {
      if (n.kind !== 'File') continue
      const dx = mx - n.x, dy = my - n.y
      if (dx * dx + dy * dy < 100) {
        openFile(n.path)
        break
      }
    }
  }, [interactive, openFile])

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-full ${interactive ? 'cursor-pointer' : 'pointer-events-none'}`}
      style={{ opacity: interactive ? 1 : 0.4 }}
      onClick={handleClick}
    />
  )
}

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `${r},${g},${b}`
}
