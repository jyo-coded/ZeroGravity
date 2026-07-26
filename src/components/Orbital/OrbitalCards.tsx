import { lazy, Suspense } from 'react'
import { AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, FileCode2, Folder, GitBranch, MessageSquare,
  Search, Users, Clock, Info, Network, Sparkles, Trash2,
} from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { GlassCard } from './GlassCard'
import { EditorCard } from './EditorCard'
import { FileExplorer } from '../Explorer/FileExplorer'
import { SearchPanel } from '../Search/SearchPanel'
import { ProblemsPanel } from '../Problems/ProblemsPanel'
import { TeamPanel } from '../Team/TeamPanel'
import { MissionLog } from '../MissionLog/MissionLog'
import { MissionControl } from '../MissionControl/MissionControl'
import { ModelPill } from '../MissionControl/ModelPill'

const ConstellationCard3D = lazy(() =>
  import('./ConstellationCard3D').then((mod) => ({ default: mod.ConstellationCard3D }))
)

export function OrbitalCards() {
  const cards = useAppStore((s) => s.orbitalCards)
  const clearChatHistory = useAppStore((s) => s.clearChatHistory)

  return (
    <AnimatePresence>
      {cards.ai?.open && (
        <GlassCard
          key="ai"
          id="ai"
          title="Mission Control"
          icon={<Sparkles size={13} />}
          minSize={{ width: 340, height: 380 }}
          flush
          headerExtra={
            <div className="flex items-center gap-1.5">
              <ModelPill />
              <button
                onClick={() => clearChatHistory()}
                onPointerDown={(e) => e.stopPropagation()}
                className="p-0.5 rounded text-text-muted/50 transition-colors hover:text-text-primary"
                title="Clear chat"
              >
                <Trash2 size={12} />
              </button>
            </div>
          }
        >
          <MissionControl />
        </GlassCard>
      )}

      {cards.editor?.open && (
        <GlassCard key="editor" id="editor" title="Canvas" icon={<FileCode2 size={13} />} minSize={{ width: 520, height: 340 }} flush>
          <EditorCard />
        </GlassCard>
      )}

      {cards.explorer?.open && (
        <GlassCard key="explorer" id="explorer" title="File Explorer" icon={<Folder size={13} />} minSize={{ width: 260, height: 320 }} flush>
          <div className="orbital-panel-adapter h-full"><FileExplorer /></div>
        </GlassCard>
      )}

      {cards.search?.open && (
        <GlassCard key="search" id="search" title="Search" icon={<Search size={13} />} minSize={{ width: 330, height: 320 }} flush>
          <div className="orbital-panel-adapter h-full"><SearchPanel /></div>
        </GlassCard>
      )}

      {cards.problems?.open && (
        <GlassCard key="problems" id="problems" title="Problems" icon={<AlertTriangle size={13} />} minSize={{ width: 330, height: 260 }} flush>
          <div className="orbital-panel-adapter h-full"><ProblemsPanel /></div>
        </GlassCard>
      )}

      {cards.constellation?.open && (
        <GlassCard key="constellation" id="constellation" title="Constellation" icon={<Network size={13} />} minSize={{ width: 460, height: 320 }} flush tilt={false}>
          <Suspense fallback={<div className="h-full grid place-items-center text-[12px] font-mono text-cyan animate-pulse">Loading constellation...</div>}>
            <ConstellationCard3D />
          </Suspense>
        </GlassCard>
      )}

      {cards.team?.open && (
        <GlassCard key="team" id="team" title="Team Chat" icon={<MessageSquare size={13} />} minSize={{ width: 320, height: 380 }} flush>
          <div className="orbital-panel-adapter h-full"><TeamPanel /></div>
        </GlassCard>
      )}

      {cards.peers?.open && (
        <GlassCard key="peers" id="peers" title="Peer Info" icon={<Users size={13} />} minSize={{ width: 320, height: 260 }}>
          <PeerInfoCard />
        </GlassCard>
      )}

      {cards.timeline?.open && (
        <GlassCard key="timeline" id="timeline" title="Project Timeline" icon={<Clock size={13} />} minSize={{ width: 460, height: 220 }} flush>
          <div className="h-full p-2"><MissionLog /></div>
        </GlassCard>
      )}

      {cards.missionLog?.open && (
        <GlassCard key="missionLog" id="missionLog" title="Mission Log" icon={<GitBranch size={13} />} minSize={{ width: 460, height: 220 }} flush>
          <div className="h-full p-2"><MissionLog /></div>
        </GlassCard>
      )}
    </AnimatePresence>
  )
}

function PeerInfoCard() {
  const { project, collaborators } = useAppStore()
  const joinCode = project?.invite_code || 'Not available'

  return (
    <div className="h-full overflow-y-auto space-y-3">
      <div className="rounded-md border border-cyan/20 bg-cyan/[0.06] p-3">
        <div className="flex items-center gap-2 mb-1">
          <Info size={13} className="text-cyan" />
          <span className="text-[12px] font-mono uppercase tracking-widest text-cyan/80">Join Code</span>
        </div>
        <code className="text-lg font-mono text-text-primary tracking-wider">{joinCode}</code>
      </div>

      <div className="space-y-2">
        {collaborators.map((c) => (
          <div key={c.id} className="flex items-center gap-3 rounded-md border border-white/10 bg-white/[0.03] p-2">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0"
              style={{ backgroundColor: c.avatar_color, color: '#000408' }}
            >
              {c.username.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-primary truncate">
                {c.username} {c.is_self && <span className="text-text-muted">(you)</span>}
              </p>
              <p className="text-[12px] text-text-muted capitalize">{c.status}</p>
              {c.current_file && <p className="text-[12px] font-mono text-cyan/70 truncate">{c.current_file}</p>}
            </div>
            <span className="rounded border border-white/10 px-2 py-0.5 text-[12px] font-mono uppercase text-text-muted">
              {c.permission}
            </span>
          </div>
        ))}
        {collaborators.length === 0 && <p className="text-[12px] text-text-muted">No collaborators connected yet.</p>}
      </div>
    </div>
  )
}
