/**
 * InlineConstellation — the REAL project graph (T0-1).
 *
 * Data: get_graph_json → File nodes + Imports edges (the petgraph CodeGraph,
 * not changelog filenames). Layout: deterministic seeded ring + 180 settle
 * iterations run once per data change — no per-frame physics.
 * Interaction: wheel zoom (around cursor), drag pan, click node → open file.
 * State overlays: active file (bright cyan), recently changed (orange ring),
 * peer editing (green pulsing dashed ring).
 */

import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'

interface CNode {
  id: string
  path: string
  name: string
  x: number
  y: number
}

interface CEdge {
  from: number
  to: number
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LAYOUT = 600 // virtual layout space is LAYOUT x LAYOUT, centered in view

export function InlineConstellation() {
  const { openFile, changelog } = useAppStore()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<CNode[]>([])
  const edgesRef = useRef<CEdge[]>([])
  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const rafRef = useRef(0)
  const [nodeCount, setNodeCount] = useState(0)

  // ── Fetch + settle-once layout (re-runs when the changelog grows) ──────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await api.getGraphJson()
        if (cancelled) return
        const files = (data.nodes ?? []).filter((n) => n.kind === 'File')
        const nodes: CNode[] = files.slice(0, 80).map((n) => ({
          id: n.id, path: n.path, name: n.name, x: 0, y: 0,
        }))
        const index = new Map(nodes.map((n, i) => [n.id, i]))
        const edges: CEdge[] = (data.edges ?? [])
          .filter((e: any) => e.kind === 'Imports')
          .map((e: any) => ({ from: index.get(e.from) ?? -1, to: index.get(e.to) ?? -1 }))
          .filter((e: CEdge) => e.from >= 0 && e.to >= 0 && e.from !== e.to)

        // Deterministic ring seed, then settle
        const rng = mulberry32(42)
        const c = LAYOUT / 2
        nodes.forEach((n, i) => {
          const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2
          const r = 110 + rng() * 130
          n.x = c + r * Math.cos(a)
          n.y = c + r * Math.sin(a)
        })
        const vx = new Float32Array(nodes.length)
        const vy = new Float32Array(nodes.length)
        for (let it = 0; it < 180; it++) {
          for (let a = 0; a < nodes.length; a++) {
            for (let b = a + 1; b < nodes.length; b++) {
              const dx = nodes[b].x - nodes[a].x
              const dy = nodes[b].y - nodes[a].y
              const d2 = dx * dx + dy * dy + 1
              const f = 2200 / d2
              const d = Math.sqrt(d2)
              vx[a] -= (dx / d) * f; vy[a] -= (dy / d) * f
              vx[b] += (dx / d) * f; vy[b] += (dy / d) * f
            }
          }
          for (const e of edges) {
            const na = nodes[e.from], nb = nodes[e.to]
            const dx = nb.x - na.x, dy = nb.y - na.y
            const d = Math.sqrt(dx * dx + dy * dy) + 0.01
            const f = 0.03 * (d - 110)
            vx[e.from] += (dx / d) * f; vy[e.from] += (dy / d) * f
            vx[e.to] -= (dx / d) * f; vy[e.to] -= (dy / d) * f
          }
          for (let i = 0; i < nodes.length; i++) {
            vx[i] += (c - nodes[i].x) * 0.005
            vy[i] += (c - nodes[i].y) * 0.005
            vx[i] *= 0.82; vy[i] *= 0.82
            nodes[i].x += vx[i]; nodes[i].y += vy[i]
          }
        }

        nodesRef.current = nodes
        edgesRef.current = edges
        setNodeCount(nodes.length)
      } catch {
        nodesRef.current = []
        edgesRef.current = []
        setNodeCount(0)
      }
    })()
    return () => { cancelled = true }
  }, [changelog.length])

  // ── Draw loop + interaction ─────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ro = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    })
    ro.observe(canvas)
    canvas.width = canvas.offsetWidth
    canvas.height = canvas.offsetHeight

    const origin = () => {
      const { x, y, scale } = viewRef.current
      return {
        ox: x + canvas.width / 2 - (LAYOUT / 2) * scale,
        oy: y + canvas.height / 2 - (LAYOUT / 2) * scale,
        scale,
      }
    }
    const toLayout = (mx: number, my: number) => {
      const { ox, oy, scale } = origin()
      return { lx: (mx - ox) / scale, ly: (my - oy) / scale }
    }

    const draw = (t: number) => {
      const { ox, oy, scale } = origin()
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(scale, scale)

      const nodes = nodesRef.current
      const edges = edgesRef.current
      const s = useAppStore.getState()
      const recent = new Set(s.changelog.slice(0, 8).map((e) => e.file))
      const peerFiles = new Set<string>()
      for (const col of s.collaborators) {
        if (!col.is_self && col.current_file && col.status !== 'offline') {
          peerFiles.add(col.current_file)
        }
      }

      ctx.lineWidth = 0.6
      for (const e of edges) {
        const a = nodes[e.from], b = nodes[e.to]
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.strokeStyle = 'rgba(0,200,255,0.14)'
        ctx.stroke()
      }

      for (const n of nodes) {
        const isActive = n.path === s.activeFile
        const isRecent = recent.has(n.path)
        const hasPeer = peerFiles.has(n.path)
        const r = isActive ? 14 : 9

        ctx.beginPath()
        ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2)
        ctx.fillStyle = isActive ? 'rgba(0,200,255,0.10)' : 'rgba(0,200,255,0.04)'
        ctx.fill()

        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isActive ? 'rgba(0,200,255,0.16)' : 'rgba(0,200,255,0.06)'
        ctx.strokeStyle = isRecent
          ? 'rgba(255,165,0,0.75)'
          : isActive
            ? 'rgba(0,200,255,0.85)'
            : 'rgba(0,200,255,0.35)'
        ctx.lineWidth = isActive ? 1.4 : 0.8
        ctx.fill()
        ctx.stroke()

        if (hasPeer) {
          const pulse = 1 + 0.15 * Math.sin(t / 300)
          ctx.beginPath()
          ctx.arc(n.x, n.y, (r + 7) * pulse, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(0,255,136,0.45)'
          ctx.setLineDash([3, 3])
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.setLineDash([])
        }

        ctx.font = `${isActive ? 9.5 : 8.5}px "IBM Plex Mono", monospace`
        ctx.fillStyle = isActive ? '#C9EFFF' : '#64748B'
        ctx.textAlign = 'center'
        const label = n.name.length > 16 ? n.name.slice(0, 14) + '..' : n.name
        ctx.fillText(label, n.x, n.y + r + 12)
      }
      ctx.restore()
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    // Wheel zoom around the cursor (passive:false so preventDefault works)
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const before = toLayout(mx, my)
      const v = viewRef.current
      v.scale = Math.min(3, Math.max(0.4, v.scale * (e.deltaY < 0 ? 1.1 : 0.9)))
      // Keep the layout point under the cursor fixed
      v.x = mx - canvas.width / 2 + (LAYOUT / 2) * v.scale - before.lx * v.scale
      v.y = my - canvas.height / 2 + (LAYOUT / 2) * v.scale - before.ly * v.scale
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // Drag pan + click-to-open (click = drag under 4px)
    let drag: { sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null
    const onDown = (e: MouseEvent) => {
      drag = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y, moved: false }
    }
    const onMove = (e: MouseEvent) => {
      if (!drag) return
      const dx = e.clientX - drag.sx
      const dy = e.clientY - drag.sy
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      viewRef.current.x = drag.ox + dx
      viewRef.current.y = drag.oy + dy
    }
    const onUp = (e: MouseEvent) => {
      if (!drag) return
      const wasClick = !drag.moved
      drag = null
      if (!wasClick) return
      const rect = canvas.getBoundingClientRect()
      const { lx, ly } = toLayout(e.clientX - rect.left, e.clientY - rect.top)
      for (const n of nodesRef.current) {
        const dx = lx - n.x, dy = ly - n.y
        if (dx * dx + dy * dy < 15 * 15) {
          useAppStore.getState().openFile(n.path)
          break
        }
      }
    }
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // openFile is stable via zustand; suppress exhaustive-deps noise by using it in click handler via getState
  void openFile

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <span className="text-[12px] font-mono tracking-[0.2em] uppercase"
          style={{ color: 'rgba(0,200,255,0.35)' }}
        >
          Project Constellation
        </span>
        <span className="text-[11px] font-mono text-text-muted/40">
          {nodeCount} files · scroll to zoom · drag to pan
        </span>
      </div>

      <canvas ref={canvasRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {nodeCount === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-[12px] font-mono text-text-muted/40">
            Indexing project… the graph appears once files are scanned
          </p>
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-4 left-4 flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#00C8FF', opacity: 0.8 }} />
          <span className="text-[12px] text-text-muted">active</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#00FF88', opacity: 0.8 }} />
          <span className="text-[12px] text-text-muted">peer editing</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#FFA500', opacity: 0.8 }} />
          <span className="text-[12px] text-text-muted">recently changed</span>
        </div>
      </div>
    </div>
  )
}
