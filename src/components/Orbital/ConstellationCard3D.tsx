import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Focus, RotateCcw, Search, Scan } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import { basename } from '../../lib/utils'

interface GraphNode {
  id: string
  name: string
  path: string
  color: string
  val: number
}
interface GraphLink {
  source: string
  target: string
}
interface Laid extends GraphNode {
  x: number
  y: number
}

const COLORS = ['#62d8ff', '#8ba5ff', '#c192ff', '#61f5d4', '#ffcf7a', '#ef88ff']

/**
 * Tiny dependency-free force layout. WebGL is unavailable in this WebView, so
 * the whole graph is rendered as plain SVG — this computes node positions once
 * per data change (repulsion + link springs + gentle centering), then we just
 * paint circles and lines. O(n²) per tick, but n is capped at 160 so a few
 * hundred ticks run in well under 100ms.
 */
function computeLayout(nodes: GraphNode[], links: GraphLink[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const N = nodes.length
  if (N === 0) return pos

  nodes.forEach((n, i) => {
    const a = (i / N) * Math.PI * 2
    pos.set(n.id, { x: Math.cos(a) * 220 + (Math.random() - 0.5) * 24, y: Math.sin(a) * 220 + (Math.random() - 0.5) * 24 })
  })

  const edges = links
    .map((l) => [l.source, l.target] as const)
    .filter(([s, t]) => pos.has(s) && pos.has(t))

  const iterations = 380
  for (let it = 0; it < iterations; it++) {
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]))

    // Repulsion between every pair
    for (let i = 0; i < N; i++) {
      const a = pos.get(nodes[i].id)!
      const di = disp.get(nodes[i].id)!
      for (let j = i + 1; j < N; j++) {
        const b = pos.get(nodes[j].id)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        const d2 = dx * dx + dy * dy || 0.01
        const d = Math.sqrt(d2)
        const f = 7000 / d2
        const ux = dx / d
        const uy = dy / d
        di.x += ux * f
        di.y += uy * f
        const dj = disp.get(nodes[j].id)!
        dj.x -= ux * f
        dj.y -= uy * f
      }
    }

    // Link springs toward a target length
    for (const [s, t] of edges) {
      const a = pos.get(s)!
      const b = pos.get(t)!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = (d - 96) * 0.02
      const ux = dx / d
      const uy = dy / d
      const da = disp.get(s)!
      const db = disp.get(t)!
      da.x += ux * f
      da.y += uy * f
      db.x -= ux * f
      db.y -= uy * f
    }

    // Centering + cooled, step-limited integration
    const cool = 1 - it / iterations
    for (const n of nodes) {
      const p = pos.get(n.id)!
      const d = disp.get(n.id)!
      d.x -= p.x * 0.012
      d.y -= p.y * 0.012
      const max = 22 * cool + 2
      let sx = d.x
      let sy = d.y
      const sl = Math.sqrt(sx * sx + sy * sy) || 0.01
      if (sl > max) {
        sx = (sx / sl) * max
        sy = (sy / sl) * max
      }
      p.x += sx
      p.y += sy
    }
  }
  return pos
}

export function ConstellationCard3D() {
  const containerRef = useRef<HTMLDivElement>(null)
  const retryCountRef = useRef(0)
  const [query, setQuery] = useState('')
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [links, setLinks] = useState<GraphLink[]>([])
  const [loading, setLoading] = useState(true)
  const [graphReadyTick, setGraphReadyTick] = useState(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [transform, setTransform] = useState({ k: 1, tx: 0, ty: 0 })
  const [hovered, setHovered] = useState<string | null>(null)
  const openFile = useAppStore((s) => s.openFile)
  const changelogLength = useAppStore((s) => s.changelog.length)

  // Refetch when the background scan finishes.
  useEffect(() => {
    const un = listen('graph_ready', () => setGraphReadyTick((t) => t + 1))
    return () => { un.then((fn) => fn()).catch(() => {}) }
  }, [])

  // Track container size for fit-to-view.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  // Fetch graph data.
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    setLoading(true)
    ;(async () => {
      try {
        const data = await api.getGraphJson()
        if (cancelled) return

        const files = (data.nodes ?? []).filter((n) => n.kind === 'File').slice(0, 160)
        const fileIds = new Set(files.map((n) => n.id))
        const nextNodes: GraphNode[] = files.map((n, index) => ({
          id: n.id,
          name: n.name,
          path: n.path,
          color: COLORS[index % COLORS.length],
          val: 1.4 + (index % 5) * 0.18,
        }))
        const nextLinks: GraphLink[] = (data.edges ?? [])
          .filter((e) => e.kind === 'Imports' && fileIds.has(e.from) && fileIds.has(e.to) && e.from !== e.to)
          .slice(0, 260)
          .map((e) => ({ source: e.from, target: e.to }))

        setNodes(nextNodes)
        setLinks(nextLinks)

        if (nextNodes.length === 0 && retryCountRef.current < 5) {
          retryCountRef.current += 1
          retryTimer = setTimeout(() => setGraphReadyTick((t) => t + 1), 1200)
        } else if (nextNodes.length > 0) {
          retryCountRef.current = 0
        }
      } catch {
        setNodes([])
        setLinks([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer) }
  }, [changelogLength, graphReadyTick])

  // Search filter.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return { nodes, links }
    const fn = nodes.filter((n) => n.name.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle))
    const ids = new Set(fn.map((n) => n.id))
    return { nodes: fn, links: links.filter((l) => ids.has(l.source) && ids.has(l.target)) }
  }, [nodes, links, query])

  // Positions — recomputed only when the visible node/link SET changes.
  const laid = useMemo<Laid[]>(() => {
    const pos = computeLayout(visible.nodes, visible.links)
    return visible.nodes.map((n) => ({ ...n, ...(pos.get(n.id) ?? { x: 0, y: 0 }) }))
  }, [visible.nodes, visible.links])

  const posById = useMemo(() => {
    const m = new Map<string, Laid>()
    laid.forEach((n) => m.set(n.id, n))
    return m
  }, [laid])

  // Fit the laid-out graph into the viewport.
  const fitView = useCallback(() => {
    if (laid.length === 0 || size.w === 0 || size.h === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of laid) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y)
    }
    const pad = 60
    const gw = maxX - minX || 1
    const gh = maxY - minY || 1
    const k = Math.min((size.w - pad) / gw, (size.h - pad) / gh, 2.4)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setTransform({ k, tx: size.w / 2 - k * cx, ty: size.h / 2 - k * cy })
  }, [laid, size])

  // Auto-fit whenever the layout or size changes.
  useEffect(() => { fitView() }, [fitView])

  // Pan (drag background).
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.node) return // let node clicks through
    const startX = e.clientX
    const startY = e.clientY
    const start = transform
    const move = (ev: PointerEvent) => {
      setTransform({ k: start.k, tx: start.tx + (ev.clientX - startX), ty: start.ty + (ev.clientY - startY) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [transform])

  // Zoom (wheel), centered on the cursor.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setTransform((t) => {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const k = Math.min(3.5, Math.max(0.15, t.k * factor))
      const lx = (mx - t.tx) / t.k
      const ly = (my - t.ty) / t.k
      return { k, tx: mx - lx * k, ty: my - ly * k }
    })
  }, [])

  const resetView = () => fitView()

  const neighbors = useMemo(() => {
    if (!hovered) return new Set<string>()
    const s = new Set<string>([hovered])
    for (const l of visible.links) {
      if (l.source === hovered) s.add(l.target)
      if (l.target === hovered) s.add(l.source)
    }
    return s
  }, [hovered, visible.links])

  // Faint "star-chart" mesh: connect each node to its 2 nearest neighbors so the
  // view reads as a constellation even when the files share no import edges.
  const proximity = useMemo(() => {
    const out: Array<[string, string]> = []
    const seen = new Set<string>()
    for (const a of laid) {
      const near = laid
        .filter((b) => b.id !== a.id)
        .map((b) => ({ id: b.id, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 2)
      for (const nb of near) {
        const key = [a.id, nb.id].sort().join('|')
        if (seen.has(key)) continue
        seen.add(key)
        out.push([a.id, nb.id])
      }
    }
    return out
  }, [laid])

  // Background starfield (screen space, regenerated on resize).
  const stars = useMemo(() => {
    if (size.w === 0) return []
    return Array.from({ length: 54 }, (_, i) => ({
      x: Math.random() * size.w,
      y: Math.random() * size.h,
      r: Math.random() * 1.1 + 0.3,
      o: Math.random() * 0.5 + 0.12,
      dur: 2.5 + (i % 5),
      delay: (i % 8) * 0.4,
    }))
  }, [size.w, size.h])

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 rounded-md border border-cyan/20 bg-white/[0.04] px-2 flex-1 min-w-0">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files..."
            className="w-full bg-transparent py-1.5 text-[12px] font-mono text-text-primary placeholder-text-dim outline-none"
          />
        </div>
        <span className="text-[12px] font-mono text-text-muted shrink-0">{visible.nodes.length} nodes</span>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-hidden cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onWheel={onWheel}
          style={{ background: 'radial-gradient(130% 100% at 50% 15%, rgba(46,96,190,0.18), rgba(90,50,180,0.08) 45%, rgba(6,10,28,0) 72%)' }}
        >
          <style>{`
            @keyframes cst-twinkle { 0%,100% { opacity:.10 } 50% { opacity:.30 } }
            @keyframes cst-star { 0%,100% { opacity:.18 } 50% { opacity:.72 } }
          `}</style>

          {/* Starfield — screen space, static, gently twinkling */}
          {size.w > 0 && (
            <svg width={size.w} height={size.h} className="absolute inset-0 pointer-events-none">
              {stars.map((s, i) => (
                <circle
                  key={i} cx={s.x} cy={s.y} r={s.r} fill="#bcd8ff"
                  style={{ opacity: s.o, animation: `cst-star ${s.dur}s ease-in-out ${s.delay}s infinite` }}
                />
              ))}
            </svg>
          )}

          {/* Graph — pan/zoom transformed */}
          {size.w > 0 && (
            <svg width={size.w} height={size.h} className="block absolute inset-0">
              <g transform={`translate(${transform.tx},${transform.ty}) scale(${transform.k})`}>
                {/* Faint proximity mesh */}
                {proximity.map(([s, t], i) => {
                  const a = posById.get(s)
                  const b = posById.get(t)
                  if (!a || !b) return null
                  return (
                    <line
                      key={'p' + i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="rgba(150,200,255,0.11)" strokeWidth={0.5} strokeDasharray="2 3"
                    />
                  )
                })}

                {/* Real import edges (brighter) */}
                {visible.links.map((l, i) => {
                  const a = posById.get(l.source)
                  const b = posById.get(l.target)
                  if (!a || !b) return null
                  const active = hovered && (l.source === hovered || l.target === hovered)
                  return (
                    <line
                      key={i}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke={active ? 'rgba(150,215,255,0.85)' : 'rgba(120,195,255,0.42)'}
                      strokeWidth={active ? 1.6 : 0.9}
                    />
                  )
                })}

                {/* Nodes — layered halo / glow / ring / core */}
                {laid.map((n, idx) => {
                  const dim = hovered && !neighbors.has(n.id)
                  const isH = hovered === n.id
                  const r = (3.5 + n.val * 1.5) * (isH ? 1.4 : 1)
                  const showLabel = laid.length <= 40 || isH || transform.k > 1.4
                  return (
                    <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.35 : 1}>
                      <circle
                        r={r * 3} fill={n.color} opacity={0.16}
                        style={{ transformOrigin: 'center', animation: `cst-twinkle ${3 + (idx % 4)}s ease-in-out ${(idx % 5) * 0.3}s infinite` }}
                      />
                      <circle r={r * 1.7} fill={n.color} opacity={0.22} />
                      <circle r={r * 1.5} fill="none" stroke={n.color} strokeWidth={0.6} opacity={isH ? 0.8 : 0.45} />
                      <circle
                        data-node="1"
                        r={r} fill={n.color} opacity={0.96}
                        style={{ filter: `drop-shadow(0 0 ${isH ? 12 : 6}px ${n.color})`, cursor: 'pointer' }}
                        onPointerEnter={() => setHovered(n.id)}
                        onPointerLeave={() => setHovered((h) => (h === n.id ? null : h))}
                        onClick={() => openFile(n.path)}
                      />
                      {showLabel && (
                        <text
                          x={0} y={r + 11} textAnchor="middle"
                          style={{ fontSize: 9.5, fill: isH ? 'rgba(230,245,255,0.98)' : 'rgba(200,225,255,0.72)', pointerEvents: 'none', fontFamily: 'monospace' }}
                        >
                          {n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>
          )}
        </div>

        {/* File list */}
        <div className="absolute right-3 top-3 bottom-12 w-28 overflow-y-auto rounded-md border border-white/10 bg-[#050b1d]/58 p-2 backdrop-blur-md">
          {visible.nodes.slice(0, 18).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => openFile(node.path)}
              onPointerEnter={() => setHovered(node.id)}
              onPointerLeave={() => setHovered((h) => (h === node.id ? null : h))}
              className="mb-1 flex w-full items-center gap-1.5 text-left"
              title={node.path}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: node.color, boxShadow: `0 0 8px ${node.color}` }} />
              <span className="truncate text-[12px] font-mono text-text-muted hover:text-text-primary">{basename(node.path)}</span>
            </button>
          ))}
        </div>

        {loading && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[12px] font-mono text-cyan animate-pulse">Indexing constellation...</span>
          </div>
        )}

        {!loading && visible.nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[12px] font-mono text-text-muted">No matching file nodes.</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderTop: '1px solid rgba(140,200,255,0.08)' }}>
        <ToolbarButton title="Reset view" onClick={resetView}>
          <RotateCcw size={14} />
        </ToolbarButton>
        <ToolbarButton title="Fit to screen" onClick={fitView}>
          <Focus size={14} />
        </ToolbarButton>
        <span className="ml-auto flex items-center gap-1 text-[12px] font-mono text-text-muted">
          <Scan size={12} />
          drag pan / wheel zoom
        </span>
      </div>
    </div>
  )
}

function ToolbarButton({ title, active, onClick, children }: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border px-2 text-[12px] font-mono transition ${
        active ? 'border-cyan/40 bg-cyan/12 text-cyan' : 'border-white/10 text-text-muted hover:border-cyan/30 hover:text-cyan'
      }`}
    >
      {children}
    </button>
  )
}
