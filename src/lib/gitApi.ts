import { invoke } from '@tauri-apps/api/core'

export interface FileChange {
  path: string
  code: string
  staged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  is_repo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  changes: FileChange[]
}

export interface Commit { sha: string; author: string; date: string; subject: string }
export interface Branches { current: string; local: string[] }
export interface BlameLine { line: number; sha: string; author: string; date: string; summary: string }

export const gitStatusFull = () => invoke<GitStatus>('git_status_full')
export const gitStage = (paths: string[]) => invoke<void>('git_stage', { paths })
export const gitUnstage = (paths: string[]) => invoke<void>('git_unstage', { paths })
export const gitDiscard = (paths: string[]) => invoke<void>('git_discard', { paths })
export const gitCommit = (message: string, stageAll: boolean) =>
  invoke<string>('git_commit', { message, stageAll })
export const gitLog = (limit = 50) => invoke<Commit[]>('git_log', { limit })
export const gitBranches = () => invoke<Branches>('git_branches')
export const gitCheckout = (branch: string, create = false) =>
  invoke<void>('git_checkout', { args: { branch, create } })
export const gitBlame = (file: string) => invoke<BlameLine[]>('git_blame', { file })
export const gitFileDiffText = (file: string, staged = false) =>
  invoke<string>('git_file_diff_text', { file, staged })

/** Human-readable meaning of a porcelain status code, for tooltips. */
export function describeCode(c: FileChange): string {
  if (c.conflicted) return 'Conflicted — resolve before committing'
  if (c.untracked) return 'Untracked'
  const x = c.code[0]
  const y = c.code[1]
  const word = (ch: string) =>
    ch === 'M' ? 'Modified' : ch === 'A' ? 'Added' : ch === 'D' ? 'Deleted'
      : ch === 'R' ? 'Renamed' : ch === 'C' ? 'Copied' : ''
  if (x !== ' ' && x !== '?') return `${word(x)} (staged)`
  return word(y) || 'Changed'
}

/** Single letter shown in the list — dense, and colour-coded by state. */
export function codeBadge(c: FileChange): string {
  if (c.conflicted) return '!'
  if (c.untracked) return 'U'
  const ch = c.code.trim()[0] ?? 'M'
  return ch
}
