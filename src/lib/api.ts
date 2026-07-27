import { invoke } from '@tauri-apps/api/core'
import type {
  ChangelogEntry,
  Collaborator,
  CommitWritePayload,
  CreateProjectPayload,
  FileNode,
  GetChangelogPayload,
  GitHunk,
  GraphData,
  InvokeAiPayload,
  JoinProjectPayload,
  ModelConfig,
  Project,
  ReplaceTarget,
  SearchMatch,
  UserIdentity,
} from './types'

// Project

export async function createProject(payload: CreateProjectPayload): Promise<Project> {
  return invoke('create_project', {
    name: payload.name,
    passphrase: payload.passphrase,
    rootPath: payload.root_path,
  })
}

export async function joinProject(payload: JoinProjectPayload): Promise<Project> {
  return invoke('join_project', {
    inviteCode: payload.invite_code,
    passphrase: payload.passphrase,
    rootPath: payload.root_path,
  })
}

export async function getProject(): Promise<Project | null> {
  return invoke('get_project')
}

// Network

export async function startNetwork(inviteCode: string, passphrase: string, identity: UserIdentity): Promise<void> {
  return invoke('start_network', { inviteCode, passphrase, identity })
}

// Identity & Model Config

export async function saveIdentity(identity: UserIdentity): Promise<void> {
  return invoke('save_identity', { identity })
}

export async function loadIdentity(): Promise<UserIdentity | null> {
  return invoke('load_identity')
}

export async function configureModel(config: ModelConfig): Promise<void> {
  return invoke('configure_model', { config })
}

export async function loadModelConfig(): Promise<ModelConfig | null> {
  return invoke('load_model_config')
}

// File System

export async function getFileTree(): Promise<FileNode[]> {
  return invoke('get_file_tree')
}

export async function openFile(path: string): Promise<{ content: string; entries: ChangelogEntry[]; is_binary?: boolean }> {
  return invoke('open_file', { path })
}

export async function createFile(file: string, content?: string): Promise<ChangelogEntry> {
  return invoke('create_file', { file, content: content ?? null })
}

export async function deletePath(path: string): Promise<ChangelogEntry[]> {
  return invoke('delete_path', { path })
}

export async function renamePath(from: string, to: string): Promise<ChangelogEntry> {
  return invoke('rename_path', { from, to })
}

export async function createFolder(path: string): Promise<void> {
  return invoke('create_folder', { path })
}

export async function revealInExplorer(path: string): Promise<void> {
  return invoke('reveal_in_explorer', { path })
}

export async function formatDocument(file: string, content: string): Promise<string> {
  return invoke('format_document', { file, content })
}

export async function searchProject(opts: {
  query: string
  caseSensitive?: boolean
  isRegex?: boolean
  includeGlob?: string
  excludeGlob?: string
}): Promise<SearchMatch[]> {
  return invoke('search_project', {
    query: opts.query,
    caseSensitive: opts.caseSensitive ?? null,
    isRegex: opts.isRegex ?? null,
    includeGlob: opts.includeGlob ?? null,
    excludeGlob: opts.excludeGlob ?? null,
  })
}

export async function replaceInFiles(targets: ReplaceTarget[], replacement: string): Promise<ChangelogEntry[]> {
  return invoke('replace_in_files', { targets, replacement })
}

// Model rotation (B4)

export async function configureRotation(list: ModelConfig[]): Promise<void> {
  return invoke('configure_rotation', { list })
}

export interface UsageStat {
  provider: string
  minute_count: number
  minute_cap: number | null
  day_count: number
  day_cap: number | null
  last_used: string | null
}

export async function getUsageStats(): Promise<UsageStat[]> {
  return invoke('get_usage_stats')
}

export async function importUsage(seeds: [string, number, string][]): Promise<void> {
  return invoke('import_usage', { seeds })
}

export async function cancelAi(): Promise<void> {
  return invoke('cancel_ai')
}

// CRDT relay (T1)

export async function broadcastCrdt(doc: string, kind: string, data: string): Promise<void> {
  return invoke('broadcast_crdt', { doc, kind, data })
}

export async function getPeerId(): Promise<string> {
  return invoke('get_peer_id')
}

export async function sendChat(username: string, color: string, text: string, ts: string): Promise<void> {
  return invoke('send_chat', { username, color, text, ts })
}

export async function getNetworkInfo(): Promise<{ peer_id: string; tcp_port: number; ip: string }> {
  return invoke('get_network_info')
}

export async function connectPeer(addr: string): Promise<void> {
  return invoke('connect_peer', { addr })
}

/** Native folder picker (backend-driven). Resolves to the path, or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  return invoke('pick_folder')
}

export async function detectFormatters(): Promise<{ rustfmt: boolean; black: boolean; prettier: boolean }> {
  return invoke('detect_formatters')
}

// Git awareness (A6 — read-only)

export async function gitStatus(): Promise<{ is_repo: boolean; branch?: string; modified?: string[]; untracked?: string[] }> {
  return invoke('git_status')
}

export async function gitDiffFile(file: string): Promise<GitHunk[]> {
  return invoke('git_diff_file', { file })
}

/** Probe local Ollama — resolves to its model list, rejects with "not_running". */
export async function detectOllama(baseUrl?: string): Promise<{ models?: { name: string; size?: number }[] }> {
  return invoke('detect_ollama', { baseUrl: baseUrl ?? null })
}

export async function commitWrite(payload: CommitWritePayload): Promise<ChangelogEntry> {
  return invoke('commit_write', {
    file: payload.file,
    content: payload.content,
    summary: payload.summary,
    affectedLines: payload.affected_lines,
    affectedFunctions: payload.affected_functions,
    sessionId: payload.session_id ?? null,
  })
}

export async function revertFile(entryId: string): Promise<ChangelogEntry> {
  return invoke('revert_file', { entryId })
}

/** Undo an entire agent run — restores every file it touched to its pre-run state. */
export async function revertSession(sessionId: string): Promise<ChangelogEntry[]> {
  return invoke('revert_session', { sessionId })
}

// Semantic retrieval — relevance-ranked code chunks from across the project.

export interface SemanticHit {
  file: string
  start_line: number
  end_line: number
  score: number
  text: string
}

export async function semanticSearch(query: string, k?: number): Promise<SemanticHit[]> {
  return invoke('semantic_search', { query, k: k ?? null })
}

export async function reindex(): Promise<number> {
  return invoke('reindex')
}

// Conflict resolution — remote writes held back because the local copy diverged.

export interface ConflictInfo {
  id: string
  file: string
  base: string | null
  ours: string
  theirs: string
  their_user: string
  their_summary: string
  their_model: string
}

export async function listConflicts(): Promise<ConflictInfo[]> {
  return invoke('list_conflicts')
}

export async function dismissConflict(id: string): Promise<void> {
  return invoke('dismiss_conflict', { id })
}

// Changelog

export async function getChangelog(payload: GetChangelogPayload = {}): Promise<ChangelogEntry[]> {
  return invoke('get_changelog', { ...payload })
}

// AI

export async function invokeAi(payload: InvokeAiPayload): Promise<void> {
  return invoke('invoke_ai', {
    file: payload.file,
    prompt: payload.prompt,
    currentContent: payload.current_content,
    chatContext: payload.chat_context,
    imageBase64: payload.image_base64 ?? null,
    imageMimeType: payload.image_mime_type ?? null,
  })
}

export async function applyCode(payload: { file: string, snippet: string, current_content: string, chat_context: string }): Promise<ChangelogEntry> {
  return invoke('apply_code', {
    file: payload.file,
    snippet: payload.snippet,
    currentContent: payload.current_content,
    chatContext: payload.chat_context,
  })
}

// Collaborators

export async function getCollaborators(): Promise<Collaborator[]> {
  return invoke('get_collaborators')
}

// Code Graph

export async function getGraphJson(): Promise<GraphData> {
  return invoke('get_graph_json')
}

export async function getGraphContext(file: string): Promise<string> {
  return invoke('get_graph_context', { file })
}
