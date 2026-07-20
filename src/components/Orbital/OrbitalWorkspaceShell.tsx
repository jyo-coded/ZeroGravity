import { useEffect, useMemo } from 'react'
import {
  AlertTriangle, Clock, FileCode2, Folder, GitBranch, MessageCircle,
  Network, Search, Users,
} from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { CosmicBackground } from './CosmicBackground'
import { TitleBar } from './TitleBar'
import { UtilityDisc, type DiscItem } from './UtilityDisc'
import { OrbitalCards } from './OrbitalCards'
import { MissionOrbit } from './MissionOrbit'
import { BottomDock } from './BottomDock'
import { NotificationStack } from '../Notifications/NotificationStack'
import { QuickOpen } from '../QuickOpen/QuickOpen'

export function OrbitalWorkspaceShell({ children }: { children?: React.ReactNode }) {
  const { openOrbitalCard, project } = useAppStore()
  const joinCode = project?.invite_code || 'No code yet'

  // Compact defaults. Editor is the primary center card; utilities open in
  // side columns. The store's openOrbitalCard cascades on collision, so even
  // if two utilities target the same slot, the second one offsets automatically.
  useEffect(() => {
    const vw = window.innerWidth
    openOrbitalCard('editor', {
      x: Math.max(240, Math.round(vw / 2 - 300)), y: 56, w: 600, h: 380,
    })
  }, [openOrbitalCard])

  const leftItems: DiscItem[] = useMemo(() => [
    {
      id: 'explorer',
      label: 'File Explorer',
      icon: <Folder size={16} />,
      hue: '#62d8ff',
      onClick: () => openOrbitalCard('explorer', { x: 16, y: 56, w: 220, h: 300 }),
    },
    {
      id: 'search',
      label: 'Search',
      icon: <Search size={16} />,
      hue: '#7aa7ff',
      onClick: () => openOrbitalCard('search', { x: 16, y: 56, w: 260, h: 300 }),
    },
    {
      id: 'problems',
      label: 'Problems',
      icon: <AlertTriangle size={16} />,
      hue: '#ffb86b',
      onClick: () => openOrbitalCard('problems', { x: 16, y: 56, w: 260, h: 240 }),
    },
    {
      id: 'canvas',
      label: 'Canvas',
      icon: <FileCode2 size={17} />,
      hue: '#53c7ff',
      onClick: () => openOrbitalCard('editor', {
        x: Math.max(240, Math.round(window.innerWidth / 2 - 300)), y: 56, w: 600, h: 380,
      }),
    },
    {
      id: 'constellation',
      label: 'Constellation',
      icon: <Network size={17} />,
      hue: '#6be7ff',
      onClick: () => openOrbitalCard('constellation', {
        x: Math.max(220, Math.round(window.innerWidth / 2 - 220)), y: 200, w: 440, h: 300,
      }),
    },
  ], [openOrbitalCard])

  const rightItems: DiscItem[] = useMemo(() => [
    {
      id: 'team',
      label: 'Team Chat',
      icon: <MessageCircle size={16} />,
      hue: '#e07cff',
      onClick: () => openOrbitalCard('team', {
        x: window.innerWidth - 296, y: 56, w: 280, h: 340,
      }),
    },
    {
      id: 'peers',
      label: 'Peer Info',
      sublabel: `Join Code: ${joinCode}`,
      icon: <Users size={17} />,
      hue: '#c88bff',
      onClick: () => openOrbitalCard('peers', {
        x: window.innerWidth - 296, y: 56, w: 280, h: 250,
      }),
    },
    {
      id: 'timeline',
      label: 'Project Timeline',
      icon: <Clock size={16} />,
      hue: '#b477ff',
      onClick: () => openOrbitalCard('timeline', {
        x: window.innerWidth - 476, y: window.innerHeight - 260, w: 460, h: 180,
      }),
    },
    {
      id: 'missionLog',
      label: 'Mission Log',
      icon: <GitBranch size={16} />,
      hue: '#a97dff',
      onClick: () => openOrbitalCard('missionLog', {
        x: window.innerWidth - 476, y: window.innerHeight - 260, w: 460, h: 200,
      }),
    },
  ], [joinCode, openOrbitalCard])

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#020615] text-text-primary">
      <CosmicBackground />
      <TitleBar />

      <div className="absolute inset-x-0 top-9 bottom-0 overflow-hidden">
        <UtilityDisc side="left" items={leftItems} />
        <UtilityDisc side="right" items={rightItems} />
        <MissionOrbit />
        <OrbitalCards />
        <BottomDock />
        <NotificationStack />
        <QuickOpen />
        {children}
      </div>
    </div>
  )
}
