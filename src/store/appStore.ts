import { create } from 'zustand'
import type {
  AppView,
  ChangelogEntry,
  Collaborator,
  FileNode,
  ModelConfig,
  Notification,
  Project,
  UserIdentity,
  WorkspaceView,
} from '../lib/types'
import * as api from '../lib/api'
import { getFileLanguage, basename } from '../lib/utils'

// ─── Persistence helpers ───────────────────────────────────────────────────────
const LS_IDENTITY = '0g_identity'
const LS_MODEL    = '0g_model'
const LS_PROJECT  = '0g_project'
const LS_PROJECT_PASSPHRASE = '0g_project_passphrase'

function loadLS<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null }
  catch { return null }
}
function saveLS(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch {}
}
function clearLS(key: string) {
  try { localStorage.removeItem(key) } catch {}
}

interface AppState {
  view: AppView
  setView: (view: AppView) => void

  identity: UserIdentity | null
  setIdentity: (identity: UserIdentity) => Promise<void>

  modelConfig: ModelConfig | null
  setModelConfig: (config: ModelConfig) => Promise<void>
  syncBackendState: () => Promise<void>
  rotationList: ModelConfig[]
  setRotationList: (list: ModelConfig[]) => Promise<void>

  project: Project | null
  projectPassphrase: string | null
  initProject: (name: string, passphrase: string, rootPath: string) => Promise<void>
  joinProjectByCode: (code: string, passphrase: string, rootPath: string) => Promise<void>
  clearProject: () => void

  fileTree: FileNode[]
  loadFileTree: () => Promise<void>
  activeFile: string | null
  activeFileContent: string
  activeFileIsBinary: boolean
  openFile: (path: string) => Promise<void>
  closeActiveFile: () => void
  createFile: (path: string) => Promise<void>
  setActiveFileContent: (content: string) => void
  expandedDirs: Set<string>
  toggleDir: (path: string) => void

  // ─── Tabs (A1) ───────────────────────────────────────────────────────
  openTabs: string[]
  closedTabs: string[]
  tabCache: Record<string, TabBuf>
  closeTab: (path: string) => void
  closeOtherTabs: () => void
  closeSavedTabs: () => void
  closeAllTabs: () => void
  reopenClosedTab: () => Promise<void>
  saveAll: () => Promise<void>

  // ─── Split editor (#3) ───────────────────────────────────────────────
  splitFile: string | null
  setSplitFile: (path: string | null) => Promise<void>
  setTabContent: (path: string, content: string) => void
  saveTab: (path: string) => Promise<void>

  // ─── File operations (A1) ────────────────────────────────────────────
  renameFsPath: (from: string, to: string) => Promise<void>
  deleteFsPath: (path: string) => Promise<void>
  duplicateFile: (path: string) => Promise<void>
  createFolder: (path: string) => Promise<void>
  copyPath: (path: string, relative: boolean) => Promise<void>
  revealInExplorer: (path: string) => Promise<void>
  lastDeleteEntryIds: string[]
  undoLastDelete: () => Promise<void>

  // ─── Editor UX (A1) ──────────────────────────────────────────────────
  explorerOpen: boolean
  toggleExplorer: () => void
  explorerCreateRequest: { dir: string; kind: 'file' | 'folder' } | null
  requestExplorerCreate: (kind: 'file' | 'folder', dir?: string) => void
  clearExplorerCreateRequest: () => void
  autoSave: 'off' | 'idle'
  setAutoSave: (mode: 'off' | 'idle') => void
  trimOnSave: boolean
  setTrimOnSave: (on: boolean) => void

  // ─── Navigation (A3) ─────────────────────────────────────────────────
  recentFiles: string[]
  setOpenTabs: (tabs: string[]) => void
  quickOpenMode: 'files' | 'symbols' | 'commands' | null
  setQuickOpen: (mode: 'files' | 'symbols' | 'commands' | null) => void
  searchOpen: boolean
  toggleSearch: () => void
  pendingReveal: { path: string; line: number; col: number } | null
  openFileAtLine: (path: string, line: number, col?: number) => Promise<void>
  clearPendingReveal: () => void
  workspaceView: WorkspaceView
  setWorkspaceView: (v: WorkspaceView) => void

  // ─── LSP problems (A4) ───────────────────────────────────────────────
  problems: Record<string, ProblemItem[]>
  setProblems: (path: string, items: ProblemItem[]) => void
  problemsOpen: boolean
  toggleProblems: () => void

  // ─── Orbital UI v2: floating glass card windows ──────────────────────
  orbitalCards: Record<string, OrbitalCardState>
  zTop: number
  openOrbitalCard: (id: string, defaults?: Partial<OrbitalCardState>) => void
  closeOrbitalCard: (id: string) => void
  focusOrbitalCard: (id: string) => void
  setOrbitalCardRect: (id: string, rect: Partial<Pick<OrbitalCardState, 'x' | 'y' | 'w' | 'h'>>) => void
  spherePos: { x: number; y: number } | null
  setSpherePos: (pos: { x: number; y: number }) => void

  // ─── Team chat (T1) ──────────────────────────────────────────────────
  teamChat: TeamChatMsg[]
  teamPanelOpen: boolean
  teamUnread: number
  toggleTeamPanel: () => void
  addTeamChat: (msg: TeamChatMsg) => void
  sendTeamChat: (text: string) => Promise<void>

  // ─── Git awareness (A6) ──────────────────────────────────────────────
  gitBranch: string | null
  gitModified: string[]
  gitUntracked: string[]
  loadGitStatus: () => Promise<void>

  changelog: ChangelogEntry[]
  loadChangelog: () => Promise<void>
  addChangelogEntry: (entry: ChangelogEntry) => void
  changelogFilter: { file?: string; user?: string }
  setChangelogFilter: (filter: { file?: string; user?: string }) => void

  collaborators: Collaborator[]
  selfAsCollaborator: () => void
  addCollaborator: (c: Collaborator) => void
  removeCollaborator: (id: string) => void
  updateCollaboratorStatus: (id: string, status: string, currentFile?: string) => void
  applyRemoteEntry: (entry: ChangelogEntry) => Promise<void>

  isAiWriting: boolean
  streamingText: string | null
  cancelAi: () => Promise<void>
  invokeAi: (prompt: string, attachedImage?: { base64: string; mimeType: string }) => Promise<void>
  chatHistory: ChatMessage[]
  addChatMessage: (msg: Omit<ChatMessage, 'id'>) => void
  clearChatHistory: () => void
  applyCodeSnippet: (snippet: string, lang?: string) => Promise<void>
  saveFile: () => Promise<void>
  isDirty: boolean
  lastSavedContent: string
  
  lastApplyEntryId: string | null
  revertLastApply: () => Promise<void>
  revertEntry: (entryId: string) => Promise<void>
  revertRun: (sessionId: string) => Promise<void>

  notifications: Notification[]
  addNotification: (n: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void
  dismissNotification: (id: string) => void
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** One LSP diagnostic for the Problems panel */
export interface ProblemItem {
  line: number
  col: number
  severity: number // LSP: 1 error, 2 warning, 3 info, 4 hint
  message: string
  source: string
}

export interface TeamChatMsg {
  id: string
  username: string
  color: string
  text: string
  ts: string
  isSelf: boolean
}

/** Orbital UI v2 — one floating glass card window */
export interface OrbitalCardState {
  open: boolean
  x: number
  y: number
  w: number
  h: number
  z: number
}

/** Per-tab buffer cache — preserves unsaved edits across tab switches */
export interface TabBuf {
  content: string
  savedContent: string
  isBinary: boolean
}

const LS_AUTOSAVE = '0g_autosave'
const LS_TRIM = '0g_trim_on_save'
const LS_RECENT = '0g_recent_files'
const LS_ROTATION = '0g_rotation'

/** Strip trailing spaces/tabs from every line (and the file tail) */
function trimTrailingWs(s: string): string {
  return s.replace(/[ \t]+(?=\r?\n)/g, '').replace(/[ \t]+$/, '')
}

/** Minimal boilerplate applied on file creation, by extension */
const BOILERPLATE: Record<string, string> = {
  rs: '#![allow(dead_code)]\n\n',
  tsx: "export function Component() {\n  return null\n}\n",
  ts: '',
  py: 'def main():\n    pass\n\n\nif __name__ == "__main__":\n    main()\n',
  html: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <title></title>\n</head>\n<body>\n\n</body>\n</html>\n',
  json: '{}\n',
  md: '# \n',
}

export const useAppStore = create<AppState>((set, get) => {
  const savedIdentity = loadLS<UserIdentity>(LS_IDENTITY)
  const savedModel    = loadLS<ModelConfig>(LS_MODEL)
  const savedProject  = loadLS<Project>(LS_PROJECT)
  const savedProjectPassphrase = loadLS<string>(LS_PROJECT_PASSPHRASE)

  const initialView: AppView =
    !savedIdentity ? 'onboarding_identity'
    : !savedModel  ? 'onboarding_model'
    : !savedProject ? 'onboarding_project'
    : 'workspace'

  return {
    lastApplyEntryId: null,
    // ─── View ─────────────────────────────────────────────────────────────────
    view: initialView,
    setView: (view) => set({ view }),

    // ─── Identity ─────────────────────────────────────────────────────────────
    identity: savedIdentity,
    setIdentity: async (identity) => {
      saveLS(LS_IDENTITY, identity)
      set({ identity })
      try { await api.saveIdentity(identity) } catch {}
    },

    // ─── Model ────────────────────────────────────────────────────────────────
    modelConfig: savedModel,
    setModelConfig: async (config) => {
      saveLS(LS_MODEL, config)
      set({ modelConfig: config })
      try { await api.configureModel(config) } catch {}
    },

    rotationList: loadLS<ModelConfig[]>(LS_ROTATION) ?? [],
    setRotationList: async (list) => {
      saveLS(LS_ROTATION, list)
      set({ rotationList: list })
      try { await api.configureRotation(list) } catch {}
    },

    syncBackendState: async () => {
      const { identity, modelConfig, rotationList } = get()
      if (identity) {
        try { await api.saveIdentity(identity) } catch {}
      }
      if (modelConfig) {
        try { await api.configureModel(modelConfig) } catch {}
      }
      if (rotationList.length > 0) {
        try { await api.configureRotation(rotationList) } catch {}
      }
      // #5: re-seed today's usage counts (persisted in LS across restarts)
      const seeds = loadLS<[string, number, string][]>('0g_usage_days')
      if (seeds && seeds.length > 0) {
        try { await api.importUsage(seeds) } catch {}
      }
    },

    // ─── Project ──────────────────────────────────────────────────────────────
    project: savedProject,
    projectPassphrase: savedProjectPassphrase,

    initProject: async (name, passphrase, rootPath) => {
      const project = await api.createProject({ name, passphrase, root_path: rootPath })
      // Normalize project dates (Rust returns DateTime<Utc> as ISO string)
      const normalized: Project = {
        ...project,
        created_at: typeof (project as any).created_at === 'string'
          ? (project as any).created_at
          : new Date().toISOString(),
        invite_code: (project as any).inviteCode ?? (project as any).invite_code ?? '',
        root_path: (project as any).rootPath ?? (project as any).root_path ?? rootPath,
      }
      saveLS(LS_PROJECT, normalized)
      saveLS(LS_PROJECT_PASSPHRASE, passphrase)
      set({ project: normalized, projectPassphrase: passphrase, view: 'workspace' })
      // Add self as a collaborator entry
      get().selfAsCollaborator()
      await get().loadFileTree()
    },

    joinProjectByCode: async (code, passphrase, rootPath) => {
      const project = await api.joinProject({ invite_code: code, passphrase, root_path: rootPath })
      const normalized: Project = {
        ...project,
        created_at: typeof (project as any).created_at === 'string'
          ? (project as any).created_at
          : new Date().toISOString(),
        invite_code: (project as any).inviteCode ?? (project as any).invite_code ?? code,
        root_path: (project as any).rootPath ?? (project as any).root_path ?? rootPath,
      }
      saveLS(LS_PROJECT, normalized)
      saveLS(LS_PROJECT_PASSPHRASE, passphrase)
      set({ project: normalized, projectPassphrase: passphrase, view: 'workspace' })
      get().selfAsCollaborator()
      await get().loadFileTree()
    },

    clearProject: () => {
      clearLS(LS_PROJECT)
      clearLS(LS_PROJECT_PASSPHRASE)
      set({ project: null, projectPassphrase: null, fileTree: [], activeFile: null, activeFileContent: '', activeFileIsBinary: false, changelog: [], lastApplyEntryId: null, openTabs: [], closedTabs: [], tabCache: {}, lastDeleteEntryIds: [], teamChat: [], teamUnread: 0, problems: {} })
    },

    // ─── File System ──────────────────────────────────────────────────────────
    fileTree: [],
    activeFile: null,
    activeFileContent: '',
    activeFileIsBinary: false,
    expandedDirs: new Set<string>(),
    openTabs: [],
    closedTabs: [],
    tabCache: {},
    splitFile: null,
    lastDeleteEntryIds: [],
    explorerOpen: false,
    explorerCreateRequest: null,
    streamingText: null,
    autoSave: (loadLS<'off' | 'idle'>(LS_AUTOSAVE)) ?? 'off',
    trimOnSave: (loadLS<boolean>(LS_TRIM)) ?? false,
    recentFiles: loadLS<string[]>(LS_RECENT) ?? [],
    quickOpenMode: null,
    searchOpen: false,
    pendingReveal: null,
    workspaceView: 'canvas',
    problems: {},
    problemsOpen: false,
    teamChat: [],
    teamPanelOpen: false,
    teamUnread: 0,
    orbitalCards: {},
    zTop: 10,
    spherePos: null,
    gitBranch: null,
    gitModified: [],
    gitUntracked: [],

    loadFileTree: async () => {
      try {
        const tree = await api.getFileTree()
        // Auto-expand top-level directories, keep user-expanded ones
        const topDirs = tree.filter(n => n.is_dir).map(n => n.path)
        set((s) => ({ fileTree: tree, expandedDirs: new Set([...s.expandedDirs, ...topDirs]) }))
      } catch (e) {
        console.warn('loadFileTree failed:', e)
        set({ fileTree: [] })
      }
      // Piggyback git refresh — loadFileTree is already the single
      // "something changed on disk" choke point
      get().loadGitStatus()
    },

    loadGitStatus: async () => {
      try {
        const s = await api.gitStatus()
        set({
          gitBranch: s.is_repo ? (s.branch ?? null) : null,
          gitModified: s.modified ?? [],
          gitUntracked: s.untracked ?? [],
        })
      } catch {
        set({ gitBranch: null, gitModified: [], gitUntracked: [] })
      }
    },

    setWorkspaceView: (v) => set({ workspaceView: v }),

    setProblems: (path, items) =>
      set((s) => {
        const problems = { ...s.problems }
        if (items.length === 0) delete problems[path]
        else problems[path] = items
        return { problems }
      }),

    toggleProblems: () => set((s) => ({ problemsOpen: !s.problemsOpen })),

    // ─── Orbital UI v2: card windows ────────────────────────────────────────
    openOrbitalCard: (id, defaults) =>
      set((s) => {
        const existing = s.orbitalCards[id]
        const z = s.zTop + 1
        // Existing card just re-opens at its last position (user's own layout wins)
        if (existing) {
          return { orbitalCards: { ...s.orbitalCards, [id]: { ...existing, open: true, z } }, zTop: z }
        }
        // New card: cascade off the intended slot if it already collides
        // with another open card, so nothing ever spawns hidden underneath.
        let x = defaults?.x ?? 200
        let y = defaults?.y ?? 120
        const w = defaults?.w ?? 320
        const h = defaults?.h ?? 320
        const openCards = Object.values(s.orbitalCards).filter((c) => c.open)
        const collides = (cx: number, cy: number) =>
          openCards.some((c) => Math.abs(c.x - cx) < 36 && Math.abs(c.y - cy) < 36)
        let tries = 0
        while (collides(x, y) && tries < 12) {
          x += 28; y += 24; tries += 1
        }
        // Clamp inside the viewport so cascades don't wander off-screen
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
        const vh = typeof window !== 'undefined' ? window.innerHeight : 720
        x = Math.min(Math.max(x, 12), Math.max(12, vw - w - 12))
        y = Math.min(Math.max(y, 44), Math.max(44, vh - h - 12))
        return { orbitalCards: { ...s.orbitalCards, [id]: { open: true, x, y, w, h, z } }, zTop: z }
      }),

    closeOrbitalCard: (id) =>
      set((s) => {
        const existing = s.orbitalCards[id]
        if (!existing) return s
        return { orbitalCards: { ...s.orbitalCards, [id]: { ...existing, open: false } } }
      }),

    focusOrbitalCard: (id) =>
      set((s) => {
        const existing = s.orbitalCards[id]
        if (!existing || existing.z === s.zTop) return s
        const z = s.zTop + 1
        return { orbitalCards: { ...s.orbitalCards, [id]: { ...existing, z } }, zTop: z }
      }),

    setOrbitalCardRect: (id, rect) =>
      set((s) => {
        const existing = s.orbitalCards[id]
        if (!existing) return s
        return { orbitalCards: { ...s.orbitalCards, [id]: { ...existing, ...rect } } }
      }),

    setSpherePos: (pos) => set({ spherePos: pos }),

    // ─── Team chat (T1) ─────────────────────────────────────────────────────
    toggleTeamPanel: () => set((s) => ({ teamPanelOpen: !s.teamPanelOpen, teamUnread: s.teamPanelOpen ? s.teamUnread : 0 })),

    addTeamChat: (msg) =>
      set((s) => ({
        teamChat: [...s.teamChat, msg].slice(-200),
        teamUnread: s.teamPanelOpen || msg.isSelf ? 0 : s.teamUnread + 1,
      })),

    sendTeamChat: async (text) => {
      const t = text.trim()
      if (!t) return
      const { identity, addTeamChat } = get()
      const name = identity?.username ?? 'Me'
      const color = identity?.avatar_color ?? '#00C8FF'
      const ts = new Date().toISOString()
      addTeamChat({ id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, username: name, color, text: t, ts, isSelf: true })
      try { await api.sendChat(name, color, t, ts) } catch {}
    },

    openFile: async (path) => {
      const { openTabs, tabCache } = get()
      const tabs = openTabs.includes(path) ? openTabs : [...openTabs, path]

      // Track recently opened (deduped, newest first, cap 20)
      const recent = [path, ...get().recentFiles.filter((r) => r !== path)].slice(0, 20)
      saveLS(LS_RECENT, recent)
      set({ recentFiles: recent })

      // Broadcast to peers that we've opened this file
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('broadcast_peer_status', { status: 'idle', currentFile: path })
      } catch { /* network may not be started yet */ }

      // Dirty cached buffer → activate from cache, don't clobber edits with disk state
      const cached = tabCache[path]
      if (cached && cached.content !== cached.savedContent) {
        set({
          openTabs: tabs,
          activeFile: path,
          activeFileContent: cached.content,
          activeFileIsBinary: cached.isBinary,
          lastSavedContent: cached.savedContent,
          isDirty: true,
          lastApplyEntryId: null,
        })
        return
      }

      set({ openTabs: tabs, activeFile: path, isDirty: false, lastApplyEntryId: null })
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await api.openFile(path) as any
        const content: string = raw?.content ?? ''
        const isBinary = Boolean(raw?.is_binary)
        const entries: ChangelogEntry[] = (raw?.entries ?? []).map(normalizeEntry)
        // Set lastSavedContent so Monaco onChange can tell real edits from programmatic updates
        set((s) => ({
          activeFileContent: content,
          activeFileIsBinary: isBinary,
          lastSavedContent: content,
          isDirty: false,
          tabCache: { ...s.tabCache, [path]: { content, savedContent: content, isBinary } },
        }))
        if (entries.length > 0) {
          set({ changelog: entries })
        }
      } catch (e) {
        console.warn('openFile error:', e)
        set({ activeFileContent: `# Could not read: ${path}\n# ${String(e)}\n`, activeFileIsBinary: false })
      }
    },

    closeActiveFile: () => {
      const { activeFile } = get()
      if (activeFile) get().closeTab(activeFile)
    },

    // ─── Tabs ───────────────────────────────────────────────────────────────
    closeTab: (path) => {
      const { openTabs, activeFile, tabCache, closedTabs } = get()
      const buf = tabCache[path]
      if (buf && !buf.isBinary && buf.content !== buf.savedContent) {
        if (!window.confirm(`Discard unsaved changes in ${path}?`)) return
      }
      const idx = openTabs.indexOf(path)
      const tabs = openTabs.filter((t) => t !== path)
      const cache = { ...tabCache }
      delete cache[path]
      set((s) => ({
        openTabs: tabs,
        tabCache: cache,
        closedTabs: [path, ...closedTabs.filter((t) => t !== path)].slice(0, 10),
        ...(s.splitFile === path ? { splitFile: null } : {}),
      }))
      if (activeFile === path) {
        const next = tabs[Math.min(Math.max(idx, 0), tabs.length - 1)] ?? null
        if (next) {
          get().openFile(next)
        } else {
          set({
            activeFile: null, activeFileContent: '', activeFileIsBinary: false,
            isDirty: false, lastSavedContent: '', lastApplyEntryId: null,
          })
        }
      }
    },

    closeOtherTabs: () => {
      const { openTabs, activeFile } = get()
      for (const t of [...openTabs]) {
        if (t !== activeFile) get().closeTab(t)
      }
    },

    closeSavedTabs: () => {
      const { openTabs, tabCache, activeFile } = get()
      for (const t of [...openTabs]) {
        const buf = tabCache[t]
        const dirty = buf && !buf.isBinary && buf.content !== buf.savedContent
        if (!dirty && t !== activeFile) get().closeTab(t)
      }
    },

    closeAllTabs: () => {
      const { openTabs } = get()
      for (const t of [...openTabs]) get().closeTab(t)
    },

    reopenClosedTab: async () => {
      const { closedTabs } = get()
      const [last, ...rest] = closedTabs
      if (!last) return
      set({ closedTabs: rest })
      await get().openFile(last)
    },

    // ─── Split editor (#3) ──────────────────────────────────────────────────
    setSplitFile: async (path) => {
      if (!path) {
        set({ splitFile: null })
        return
      }
      // Ensure the buffer is cached so the right pane has content
      if (!get().tabCache[path]) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = await api.openFile(path) as any
          const content: string = raw?.content ?? ''
          set((s) => ({
            tabCache: {
              ...s.tabCache,
              [path]: { content, savedContent: content, isBinary: Boolean(raw?.is_binary) },
            },
          }))
        } catch {
          get().addNotification({ type: 'error', detail: 'Split Failed', message: `Could not read ${path}` })
          return
        }
      }
      set((s) => ({
        splitFile: path,
        openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
      }))
    },

    setTabContent: (path, content) => {
      set((s) => {
        const buf = s.tabCache[path]
        if (!buf || buf.isBinary || buf.content === content) return s
        return {
          tabCache: { ...s.tabCache, [path]: { ...buf, content } },
          // Keep the main editor mirror in sync when both panes show one file
          ...(s.activeFile === path
            ? { activeFileContent: content, isDirty: content !== buf.savedContent }
            : {}),
        }
      })
    },

    saveTab: async (path) => {
      const { tabCache, trimOnSave, addChangelogEntry, addNotification, loadFileTree } = get()
      const buf = tabCache[path]
      if (!buf || buf.isBinary) return
      const content = trimOnSave ? trimTrailingWs(buf.content) : buf.content
      try {
        const entry = await api.commitWrite({
          file: path, content, summary: 'Manual save',
          affected_lines: [], affected_functions: [],
        })
        addChangelogEntry(entry)
        set((s) => ({
          tabCache: { ...s.tabCache, [path]: { ...buf, content, savedContent: content } },
          ...(s.activeFile === path
            ? { isDirty: false, activeFileContent: content, lastSavedContent: content }
            : {}),
        }))
        await loadFileTree()
        addNotification({ type: 'change', detail: 'Saved', message: `${path} saved to disk` })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Save Failed', message: e.toString() })
      }
    },

    saveAll: async () => {
      const { tabCache, trimOnSave, addChangelogEntry, addNotification, loadFileTree } = get()
      const dirty = Object.entries(tabCache).filter(
        ([, b]) => !b.isBinary && b.content !== b.savedContent
      )
      if (dirty.length === 0) return
      let saved = 0
      for (const [path, buf] of dirty) {
        try {
          const content = trimOnSave ? trimTrailingWs(buf.content) : buf.content
          const entry = await api.commitWrite({
            file: path, content, summary: 'Manual save (Save All)',
            affected_lines: [], affected_functions: [],
          })
          addChangelogEntry(entry)
          set((s) => ({
            tabCache: { ...s.tabCache, [path]: { ...buf, content, savedContent: content } },
            ...(s.activeFile === path ? { isDirty: false, activeFileContent: content, lastSavedContent: content } : {}),
          }))
          saved++
        } catch (e: any) {
          addNotification({ type: 'error', detail: 'Save All', message: `${path}: ${e}` })
        }
      }
      if (saved > 0) {
        await loadFileTree()
        addNotification({ type: 'change', detail: 'Save All', message: `Saved ${saved} file(s)` })
      }
    },

    // ─── File operations ────────────────────────────────────────────────────
    renameFsPath: async (from, to) => {
      const { addChangelogEntry, addNotification, loadFileTree } = get()
      try {
        const entry = normalizeEntry(await api.renamePath(from, to))
        addChangelogEntry(entry)
        // Remap tabs / cache / activeFile (exact match or directory prefix)
        const remap = (p: string) =>
          p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p
        set((s) => {
          const cache: Record<string, TabBuf> = {}
          for (const [k, v] of Object.entries(s.tabCache)) cache[remap(k)] = v
          return {
            openTabs: s.openTabs.map(remap),
            closedTabs: s.closedTabs.map(remap),
            tabCache: cache,
            activeFile: s.activeFile ? remap(s.activeFile) : null,
          }
        })
        await loadFileTree()
        addNotification({ type: 'change', detail: 'Renamed', message: `${from} → ${to}` })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Rename Failed', message: e.toString() })
      }
    },

    deleteFsPath: async (path) => {
      const { addChangelogEntry, addNotification, loadFileTree } = get()
      try {
        const entries = (await api.deletePath(path)).map(normalizeEntry)
        entries.forEach(addChangelogEntry)
        set({
          lastDeleteEntryIds: entries.filter((e) => e.previous_content != null).map((e) => e.id),
        })
        // Close affected tabs without the discard-confirm (files are already gone)
        set((s) => {
          const gone = (p: string) => p === path || p.startsWith(path + '/')
          const cache = { ...s.tabCache }
          for (const k of Object.keys(cache)) if (gone(k)) delete cache[k]
          const tabs = s.openTabs.filter((t) => !gone(t))
          const activeGone = s.activeFile && gone(s.activeFile)
          return {
            openTabs: tabs,
            tabCache: cache,
            ...(s.splitFile && gone(s.splitFile) ? { splitFile: null } : {}),
            ...(activeGone ? {
              activeFile: null, activeFileContent: '', activeFileIsBinary: false,
              isDirty: false, lastSavedContent: '', lastApplyEntryId: null,
            } : {}),
          }
        })
        const { activeFile, openFile } = get()
        if (!activeFile && get().openTabs.length > 0) await openFile(get().openTabs[0])
        await loadFileTree()
        addNotification({ type: 'change', detail: 'Deleted', message: `${path} — undo available in Explorer` })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Delete Failed', message: e.toString() })
      }
    },

    undoLastDelete: async () => {
      const { lastDeleteEntryIds, revertEntry } = get()
      for (const id of lastDeleteEntryIds) {
        await revertEntry(id)
      }
      set({ lastDeleteEntryIds: [] })
    },

    duplicateFile: async (path) => {
      const { addChangelogEntry, addNotification, loadFileTree } = get()
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await api.openFile(path) as any
        if (raw?.is_binary) {
          addNotification({ type: 'error', detail: 'Duplicate Failed', message: 'Cannot duplicate a binary file' })
          return
        }
        const slash = path.lastIndexOf('/')
        const dot = path.lastIndexOf('.')
        const base = dot > slash ? path.slice(0, dot) : path
        const ext = dot > slash ? path.slice(dot) : ''
        const existing = new Set(flattenTree(get().fileTree).map((n) => n.path))
        let copy = `${base}_copy${ext}`
        let i = 2
        while (existing.has(copy)) copy = `${base}_copy${i++}${ext}`
        const entry = await api.commitWrite({
          file: copy, content: raw?.content ?? '', summary: `Duplicated from ${path}`,
          affected_lines: [], affected_functions: [],
        })
        addChangelogEntry(entry)
        await loadFileTree()
        await get().openFile(copy)
        addNotification({ type: 'change', detail: 'Duplicated', message: copy })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Duplicate Failed', message: e.toString() })
      }
    },

    createFolder: async (path) => {
      const { addNotification, loadFileTree } = get()
      const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized) return
      try {
        await api.createFolder(normalized)
        await loadFileTree()
        set((s) => ({ expandedDirs: new Set([...s.expandedDirs, normalized]) }))
        addNotification({ type: 'change', detail: 'Created Folder', message: normalized })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'New Folder Failed', message: e.toString() })
      }
    },

    copyPath: async (path, relative) => {
      const { project, addNotification } = get()
      const text = relative
        ? path
        : `${(project?.root_path ?? '').replace(/\\/g, '/')}/${path}`
      try {
        await navigator.clipboard.writeText(text)
        addNotification({ type: 'change', detail: 'Copied', message: text })
      } catch {
        addNotification({ type: 'error', detail: 'Copy Failed', message: 'Clipboard unavailable' })
      }
    },

    revealInExplorer: async (path) => {
      try { await api.revealInExplorer(path) } catch (e: any) {
        get().addNotification({ type: 'error', detail: 'Reveal Failed', message: e.toString() })
      }
    },

    // ─── Editor UX ──────────────────────────────────────────────────────────
    toggleExplorer: () => set((s) => ({ explorerOpen: !s.explorerOpen })),

    requestExplorerCreate: (kind, dir = '') =>
      set({ explorerOpen: true, explorerCreateRequest: { dir, kind } }),

    clearExplorerCreateRequest: () => set({ explorerCreateRequest: null }),

    cancelAi: async () => {
      try { await api.cancelAi() } catch {}
    },

    setAutoSave: (mode) => {
      saveLS(LS_AUTOSAVE, mode)
      set({ autoSave: mode })
    },

    setTrimOnSave: (on) => {
      saveLS(LS_TRIM, on)
      set({ trimOnSave: on })
    },

    // ─── Navigation (A3) ────────────────────────────────────────────────────
    setOpenTabs: (tabs) => set({ openTabs: tabs }),

    setQuickOpen: (mode) => set({ quickOpenMode: mode }),

    toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),

    openFileAtLine: async (path, line, col = 0) => {
      set({ pendingReveal: { path, line, col } })
      await get().openFile(path)
    },

    clearPendingReveal: () => set({ pendingReveal: null }),

    createFile: async (path) => {
      const { addChangelogEntry, addNotification, loadFileTree, openFile } = get()
      const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalized) return
      if (normalized.split('/').some((part) => part === '..' || part === '')) {
        addNotification({ type: 'error', detail: 'New File Failed', message: 'Use a relative file path inside the project' })
        return
      }

      try {
        const ext = normalized.split('.').pop()?.toLowerCase() ?? ''
        const entry = await api.createFile(normalized, BOILERPLATE[ext])
        addChangelogEntry(entry)
        await loadFileTree()
        await openFile(normalized)
        addNotification({ type: 'change', detail: 'Created File', message: normalized })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'New File Failed', message: e.toString() })
      }
    },

    setActiveFileContent: (activeFileContent) => {
      if (activeFileContent === get().activeFileContent) return
      // Only mark dirty if content actually changed from the last saved/loaded version
      const { lastSavedContent, activeFileIsBinary, activeFile } = get()
      if (activeFileIsBinary) return
      set((s) => ({
        activeFileContent,
        isDirty: activeFileContent !== lastSavedContent,
        lastApplyEntryId: null,
        // Mirror into the tab cache so switching tabs never loses edits
        tabCache: activeFile
          ? { ...s.tabCache, [activeFile]: { content: activeFileContent, savedContent: lastSavedContent, isBinary: false } }
          : s.tabCache,
      }))
    },

    toggleDir: (path) => {
      const dirs = new Set(get().expandedDirs)
      if (dirs.has(path)) dirs.delete(path)
      else dirs.add(path)
      set({ expandedDirs: dirs })
    },

    // ─── Changelog ────────────────────────────────────────────────────────────
    changelog: [],

    loadChangelog: async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = (await api.getChangelog({ limit: 50 }) as any[]).map(normalizeEntry)
        set({ changelog: entries })
      } catch {}
    },

    addChangelogEntry: (entry) =>
      set((s) => ({ changelog: [entry, ...s.changelog] })),

    changelogFilter: {},
    setChangelogFilter: (changelogFilter) => set({ changelogFilter }),

    // ─── Collaborators ────────────────────────────────────────────────────────
    collaborators: [],

    selfAsCollaborator: () => {
      const { identity } = get()
      if (!identity) return
      const self: Collaborator = {
        id: 'self',
        username: identity.username,
        avatar_color: identity.avatar_color,
        permission: 'owner',
        status: 'idle',
        is_self: true,
      }
      set({ collaborators: [self] })
    },

    addCollaborator: (c) =>
      set((s) => {
        if (s.collaborators.some((collab) => collab.id === c.id)) return s
        return { collaborators: [...s.collaborators, c] }
      }),

    removeCollaborator: (id) =>
      set((s) => ({ collaborators: s.collaborators.filter((c) => c.id !== id) })),

    updateCollaboratorStatus: (id, status, currentFile) =>
      set((s) => ({
        collaborators: s.collaborators.map((c) =>
          c.id === id ? { ...c, status: status as Collaborator['status'], current_file: currentFile } : c
        ),
      })),

    applyRemoteEntry: async (entry) => {
      const { activeFile, openFile, addChangelogEntry, loadFileTree, isDirty, addNotification } = get()

      // Metadata side is always safe: record the change + refresh the tree
      // (covers newly-created files from a peer).
      addChangelogEntry(entry)
      await loadFileTree()

      // The buffer side is where the P0-3 clobber lived. Only touch the editor
      // if the peer changed the file we're actively looking at — and even then,
      // never silently overwrite live or unsaved local work.
      if (activeFile !== entry.file) return

      // Live-CRDT-bound: the shared doc already keeps every peer's buffer in
      // sync keystroke-by-keystroke. Reloading from disk here would clobber the
      // live buffer AND re-broadcast a spurious full-file delta to everyone.
      // The CRDT layer owns this file — leave it alone.
      const { isBound } = await import('../lib/crdt')
      if (isBound(entry.file)) return

      // Not bound, but the local buffer has unsaved edits: a blind reload would
      // discard the user's own work. Surface a conflict instead of overwriting
      // (mirrors the external-file-change handler).
      if (isDirty) {
        addNotification({
          type: 'conflict',
          detail: 'Remote change',
          message: `${entry.changed_by} changed ${basename(entry.file)} — save to keep yours, or close the tab to take theirs`,
        })
        return
      }

      // Clean buffer, not bound — safe to reflect the peer's change.
      await openFile(entry.file)
    },

    // ─── AI & Chat ────────────────────────────────────────────────────────────
    chatHistory: [],
    isDirty: false,
    lastSavedContent: '',
    addChatMessage: (msg) => set((s) => ({
      chatHistory: [...s.chatHistory, { ...msg, id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}` }]
    })),

    clearChatHistory: () => set({ chatHistory: [] }),

    applyCodeSnippet: async (snippet: string, lang?: string) => {
      const { activeFile, activeFileContent, activeFileIsBinary, fileTree, addChangelogEntry, loadFileTree, openFile, addNotification, chatHistory } = get()

      // Start with the active file and its in-memory content (what the user sees in Monaco)
      let targetFile = activeFile
      let targetContent = activeFileContent

      // ── Smart target file resolution ─────────────────────────────────────
      // If the snippet language doesn't match the active file, scan chat history
      // for a referenced filename that DOES match and target that instead.
      if (lang && lang !== 'plaintext' && lang !== '') {
        const activeFileLang = getFileLanguage(targetFile ?? '')

        if (activeFileLang !== lang) {
          const langToExts: Record<string, string[]> = {
            python: ['.py'],
            typescript: ['.ts', '.tsx'],
            javascript: ['.js', '.jsx'],
            rust: ['.rs'],
            go: ['.go'],
            java: ['.java'],
            cpp: ['.cpp', '.cc', '.cxx'],
            shell: ['.sh', '.bash'],
            json: ['.json'],
          }
          const exts = langToExts[lang] ?? []

          const allText = chatHistory.map(m => m.content).join(' ')
          const allFiles = flattenTree(fileTree)

          const chatMatch = allFiles.find(
            (f) => !f.is_dir && exts.some(ext => f.path.endsWith(ext)) && allText.includes(f.name)
          )
          const anyMatch = allFiles.find(
            (f) => !f.is_dir && exts.some(ext => f.path.endsWith(ext))
          )

          const resolved = chatMatch ?? anyMatch
          if (resolved && resolved.path !== activeFile) {
            addNotification({
              type: 'change',
              detail: 'Smart Apply',
              message: `Redirected Apply → ${resolved.path} (matches ${lang})`,
            })
            targetFile = resolved.path
            // Only fetch from disk when targeting a DIFFERENT file than what's in the editor
            try {
              const raw = await api.openFile(resolved.path) as any
              targetContent = raw?.is_binary ? '' : raw?.content ?? ''
            } catch { targetContent = '' }
          }
        }
      }

      if (!targetFile) {
        addNotification({ type: 'error', detail: 'Apply Failed', message: 'No target file — open a file in the editor first' })
        return
      } 

      if (activeFileIsBinary && targetFile === activeFile) {
        addNotification({ type: 'error', detail: 'Apply Failed', message: 'Binary previews are read-only. Open a source file first.' })
        return
      }

      // Safety: don't send empty content to the merge AI — it produces garbage
      if (!targetContent || targetContent.trim() === '') {
        // Try one more time from disk as a last resort
        try {
          const raw = await api.openFile(targetFile) as any
          targetContent = raw?.is_binary ? '' : raw?.content ?? ''
        } catch { /* still empty */ }
      }

      const chatContext = chatHistory.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n')

      try {
        set({ isAiWriting: true })
        const newEntry = await api.applyCode({
          file: targetFile,
          snippet,
          current_content: targetContent,
          chat_context: chatContext,
        })
        addChangelogEntry(newEntry)
        await loadFileTree()
        await openFile(targetFile)
        set({ lastApplyEntryId: newEntry.id })
        addNotification({ type: 'change', detail: 'Applied Snippet', message: `Merged via AI model into ${targetFile}` })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Apply Failed', message: e.toString() })
      } finally {
        set({ isAiWriting: false })
      }
    },

    saveFile: async () => {
      const { activeFile, activeFileContent, activeFileIsBinary, trimOnSave, addChangelogEntry, addNotification, loadFileTree } = get()
      if (!activeFile) return
      if (activeFileIsBinary) {
        addNotification({ type: 'error', detail: 'Save Skipped', message: 'Binary previews are read-only' })
        return
      }
      const content = trimOnSave ? trimTrailingWs(activeFileContent) : activeFileContent
      try {
        const entry = await api.commitWrite({
          file: activeFile,
          content,
          summary: 'Manual save',
          affected_lines: [],
          affected_functions: [],
        })
        addChangelogEntry(entry)
        await loadFileTree()
        set((s) => ({
          isDirty: false,
          activeFileContent: content,
          lastSavedContent: content,
          lastApplyEntryId: null,
          tabCache: {
            ...s.tabCache,
            [activeFile]: { content, savedContent: content, isBinary: false },
          },
        }))
        addNotification({ type: 'change', detail: 'Saved', message: `${activeFile} saved to disk` })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Save Failed', message: e.toString() })
      }
    },

    revertEntry: async (entryId) => {
      const { activeFile, openFile, loadFileTree, addNotification, addChangelogEntry } = get()
      try {
        set({ isAiWriting: true })
        const newEntry = normalizeEntry(await api.revertFile(entryId))
        addChangelogEntry(newEntry)
        await loadFileTree()
        if (activeFile) {
          await openFile(activeFile)
        }
        addNotification({
          type: 'change',
          detail: 'Reverted',
          message: `Successfully reverted changes to previous state`,
        })
      } catch (e: any) {
        addNotification({
          type: 'error',
          detail: 'Revert Failed',
          message: e.toString(),
        })
      } finally {
        set({ isAiWriting: false })
      }
    },

    revertLastApply: async () => {
      const { lastApplyEntryId, revertEntry } = get()
      if (!lastApplyEntryId) return
      await revertEntry(lastApplyEntryId)
      set({ lastApplyEntryId: null })
    },

    revertRun: async (sessionId) => {
      const { activeFile, openFile, loadFileTree, addNotification, addChangelogEntry } = get()
      try {
        set({ isAiWriting: true })
        const entries = await api.revertSession(sessionId)
        entries.forEach((e) => addChangelogEntry(normalizeEntry(e)))
        await loadFileTree()
        if (activeFile) await openFile(activeFile)
        addNotification({
          type: 'change',
          detail: 'Agent run undone',
          message: `Restored ${entries.length} file${entries.length === 1 ? '' : 's'} to the state before the run`,
        })
      } catch (e: any) {
        addNotification({ type: 'error', detail: 'Undo failed', message: e.toString() })
      } finally {
        set({ isAiWriting: false })
      }
    },

    isAiWriting: false,

    invokeAi: async (prompt, attachedImage) => {
      const { activeFile, activeFileContent, addChatMessage, chatHistory } = get()
      if (!prompt.trim()) return

      const chatContext = chatHistory.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n')

      // Build user message — append image indicator if attached
      const userContent = attachedImage
        ? `${prompt}\n\n[📎 Image attached: ${attachedImage.mimeType}]`
        : prompt

      addChatMessage({ role: 'user', content: userContent })
      set({ isAiWriting: true, streamingText: null })

      try {
        // The token stream (ai_chunk) and terminal events (ai_write_complete /
        // ai_write_error) are handled by app-level listeners registered ONCE in
        // Workspace. Registering them per-call (as this used to) leaked a listener
        // trio on every interrupted message — a new invoke aborts the prior backend
        // task, which then emits no terminal event, so the old listeners were never
        // torn down and stacked ai_chunk handlers double-appended every delta.
        await api.invokeAi({
          file: activeFile || '',
          prompt,
          current_content: activeFileContent,
          chat_context: chatContext,
          image_base64: attachedImage?.base64,
          image_mime_type: attachedImage?.mimeType,
        })
      } catch (err: unknown) {
        // The backend command failed to dispatch — no ai_write_* event will arrive,
        // so reset the streaming state here (the listeners handle the normal paths).
        set({ isAiWriting: false, streamingText: null })
        addChatMessage({ role: 'assistant', content: `**System Error:** ${err instanceof Error ? err.message : String(err)}` })
      }
    },

    // ─── Notifications ────────────────────────────────────────────────────────
    notifications: [],

    addNotification: (n) =>
      set((s) => ({
        notifications: [
          { ...n, id: `notif_${Date.now()}`, timestamp: new Date().toISOString(), read: false },
          ...s.notifications,
        ],
      })),

    dismissNotification: (id) =>
      set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  }
})

// ─── Normalizes a raw Rust-serialized ChangelogEntry to match TypeScript types ─
// Rust serde serializes snake_case fields as snake_case by default but
// some versions may vary. This ensures we always have the right field names.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeEntry(raw: any): ChangelogEntry {
  return {
    id: raw.id ?? `chg_${Date.now()}`,
    file: raw.file ?? '',
    changed_by: raw.changed_by ?? raw.changedBy ?? '',
    model: raw.model ?? '',
    timestamp: raw.timestamp
      ? (typeof raw.timestamp === 'string' ? raw.timestamp : new Date(raw.timestamp).toISOString())
      : new Date().toISOString(),
    summary: raw.summary ?? '',
    affected_lines: raw.affected_lines ?? raw.affectedLines ?? [],
    affected_functions: raw.affected_functions ?? raw.affectedFunctions ?? [],
    previous_content: raw.previous_content ?? raw.previousContent ?? undefined,
    status: raw.status ?? 'committed',
    conflict_flag: raw.conflict_flag ?? raw.conflictFlag ?? false,
    // Must be carried through: this is what groups an agent run in the ledger and
    // enables "Undo run". Rebuilding the entry field-by-field silently dropped it,
    // so grouping appeared right after a run and then vanished on the next reload.
    session_id: raw.session_id ?? raw.sessionId ?? null,
  }
}

/** Flatten a recursive FileNode tree into a flat array */
function flattenTree(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.children) result.push(...flattenTree(node.children))
  }
  return result
}
