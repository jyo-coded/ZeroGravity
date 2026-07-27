/**
 * layoutStore — the workspace's docked-panel geometry.
 *
 * Deliberately separate from appStore: layout is pure view state with its own
 * persistence lifecycle, and keeping it out of the domain store means resizing
 * a panel can never invalidate project/editor state.
 *
 * Everything here is persisted, so the workspace a user arranges is the
 * workspace they get back on relaunch.
 */
import { create } from 'zustand'

export type SidebarView = 'explorer' | 'search' | 'outline' | 'git' | 'debug' | 'ledger' | 'team' | 'problems'
export type BottomTab = 'terminal' | 'problems' | 'output'

const LS_LAYOUT = '0g_layout'

interface Persisted {
  sidebarView: SidebarView
  sidebarWidth: number
  sidebarVisible: boolean
  aiWidth: number
  aiVisible: boolean
  bottomHeight: number
  bottomVisible: boolean
  bottomTab: BottomTab
  zenMode: boolean
}

const DEFAULTS: Persisted = {
  sidebarView: 'explorer',
  sidebarWidth: 260,
  sidebarVisible: true,
  aiWidth: 400,
  aiVisible: true,
  bottomHeight: 240,
  bottomVisible: false,
  bottomTab: 'terminal',
  zenMode: false,
}

// Clamps live next to the defaults so a corrupted or hand-edited localStorage
// value can never produce an unusable window.
export const LIMITS = {
  sidebar: { min: 180, max: 520 },
  ai: { min: 320, max: 720 },
  bottom: { min: 120, max: 640 },
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_LAYOUT)
    if (!raw) return DEFAULTS
    const p = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) }
    return {
      ...p,
      sidebarWidth: clamp(p.sidebarWidth, LIMITS.sidebar.min, LIMITS.sidebar.max),
      aiWidth: clamp(p.aiWidth, LIMITS.ai.min, LIMITS.ai.max),
      bottomHeight: clamp(p.bottomHeight, LIMITS.bottom.min, LIMITS.bottom.max),
    }
  } catch {
    return DEFAULTS
  }
}

interface LayoutState extends Persisted {
  setSidebarView: (v: SidebarView) => void
  /** Activity-bar click: switch to a view, or collapse if it's already showing. */
  toggleSidebarView: (v: SidebarView) => void
  setSidebarWidth: (w: number) => void
  toggleSidebar: () => void

  setAiWidth: (w: number) => void
  toggleAi: () => void
  showAi: () => void

  setBottomHeight: (h: number) => void
  toggleBottom: () => void
  setBottomTab: (t: BottomTab) => void
  /** Open the bottom panel on a specific tab (used by "run task", "show problems"). */
  showBottom: (t?: BottomTab) => void

  toggleZen: () => void
  resetLayout: () => void

  /** Transient — deliberately NOT persisted; reopening the app shouldn't
   *  restore a modal the user had open when they quit. */
  settingsOpen: boolean
  setSettingsOpen: (v: boolean) => void
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const persist = () => {
    const s = get()
    const data: Persisted = {
      sidebarView: s.sidebarView,
      sidebarWidth: s.sidebarWidth,
      sidebarVisible: s.sidebarVisible,
      aiWidth: s.aiWidth,
      aiVisible: s.aiVisible,
      bottomHeight: s.bottomHeight,
      bottomVisible: s.bottomVisible,
      bottomTab: s.bottomTab,
      zenMode: s.zenMode,
    }
    try { localStorage.setItem(LS_LAYOUT, JSON.stringify(data)) } catch { /* quota — layout is not critical */ }
  }
  const commit = (patch: Partial<LayoutState>) => { set(patch as never); persist() }

  return {
    ...load(),

    setSidebarView: (v) => commit({ sidebarView: v, sidebarVisible: true }),
    toggleSidebarView: (v) => {
      const { sidebarView, sidebarVisible } = get()
      if (sidebarVisible && sidebarView === v) commit({ sidebarVisible: false })
      else commit({ sidebarView: v, sidebarVisible: true })
    },
    setSidebarWidth: (w) => commit({ sidebarWidth: clamp(w, LIMITS.sidebar.min, LIMITS.sidebar.max) }),
    toggleSidebar: () => commit({ sidebarVisible: !get().sidebarVisible }),

    setAiWidth: (w) => commit({ aiWidth: clamp(w, LIMITS.ai.min, LIMITS.ai.max) }),
    toggleAi: () => commit({ aiVisible: !get().aiVisible }),
    showAi: () => commit({ aiVisible: true }),

    setBottomHeight: (h) => commit({ bottomHeight: clamp(h, LIMITS.bottom.min, LIMITS.bottom.max) }),
    toggleBottom: () => commit({ bottomVisible: !get().bottomVisible }),
    setBottomTab: (t) => commit({ bottomTab: t, bottomVisible: true }),
    showBottom: (t) => commit(t ? { bottomTab: t, bottomVisible: true } : { bottomVisible: true }),

    // Zen hides every panel so the code is the only thing on screen. The panel
    // flags themselves are untouched, so leaving zen restores the exact layout.
    toggleZen: () => commit({ zenMode: !get().zenMode }),
    resetLayout: () => commit({ ...DEFAULTS }),

    settingsOpen: false,
    setSettingsOpen: (v) => set({ settingsOpen: v }),
  }
})
