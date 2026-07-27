// ─── Core 0G Types ────────────────────────────────────────────────────────────

export type EntryStatus = 'committed' | 'pending' | 'conflicted'

export interface ChangelogEntry {
  id: string
  file: string
  changed_by: string
  model: string
  timestamp: string // ISO 8601
  summary: string
  affected_lines: number[]
  affected_functions: string[]
  previous_content?: string
  status: EntryStatus
  conflict_flag: boolean
  /** Groups all writes from one agent run so the run can be undone as a unit. */
  session_id?: string | null
}

// 'cerebras' and 'ollama-cloud' are OpenAI-compatible endpoints: the Rust model
// layer falls through to its generic branch for any provider it doesn't name
// explicitly, using base_url. They need configuration, not new transport code.
export type ModelProvider =
  | 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter'
  | 'ollama' | 'ollama-cloud' | 'cerebras' | 'custom'

export interface OllamaLocalModel {
  name: string
  size: number
}

export interface SearchMatch {
  file: string
  line: number
  col: number
  len: number
  line_text: string
}

export interface ReplaceTarget {
  file: string
  line: number
  col: number
  len: number
}

export interface ModelConfig {
  provider: ModelProvider
  model_name: string
  api_key?: string
  base_url?: string
  label: string
}

export type Permission = 'owner' | 'alter' | 'read'

export interface Collaborator {
  id: string
  username: string
  avatar_color: string
  permission: Permission
  status: 'idle' | 'writing' | 'reviewing' | 'offline'
  current_file?: string
  is_self: boolean
}

export interface Project {
  id: string
  name: string
  invite_code: string
  root_path: string
  created_at: string
  owner: string
}

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
  last_edited_by?: string
  last_edited_at?: string
  last_editor_color?: string
}

export interface Notification {
  id: string
  type: 'change' | 'conflict' | 'peer_join' | 'peer_leave' | 'error'
  message: string
  detail?: string
  changelog_id?: string
  timestamp: string
  read: boolean
}

export interface UserIdentity {
  username: string
  avatar_color: string
}

export type AppView = 'onboarding_identity' | 'onboarding_model' | 'onboarding_project' | 'workspace'

export type WorkspaceView = 'canvas' | 'constellation' | 'timeline' | 'team'

export interface GitHunk {
  start: number
  end: number
  kind: 'add' | 'mod' | 'del'
}

// ─── Tauri Command Payloads ───────────────────────────────────────────────────

export interface CreateProjectPayload {
  name: string
  passphrase: string
  root_path: string
}

export interface JoinProjectPayload {
  invite_code: string
  passphrase: string
  root_path: string
}

export interface CommitWritePayload {
  file: string
  content: string
  summary: string
  affected_lines: number[]
  affected_functions: string[]
  /** Set to the change-set id when this write is part of an agent run. */
  session_id?: string | null
}

export interface InvokeAiPayload {
  file: string
  prompt: string
  current_content: string
  chat_context: string
  image_base64?: string
  image_mime_type?: string
}

export interface GetChangelogPayload {
  file?: string
  user?: string
  limit?: number
}

// ─── CodeGraph Types ─────────────────────────────────────────────────────────

export type NodeKind = 'File' | 'Function' | 'TypeDef'
export type EdgeKind = 'Imports' | 'Defines'

export interface GraphNode {
  id: string
  kind: NodeKind
  name: string
  path: string
  line: number | null
  type_kind: string | null
}

export interface GraphEdge {
  from: string
  to: string
  kind: EdgeKind
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}
