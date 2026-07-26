import MonacoEditor from '@monaco-editor/react'
import { X, Save, ArrowLeftRight } from 'lucide-react'
import { useAppStore } from '../../store/appStore'
import { useSettings, monacoOptionsFrom } from '../../store/settingsStore'
import { getFileLanguage, basename } from '../../lib/utils'

/**
 * The secondary editor pane.
 *
 * Edits go straight into the shared `tabCache`, so the split pane and the main
 * editor are two views over one buffer set rather than two copies: opening the
 * same file in both keeps them in sync, and either pane can save.
 *
 * Monaco is given a `split://` model path so it allocates a distinct model from
 * the primary editor — without that, both panes would share one model and fight
 * over the view state (cursor, scroll, folding).
 */
export function SplitPane() {
  const { splitFile, tabCache, setTabContent, saveTab, setSplitFile, openFile } = useAppStore()
  const settings = useSettings()

  if (!splitFile) return null
  const buf = tabCache[splitFile]
  if (!buf) return null

  const dirty = buf.content !== buf.savedContent

  return (
    <section className="split-pane" aria-label={`Split editor: ${basename(splitFile)}`}>
      <header className="split-head">
        <span className="split-name truncate" title={splitFile}>{basename(splitFile)}</span>
        {dirty && <span className="tab-dirty" title="Unsaved changes" />}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => { openFile(splitFile); setSplitFile(null) }}
          title="Open in the main editor"
          aria-label="Open in the main editor"
        >
          <ArrowLeftRight size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => saveTab(splitFile)}
          disabled={!dirty}
          title="Save (Ctrl+S saves the focused editor)"
          aria-label="Save split file"
        >
          <Save size={14} />
        </button>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => setSplitFile(null)}
          title="Close split"
          aria-label="Close split"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 min-h-0">
        <MonacoEditor
          path={`split://${splitFile}`}
          height="100%"
          language={buf.isBinary ? 'plaintext' : getFileLanguage(splitFile)}
          value={buf.content}
          onChange={(val) => setTabContent(splitFile, val ?? '')}
          theme="vs-dark"
          options={{
            ...monacoOptionsFrom(settings),
            readOnly: buf.isBinary,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            padding: { top: 10, bottom: 10 },
          }}
        />
      </div>
    </section>
  )
}
