import { lazy, Suspense } from 'react'
import { useLayoutStore } from '../../store/layoutStore'
import { FileExplorer } from '../Explorer/FileExplorer'

// Explorer is the default view and loads eagerly; the rest arrive when first
// opened, so startup pays only for what is actually on screen.
const SearchPanel = lazy(() => import('../Search/SearchPanel').then((m) => ({ default: m.SearchPanel })))
const ProblemsPanel = lazy(() => import('../Problems/ProblemsPanel').then((m) => ({ default: m.ProblemsPanel })))
const TeamPanel = lazy(() => import('../Team/TeamPanel').then((m) => ({ default: m.TeamPanel })))
const SourceControlPanel = lazy(() => import('../Git/SourceControlPanel').then((m) => ({ default: m.SourceControlPanel })))
const LedgerPanel = lazy(() => import('../Ledger/LedgerPanel').then((m) => ({ default: m.LedgerPanel })))

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  git: 'Source Control',
  ledger: 'Ledger',
  team: 'Team',
  problems: 'Problems',
}

/**
 * The docked sidebar. One view at a time, chosen from the activity bar.
 *
 * This is a container only — it owns the header and scroll region, and hosts
 * the existing feature panels unchanged. Keeping the panels ignorant of their
 * container is what let the layout be replaced without rewriting them.
 */
export function SideBar() {
  const { sidebarView, sidebarWidth } = useLayoutStore()

  return (
    <aside className="panel panel-sidebar" style={{ width: sidebarWidth }} aria-label={TITLES[sidebarView]}>
      <header className="panel-header">
        <h2 className="panel-title">{TITLES[sidebarView]}</h2>
      </header>
      <div className="panel-body">
        <Suspense fallback={<PanelLoading />}>
        {sidebarView === 'explorer' && <FileExplorer />}
        {sidebarView === 'search' && <SearchPanel />}
        {sidebarView === 'problems' && <ProblemsPanel />}
        {sidebarView === 'team' && <TeamPanel />}
        {sidebarView === 'ledger' && <LedgerPanel />}
        {sidebarView === 'git' && <SourceControlPanel />}
        </Suspense>
      </div>
    </aside>
  )
}

/** Shown while a panel's code loads. Deliberately quiet — a spinner for a
 *  sub-100ms import reads as slowness that isn't there. */
function PanelLoading() {
  return <div className="empty-state"><p className="empty-state-hint">Loading…</p></div>
}
