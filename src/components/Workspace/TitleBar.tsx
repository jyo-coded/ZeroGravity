import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X, Search } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { followPeer } from '../../lib/crdt'

/**
 * Window chrome.
 *
 * The window is undecorated, so this bar owns close/minimize/maximize. Controls
 * sit right on Windows, matching the platform the product ships on — the
 * previous macOS traffic lights were a costume on a Windows app.
 *
 * The centre hosts a command-palette affordance rather than a static title:
 * that strip is the most valuable real estate in the window, and a title
 * repeats what the project already says elsewhere.
 */
export function TitleBar() {
  const { project, collaborators, setQuickOpen } = useAppStore()
  const online = collaborators.filter((c) => c.status !== 'offline')
  const win = getCurrentWindow()

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="titlebar-brand">0G</span>

      {/* Centre: the omnibox. Named for what it does, with its shortcut shown. */}
      <button
        className="flex items-center gap-2 mx-auto"
        onClick={() => setQuickOpen('files')}
        title="Search files and commands"
        style={{
          height: 22,
          minWidth: 280,
          maxWidth: 420,
          padding: '0 var(--space-5)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-raised)',
          border: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontSize: 'var(--text-xs)',
        }}
      >
        <Search size={12} />
        <span className="truncate">{project?.name ?? 'No project'}</span>
        <span style={{ flex: 1 }} />
        <span className="kbd" style={{ height: 15 }}>Ctrl</span>
        <span className="kbd" style={{ height: 15 }}>P</span>
      </button>

      {/* Presence: click a peer to follow their cursor. */}
      {online.length > 0 && (
        <div className="flex items-center" style={{ marginRight: 'var(--space-2)' }}>
          {online.slice(0, 4).map((peer, i) => (
            <button
              key={peer.id}
              onClick={() => { if (!peer.is_self) followPeer(peer.id) }}
              title={peer.is_self ? `${peer.username} (you)` : `Follow ${peer.username}`}
              style={{
                width: 22, height: 22, marginLeft: i ? -6 : 0,
                borderRadius: 'var(--radius-pill)',
                background: peer.avatar_color,
                border: '2px solid var(--bg-surface)',
                color: '#04121c',
                fontSize: 'var(--text-2xs)',
                fontWeight: 'var(--weight-semibold)',
                display: 'grid', placeItems: 'center',
              }}
            >
              {peer.username.slice(0, 2).toUpperCase()}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center" style={{ marginLeft: online.length ? 0 : 'auto' }}>
        <button className="window-control" onClick={() => win.minimize()} aria-label="Minimize" title="Minimize">
          <Minus size={15} />
        </button>
        <button className="window-control" onClick={() => win.toggleMaximize()} aria-label="Maximize" title="Maximize">
          <Square size={12} />
        </button>
        <button className="window-control is-close" onClick={() => win.close()} aria-label="Close" title="Close">
          <X size={15} />
        </button>
      </div>
    </header>
  )
}
