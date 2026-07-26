import { useState } from 'react'
import { ChevronRight, PanelRightOpen, Columns2 } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useLayoutStore } from '../../store/layoutStore'
import { EditorCard } from '../Orbital/EditorCard'
import { SplitPane } from './SplitPane'
import { Resizer } from './Resizer'

/**
 * The editor region: breadcrumbs over the tabbed Monaco surface.
 *
 * EditorCard keeps ownership of tabs, Monaco, LSP wiring, CRDT binding, and
 * save — this component adds the path context above it and the affordance to
 * bring the AI panel back when it's hidden.
 */
export function EditorArea() {
  const activeFile = useAppStore((s) => s.activeFile)
  const openFile = useAppStore((s) => s.openFile)
  const splitFile = useAppStore((s) => s.splitFile)
  const setSplitFile = useAppStore((s) => s.setSplitFile)
  const { aiVisible, showAi } = useLayoutStore()

  // Split width is local: it's a within-editor arrangement, not workspace
  // furniture, and shouldn't survive as global persisted layout state.
  const [splitWidth, setSplitWidth] = useState(460)

  const segments = activeFile ? activeFile.split('/').filter(Boolean) : []

  return (
    <div className="editor-area">
      {activeFile && (
        <nav className="breadcrumbs" aria-label="File path">
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1
            return (
              <span key={`${seg}-${i}`} className="flex items-center gap-1 min-w-0">
                {i > 0 && <ChevronRight size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />}
                {isLast ? (
                  <span className="breadcrumb-item truncate" style={{ color: 'var(--text-secondary)' }}>{seg}</span>
                ) : (
                  <button
                    className="breadcrumb-item truncate"
                    onClick={() => openFile(segments.slice(0, i + 1).join('/'))}
                    title={segments.slice(0, i + 1).join('/')}
                  >
                    {seg}
                  </button>
                )}
              </span>
            )
          })}

          <span style={{ flex: 1 }} />

          <button
            className="btn btn-ghost btn-icon"
            style={{ height: 22, width: 22 }}
            onClick={() => setSplitFile(splitFile ? null : activeFile)}
            title={splitFile ? 'Close split' : 'Split editor right'}
            aria-label={splitFile ? 'Close split' : 'Split editor right'}
            aria-pressed={Boolean(splitFile)}
          >
            <Columns2 size={14} style={splitFile ? { color: 'var(--accent)' } : undefined} />
          </button>

          {!aiVisible && (
            <button
              className="btn btn-ghost btn-icon"
              style={{ height: 22, width: 22 }}
              onClick={showAi}
              title="Show AI panel (Ctrl+Shift+A)"
              aria-label="Show AI panel"
            >
              <PanelRightOpen size={14} />
            </button>
          )}
        </nav>
      )}

      {/* Primary editor and split share the row; the split keeps a fixed width
          so resizing the window grows the file you're focused on. */}
      <div className="editor-row">
        <div className="flex-1 min-w-0 flex flex-col">
          <EditorCard />
        </div>

        {splitFile && (
          <>
            <Resizer
              orientation="vertical"
              size={splitWidth}
              onResize={setSplitWidth}
              invert
              label="Resize split editor"
              min={280}
              max={900}
            />
            <div style={{ width: splitWidth, flexShrink: 0, minWidth: 0, display: 'flex' }}>
              <SplitPane />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
