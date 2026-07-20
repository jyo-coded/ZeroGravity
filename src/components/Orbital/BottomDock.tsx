import { FilePlus2, Grid3X3, PanelsLeftRight, Save, SquareTerminal } from 'lucide-react'
import { useAppStore } from '../../store/appStore'

const CARD_ORDER = ['editor', 'explorer', 'search', 'problems', 'constellation', 'team', 'peers', 'timeline'] as const

export function BottomDock() {
  const { openOrbitalCard, setOrbitalCardRect, requestExplorerCreate, saveAll } = useAppStore()

  const arrangeCards = () => {
    const pad = 72
    const gap = 18
    const cols = window.innerWidth > 1250 ? 3 : 2
    const w = Math.max(300, Math.min(440, (window.innerWidth - pad * 2 - gap * (cols - 1)) / cols))
    const h = Math.max(220, Math.min(320, (window.innerHeight - 180) / 2))

    CARD_ORDER.forEach((id, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      const rect = {
        x: pad + col * (w + gap),
        y: 64 + row * (h + gap),
        w,
        h,
      }
      openOrbitalCard(id, rect)
      setOrbitalCardRect(id, rect)
    })
  }

  return (
    <div className="absolute left-1/2 bottom-5 z-[45] -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#071126]/70 px-3 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <DockButton title="Split view" onClick={() => openOrbitalCard('editor', { x: 260, y: 84, w: 720, h: 470 })}>
          <PanelsLeftRight size={17} />
        </DockButton>
        <DockButton title="New file" onClick={() => { openOrbitalCard('explorer', { x: 86, y: 104, w: 300, h: 460 }); requestExplorerCreate('file') }}>
          <FilePlus2 size={17} />
        </DockButton>
        <DockButton title="Save all" onClick={() => saveAll()}>
          <Save size={16} />
        </DockButton>
        <DockButton title="Arrange all cards" onClick={arrangeCards}>
          <Grid3X3 size={17} />
        </DockButton>
        <DockButton title="Terminal coming soon" disabled>
          <SquareTerminal size={17} />
        </DockButton>
      </div>
    </div>
  )
}

function DockButton({ title, disabled, onClick, children }: {
  title: string
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-text-muted transition hover:border-cyan/30 hover:bg-cyan/10 hover:text-cyan disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-white/10 disabled:hover:bg-transparent disabled:hover:text-text-muted"
    >
      {children}
    </button>
  )
}
