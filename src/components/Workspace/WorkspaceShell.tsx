import { lazy, Suspense, useEffect } from 'react'
import { useAppStore } from '../../store/appStore'
import { useLayoutStore, LIMITS } from '../../store/layoutStore'
import { CosmicBackground } from '../Orbital/CosmicBackground'
import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SideBar } from './SideBar'
import { EditorArea } from './EditorArea'
import { BottomPanel } from './BottomPanel'
import { AiPanel } from './AiPanel'
import { StatusBar } from './StatusBar'
import { Resizer } from './Resizer'
import { NotificationStack } from '../Notifications/NotificationStack'
import { QuickOpen } from '../QuickOpen/QuickOpen'
// Settings is a modal: never needed at startup.
const SettingsDialog = lazy(() => import('../Settings/SettingsDialog').then((m) => ({ default: m.SettingsDialog })))

/**
 * The workspace shell.
 *
 * Replaces the previous free-floating card canvas with a docked, deterministic
 * layout: title bar, activity bar, sidebar, editor, AI panel, bottom panel,
 * status bar. Positions never change, so the user's spatial memory is worth
 * something and nothing has to be hunted for or re-arranged.
 *
 * The cosmic identity survives as material — the starfield ground shows through
 * the editor's translucent surface, and the cyan/violet accent pair carries the
 * product's human-vs-AI provenance meaning throughout.
 */
export function WorkspaceShell({ children }: { children?: React.ReactNode }) {
  const {
    sidebarVisible, sidebarWidth, setSidebarWidth, toggleSidebar, setSidebarView,
    aiVisible, aiWidth, setAiWidth, toggleAi,
    bottomVisible, bottomHeight, setBottomHeight, toggleBottom, showBottom,
    zenMode, toggleZen, settingsOpen, setSettingsOpen,
  } = useLayoutStore()
  const setQuickOpen = useAppStore((s) => s.setQuickOpen)

  // Global keybindings. Registered once at the shell so every shortcut works no
  // matter which panel holds focus; each handler preventDefaults so the WebView
  // never steals the chord for a browser action.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()

      if (e.shiftKey) {
        switch (k) {
          case 'e': e.preventDefault(); setSidebarView('explorer'); return
          case 'f': e.preventDefault(); setSidebarView('search'); return
          case 'o': e.preventDefault(); setSidebarView('outline'); return
          case 'g': e.preventDefault(); setSidebarView('git'); return
          case 'm': e.preventDefault(); showBottom('problems'); return
          case 'a': e.preventDefault(); toggleAi(); return
          case 'p': e.preventDefault(); setQuickOpen('commands'); return
        }
      }

      // NOTE: Ctrl+K is deliberately not bound here — it is the app's chord
      // prefix (Ctrl+K S saves all), and stealing it would break that chord.
      switch (k) {
        case 'b': e.preventDefault(); toggleSidebar(); return
        case 'p': e.preventDefault(); setQuickOpen('files'); return
        case 'j': e.preventDefault(); toggleBottom(); return
        case '`': e.preventDefault(); showBottom('terminal'); return
      }

      if (k === ',') { e.preventDefault(); setSettingsOpen(true); return }
      if (e.altKey && k === 'z') { e.preventDefault(); toggleZen() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQuickOpen, setSettingsOpen, setSidebarView, showBottom, toggleAi, toggleBottom, toggleSidebar, toggleZen])

  // Zen collapses every dock so only code remains, without touching the stored
  // panel flags — leaving zen restores the exact arrangement the user had.
  const showSidebar = sidebarVisible && !zenMode
  const showAi = aiVisible && !zenMode
  const showBottomPanel = bottomVisible && !zenMode

  return (
    <div className="app-shell">
      <CosmicBackground />
      <TitleBar />

      <div className="workspace-body">
        {!zenMode && <ActivityBar />}

        {showSidebar && (
          <>
            <SideBar />
            <Resizer
              orientation="vertical"
              size={sidebarWidth}
              onResize={setSidebarWidth}
              label="Resize sidebar"
              min={LIMITS.sidebar.min}
              max={LIMITS.sidebar.max}
            />
          </>
        )}

        <div className="workspace-center">
          <EditorArea />
          {showBottomPanel && (
            <>
              <Resizer
                orientation="horizontal"
                size={bottomHeight}
                onResize={setBottomHeight}
                invert
                label="Resize panel"
                min={LIMITS.bottom.min}
                max={LIMITS.bottom.max}
              />
              <BottomPanel />
            </>
          )}
        </div>

        {showAi && (
          <>
            <Resizer
              orientation="vertical"
              size={aiWidth}
              onResize={setAiWidth}
              invert
              label="Resize AI panel"
              min={LIMITS.ai.min}
              max={LIMITS.ai.max}
            />
            <AiPanel />
          </>
        )}
      </div>

      <StatusBar />

      <NotificationStack />
      <QuickOpen />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {children}
    </div>
  )
}
