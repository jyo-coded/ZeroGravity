/** Format a timestamp as a relative string ("2 min ago") */
export function timeAgo(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diff = Math.floor((now - then) / 1000)

  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

/** Get file extension for language detection */
export function getFileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: 'python',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
  }
  return map[ext ?? ''] ?? 'plaintext'
}

/** Get a consistent color for a user (fallback) */
export const USER_COLORS = [
  '#38BDF8', '#22C55E', '#F59E0B', '#A78BFA',
  '#F472B6', '#34D399', '#FB923C', '#60A5FA',
]

export function getUserColor(username: string): string {
  let hash = 0
  for (const ch of username) hash = ch.charCodeAt(0) + ((hash << 5) - hash)
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

/** Truncate a string with ellipsis */
export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

/** Get just the filename from a path */
export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/** Generate a random 6-char alphanumeric invite code */
export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
