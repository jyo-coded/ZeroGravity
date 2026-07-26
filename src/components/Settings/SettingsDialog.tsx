import { useEffect, useState } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { useSettings, type Settings } from '../../store/settingsStore'
import { useAppStore } from '../../store/appStore'

type Section = 'editor' | 'ai' | 'keys' | 'project'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'ai', label: 'AI' },
  { id: 'keys', label: 'Keyboard' },
  { id: 'project', label: 'Project' },
]

/**
 * Settings.
 *
 * Every control here writes through to a real preference that changes behaviour
 * immediately — there are no decorative toggles. Grouped by the thing being
 * configured rather than by widget type, and each row states what it does in the
 * product's own words instead of restating its own label.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>('editor')
  const s = useSettings()
  const { autoSave, setAutoSave, trimOnSave, setTrimOnSave, project } = useAppStore()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay-scrim" onClick={onClose} role="presentation">
      <div
        className="overlay-surface settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>Settings</h2>
          <span style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => s.reset()} title="Restore defaults">
            <RotateCcw size={13} /> Restore defaults
          </button>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close settings">
            <X size={15} />
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                className="list-row"
                aria-selected={section === sec.id}
                onClick={() => setSection(sec.id)}
                style={{ height: 30, borderRadius: 'var(--radius-md)' }}
              >
                {sec.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {section === 'editor' && (
              <>
                <Row label="Font size" hint="Applies to the code surface.">
                  <Num value={s.fontSize} min={10} max={28} onChange={(v) => s.set('fontSize', v)} suffix="px" />
                </Row>
                <Row label="Line height" hint="Multiplier of the font size.">
                  <Num value={s.lineHeight} min={1} max={2.4} step={0.1} onChange={(v) => s.set('lineHeight', v)} />
                </Row>
                <Row label="Tab size" hint="Columns per indent level.">
                  <Num value={s.tabSize} min={1} max={8} onChange={(v) => s.set('tabSize', v)} />
                </Row>
                <Row label="Insert spaces" hint="Indent with spaces instead of tab characters.">
                  <Toggle on={s.insertSpaces} onChange={(v) => s.set('insertSpaces', v)} label="Insert spaces" />
                </Row>
                <Row label="Word wrap" hint="Wrap long lines instead of scrolling sideways.">
                  <Toggle on={s.wordWrap} onChange={(v) => s.set('wordWrap', v)} label="Word wrap" />
                </Row>
                <Row label="Minimap" hint="Document overview down the right edge.">
                  <Toggle on={s.minimap} onChange={(v) => s.set('minimap', v)} label="Minimap" />
                </Row>
                <Row label="Line numbers">
                  <Toggle on={s.lineNumbers} onChange={(v) => s.set('lineNumbers', v)} label="Line numbers" />
                </Row>
                <Row label="Sticky scroll" hint="Pin the enclosing scope to the top while scrolling.">
                  <Toggle on={s.stickyScroll} onChange={(v) => s.set('stickyScroll', v)} label="Sticky scroll" />
                </Row>
                <Row label="Font ligatures" hint="Combine sequences like => into one glyph.">
                  <Toggle on={s.fontLigatures} onChange={(v) => s.set('fontLigatures', v)} label="Font ligatures" />
                </Row>
                <Row label="Bracket pair colours">
                  <Toggle on={s.bracketPairColorization} onChange={(v) => s.set('bracketPairColorization', v)} label="Bracket pair colours" />
                </Row>
                <Row label="Whitespace" hint="Where to render whitespace marks.">
                  <Select
                    value={s.renderWhitespace}
                    options={[['none', 'None'], ['boundary', 'Boundary'], ['all', 'All']]}
                    onChange={(v) => s.set('renderWhitespace', v as Settings['renderWhitespace'])}
                  />
                </Row>
                <Row label="Cursor">
                  <Select
                    value={s.cursorBlinking}
                    options={[['blink', 'Blink'], ['smooth', 'Smooth'], ['phase', 'Phase'], ['solid', 'Solid']]}
                    onChange={(v) => s.set('cursorBlinking', v as Settings['cursorBlinking'])}
                  />
                </Row>

                <Row label="Vim mode" hint="Modal editing with vim keybindings. Esc returns to normal mode.">
                  <Toggle on={s.vimMode} onChange={(v) => s.set('vimMode', v)} label="Vim mode" />
                </Row>

                <Divider label="Saving" />
                <Row label="Auto save" hint="Save automatically after you stop typing.">
                  <Select
                    value={autoSave}
                    options={[['off', 'Off'], ['idle', 'After a pause']]}
                    onChange={(v) => setAutoSave(v as 'off' | 'idle')}
                  />
                </Row>
                <Row label="Trim trailing whitespace" hint="Applied on save.">
                  <Toggle on={trimOnSave} onChange={setTrimOnSave} label="Trim trailing whitespace" />
                </Row>
              </>
            )}

            {section === 'ai' && (
              <>
                <Row label="Inline completion" hint="Suggest the rest of the line as you type. Accept with Tab.">
                  <Toggle on={s.inlineCompletion} onChange={(v) => s.set('inlineCompletion', v)} label="Inline completion" />
                </Row>
                <Row label="Suggestion delay" hint="How long to wait after a keystroke before asking the model.">
                  <Num
                    value={s.inlineCompletionDelayMs}
                    min={100} max={1500} step={50}
                    onChange={(v) => s.set('inlineCompletionDelayMs', v)}
                    suffix="ms"
                  />
                </Row>
                <Row label="Automatic context" hint="Include the open file and related files from the code graph in prompts.">
                  <Toggle on={s.aiAutoContext} onChange={(v) => s.set('aiAutoContext', v)} label="Automatic context" />
                </Row>
                <p className="settings-note">
                  Models and API keys are managed from the model selector in the AI panel header. Keys stay on
                  this machine and are only sent to the provider you choose.
                </p>
              </>
            )}

            {section === 'keys' && (
              <div className="settings-keys">
                {[
                  ['Command palette', 'Ctrl', 'Shift', 'P'],
                  ['Go to file', 'Ctrl', 'P'],
                  ['Toggle sidebar', 'Ctrl', 'B'],
                  ['Toggle panel', 'Ctrl', 'J'],
                  ['Terminal', 'Ctrl', '`'],
                  ['Toggle AI panel', 'Ctrl', 'Shift', 'A'],
                  ['Explorer', 'Ctrl', 'Shift', 'E'],
                  ['Search', 'Ctrl', 'Shift', 'F'],
                  ['Source control', 'Ctrl', 'Shift', 'G'],
                  ['Problems', 'Ctrl', 'Shift', 'M'],
                  ['Save', 'Ctrl', 'S'],
                  ['Save all', 'Ctrl', 'K', 'S'],
                  ['Reopen closed tab', 'Ctrl', 'Shift', 'T'],
                  ['Zen mode', 'Ctrl', 'Alt', 'Z'],
                ].map(([label, ...keys]) => (
                  <div key={label} className="settings-key-row">
                    <span>{label}</span>
                    <span className="flex items-center gap-1">
                      {keys.map((k) => <span key={k} className="kbd">{k}</span>)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {section === 'project' && (
              <>
                <Row label="Project"><span className="settings-value">{project?.name ?? '—'}</span></Row>
                <Row label="Location"><span className="settings-value settings-mono">{project?.root_path ?? '—'}</span></Row>
                <Row label="Invite code" hint="Share with a peer to collaborate directly, with no server in between.">
                  <span className="settings-value settings-mono">{project?.invite_code ?? '—'}</span>
                </Row>
                <p className="settings-note">
                  Changes are recorded in an encrypted ledger in this project&apos;s <code>.0g</code> directory. The
                  passphrase is never stored on disk in plaintext, and the ledger cannot be read without it.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Row primitives ─────────────────────────────────────────────────────── */

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="min-w-0">
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Divider({ label }: { label: string }) {
  return <div className="settings-divider">{label}</div>
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="settings-switch"
      data-on={on}
    >
      <span className="settings-switch-knob" />
    </button>
  )
}

function Num({ value, min, max, step = 1, suffix, onChange }: {
  value: number; min: number; max: number; step?: number; suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <span className="flex items-center gap-2">
      <input
        type="number"
        className="input"
        style={{ width: 76 }}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)))
        }}
      />
      {suffix && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{suffix}</span>}
    </span>
  )
}

function Select({ value, options, onChange }: {
  value: string; options: [string, string][]; onChange: (v: string) => void
}) {
  return (
    <select className="input" style={{ width: 150 }} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}
