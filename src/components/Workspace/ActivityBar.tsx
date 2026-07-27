import { Files, Search, ListTree, GitBranch, Bug, ShieldCheck, Users, AlertTriangle, Settings, PanelBottom } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useLayoutStore, type SidebarView } from '../../store/layoutStore'

interface Item {
  id: SidebarView
  label: string
  icon: React.ReactNode
  hint: string
  badge?: number
  /** Badge is informational (accent) rather than a problem count (red). */
  badgeTone?: 'info' | 'error'
}

/**
 * The activity bar — the workspace's primary navigation.
 *
 * Fixed, ordered, and always visible: unlike the previous free-floating card
 * launcher, a user learns these positions once and they never move. Clicking
 * the active view collapses the sidebar (VS Code / Antigravity behaviour).
 */
export function ActivityBar() {
  const { sidebarView, sidebarVisible, toggleSidebarView, toggleBottom, bottomVisible, setSettingsOpen } = useLayoutStore()
  const problems = useAppStore((s) => s.problems)
  const teamUnread = useAppStore((s) => s.teamUnread)
  const changelogCount = useAppStore((s) => s.changelog.length)

  const problemCount = Object.values(problems).reduce((n, arr) => n + arr.length, 0)

  const items: Item[] = [
    { id: 'explorer', label: 'Explorer', icon: <Files size={19} />, hint: 'Ctrl+Shift+E' },
    { id: 'search', label: 'Search', icon: <Search size={19} />, hint: 'Ctrl+Shift+F' },
    { id: 'outline', label: 'Outline', icon: <ListTree size={19} />, hint: 'Ctrl+Shift+O' },
    { id: 'git', label: 'Source Control', icon: <GitBranch size={19} />, hint: 'Ctrl+Shift+G' },
    { id: 'debug', label: 'Run and Debug', icon: <Bug size={19} />, hint: 'Ctrl+Shift+D' },
    { id: 'ledger', label: 'Ledger', icon: <ShieldCheck size={19} />, hint: 'Verified change history', badge: changelogCount || undefined, badgeTone: 'info' },
    { id: 'team', label: 'Team', icon: <Users size={19} />, hint: 'Peers & chat', badge: teamUnread || undefined, badgeTone: 'info' },
    { id: 'problems', label: 'Problems', icon: <AlertTriangle size={19} />, hint: 'Ctrl+Shift+M', badge: problemCount || undefined, badgeTone: 'error' },
  ]

  return (
    <nav className="activitybar" aria-label="Primary">
      {items.map((item) => {
        const selected = sidebarVisible && sidebarView === item.id
        return (
          <button
            key={item.id}
            type="button"
            className="activity-item"
            aria-selected={selected}
            aria-label={`${item.label} (${item.hint})`}
            title={`${item.label} — ${item.hint}`}
            onClick={() => toggleSidebarView(item.id)}
          >
            {item.icon}
            {item.badge !== undefined && item.badge > 0 && (
              <span
                className="activity-badge"
                style={item.badgeTone === 'info'
                  ? { background: 'var(--accent)', color: '#04121c' }
                  : undefined}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </button>
        )
      })}

      <div style={{ flex: 1 }} />

      <button
        type="button"
        className="activity-item"
        aria-selected={bottomVisible}
        aria-label="Toggle panel (Ctrl+`)"
        title="Terminal & panel — Ctrl+`"
        onClick={toggleBottom}
      >
        <PanelBottom size={19} />
      </button>
      <button
        type="button"
        className="activity-item"
        aria-label="Settings (Ctrl+,)"
        title="Settings — Ctrl+,"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={19} />
      </button>
    </nav>
  )
}
