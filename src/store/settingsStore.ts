import { create } from 'zustand'

/**
 * settingsStore — user preferences that shape the editor surface.
 *
 * Persisted as one JSON blob so adding a preference never needs a migration,
 * and every value has a defined default: a corrupt or partial stored object can
 * only ever fall back, never produce `undefined` inside Monaco's options.
 */
export interface Settings {
  // Editor
  fontSize: number
  lineHeight: number
  tabSize: number
  insertSpaces: boolean
  wordWrap: boolean
  minimap: boolean
  lineNumbers: boolean
  fontLigatures: boolean
  renderWhitespace: 'none' | 'boundary' | 'all'
  bracketPairColorization: boolean
  cursorBlinking: 'blink' | 'smooth' | 'phase' | 'solid'
  smoothScrolling: boolean
  stickyScroll: boolean
  formatOnSave: boolean
  vimMode: boolean

  // AI
  inlineCompletion: boolean
  inlineCompletionDelayMs: number
  aiAutoContext: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  lineHeight: 1.6,
  tabSize: 2,
  insertSpaces: true,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  fontLigatures: true,
  renderWhitespace: 'boundary',
  bracketPairColorization: true,
  cursorBlinking: 'smooth',
  smoothScrolling: true,
  stickyScroll: true,
  formatOnSave: false,
  vimMode: false,

  inlineCompletion: true,
  inlineCompletionDelayMs: 350,
  aiAutoContext: true,
}

const LS_SETTINGS = '0g_settings'

function load(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

interface SettingsState extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  reset: () => void
}

export const useSettings = create<SettingsState>((setState, get) => {
  const persist = () => {
    const { set: _s, reset: _r, ...values } = get()
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(values)) } catch { /* quota */ }
  }
  return {
    ...load(),
    set: (key, value) => { setState({ [key]: value } as never); persist() },
    reset: () => { setState({ ...DEFAULT_SETTINGS }); persist() },
  }
})

/** Map preferences onto Monaco's option shape — one place, so the editor and
 *  any future preview surface can never drift apart. */
export function monacoOptionsFrom(s: Settings) {
  return {
    fontSize: s.fontSize,
    lineHeight: Math.round(s.fontSize * s.lineHeight),
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    wordWrap: (s.wordWrap ? 'on' : 'off') as 'on' | 'off',
    minimap: { enabled: s.minimap },
    lineNumbers: (s.lineNumbers ? 'on' : 'off') as 'on' | 'off',
    fontLigatures: s.fontLigatures,
    renderWhitespace: s.renderWhitespace,
    bracketPairColorization: { enabled: s.bracketPairColorization },
    cursorBlinking: s.cursorBlinking,
    smoothScrolling: s.smoothScrolling,
    stickyScroll: { enabled: s.stickyScroll },
  }
}
