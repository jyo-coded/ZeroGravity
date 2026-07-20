import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D, {
  type ConfigOptions,
  type ForceGraph3DInstance,
  type LinkObject,
  type NodeObject,
} from '3d-force-graph'
import { Box, Focus, RotateCcw, Search, Scan } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import * as api from '../../lib/api'
import { basename } from '../../lib/utils'

interface GraphNode3D extends NodeObject {
  id: string
  name: string
  path: string
  color: string
  val: number
}

interface GraphLink3D extends LinkObject<GraphNode3D> {
  source: string
  target: string
  color: string
}

const COLORS = ['#62d8ff', '#8ba5ff', '#c192ff', '#61f5d4', '#ffcf7a', '#ef88ff']
const TypedForceGraph3D = ForceGraph3D as unknown as new (
  element: HTMLElement,
  configOptions?: ConfigOptions,
) => ForceGraph3DInstance<GraphNode3D, GraphLink3D>

export function ConstellationCard3D() {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<ForceGraph3DInstance<GraphNode3D, GraphLink3D> | null>(null)
  const [query, setQuery] = useState('')
  const [nodes, setNodes] = useState<GraphNode3D[]>([])
  const [links, setLinks] = useState<GraphLink3D[]>([])
  const [loading, setLoading] = useState(true)
  const [mode3d, setMode3d] = useState(true)
  const openFile = useAppStore((s) => s.openFile)
  const changelogLength = useAppStore((s) => s.changelog.length)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const data = await api.getGraphJson()
        if (cancelled) return

        const files = (data.nodes ?? []).filter((n) => n.kind === 'File').slice(0, 160)
        const fileIds = new Set(files.map((n) => n.id))
        const nextNodes = files.map((n, index) => ({
          id: n.id,
          name: n.name,
          path: n.path,
          color: COLORS[index % COLORS.length],
          val: 1.4 + (index % 5) * 0.18,
        }))
        const nextLinks = (data.edges ?? [])
          .filter((e) => e.kind === 'Imports' && fileIds.has(e.from) && fileIds.has(e.to) && e.from !== e.to)
          .slice(0, 260)
          .map((e) => ({ source: e.from, target: e.to, color: 'rgba(130,205,255,0.34)' }))

        setNodes(nextNodes)
        setLinks(nextLinks)
      } catch {
        setNodes([])
        setLinks([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [changelogLength])

  const visibleGraph = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return { nodes, links }
    const filteredNodes = nodes.filter((n) =>
      n.name.toLowerCase().includes(needle) || n.path.toLowerCase().includes(needle)
    )
    const ids = new Set(filteredNodes.map((n) => n.id))
    return {
      nodes: filteredNodes,
      links: links.filter((l) => ids.has(String(l.source)) && ids.has(String(l.target))),
    }
  }, [links, nodes, query])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const graph = new TypedForceGraph3D(el, {
      controlType: 'orbit',
      rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' },
    })
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .nodeLabel((n) => `${n.name}<br/><span style="opacity:.65">${n.path}</span>`)
      .nodeColor((n) => n.color)
      .nodeOpacity(0.86)
      .nodeResolution(12)
      .nodeRelSize(5)
      .linkColor((l) => l.color)
      .linkOpacity(0.24)
      .linkWidth(0.35)
      .linkDirectionalParticles(1)
      .linkDirectionalParticleWidth(1.3)
      .linkDirectionalParticleSpeed(0.004)
      .warmupTicks(80)
      .cooldownTicks(180)
      .onNodeClick((node) => openFile(node.path))

    graphRef.current = graph

    const resize = () => {
      graph.width(el.clientWidth)
      graph.height(el.clientHeight)
      graph.refresh()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()

    return () => {
      ro.disconnect()
      graph._destructor()
      graphRef.current = null
    }
  }, [openFile])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.graphData(visibleGraph)
    graph.d3ReheatSimulation()
    if (visibleGraph.nodes.length > 0) {
      setTimeout(() => graph.zoomToFit(500, 46), 120)
    }
  }, [visibleGraph])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    graph.numDimensions(mode3d ? 3 : 2)
    graph.d3ReheatSimulation()
  }, [mode3d])

  const resetView = () => graphRef.current?.cameraPosition({ x: 0, y: 0, z: 360 }, { x: 0, y: 0, z: 0 }, 450)
  const fitView = () => graphRef.current?.zoomToFit(500, 44)

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 rounded-md border border-cyan/20 bg-white/[0.04] px-2 flex-1 min-w-0">
          <Search size={12} className="text-text-muted shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files..."
            className="w-full bg-transparent py-1.5 text-[10px] font-mono text-text-primary placeholder-text-dim outline-none"
          />
        </div>
        <span className="text-[9px] font-mono text-text-muted shrink-0">
          {visibleGraph.nodes.length} nodes
        </span>
      </div>

      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0 constellation-3d-canvas" />

        <div className="absolute right-3 top-3 bottom-12 w-28 overflow-y-auto rounded-md border border-white/10 bg-[#050b1d]/58 p-2 backdrop-blur-md">
          {visibleGraph.nodes.slice(0, 18).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => openFile(node.path)}
              className="mb-1 flex w-full items-center gap-1.5 text-left"
              title={node.path}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: node.color, boxShadow: `0 0 8px ${node.color}` }} />
              <span className="truncate text-[9px] font-mono text-text-muted hover:text-text-primary">{basename(node.path)}</span>
            </button>
          ))}
        </div>

        {loading && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[10px] font-mono text-cyan animate-pulse">Indexing constellation...</span>
          </div>
        )}

        {!loading && visibleGraph.nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[10px] font-mono text-text-muted">No matching file nodes.</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderTop: '1px solid rgba(140,200,255,0.08)' }}>
        <ToolbarButton active={mode3d} title="Toggle 3D" onClick={() => setMode3d((v) => !v)}>
          <Box size={14} />
          <span>3D</span>
        </ToolbarButton>
        <ToolbarButton title="Reset view" onClick={resetView}>
          <RotateCcw size={14} />
        </ToolbarButton>
        <ToolbarButton title="Fit to screen" onClick={fitView}>
          <Focus size={14} />
        </ToolbarButton>
        <span className="ml-auto flex items-center gap-1 text-[9px] font-mono text-text-muted">
          <Scan size={12} />
          drag orbit / wheel zoom
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
      className={`flex h-7 min-w-7 items-center justify-center gap-1 rounded-md border px-2 text-[10px] font-mono transition ${
        active ? 'border-cyan/40 bg-cyan/12 text-cyan' : 'border-white/10 text-text-muted hover:border-cyan/30 hover:text-cyan'
      }`}
    >
      {children}
    </button>
  )
}
