/**
 * Line diff — the basis of every review surface in the product.
 *
 * Implemented here rather than pulled from a library because the review UI needs
 * *addressable* hunks: each one must carry a stable id and enough position data
 * to be accepted or rejected independently, and to be reconstructed into a final
 * document from an arbitrary subset of accepted hunks. Off-the-shelf diffs give
 * a rendering, not an editable decision list.
 */

export type LineOp = 'equal' | 'insert' | 'delete'

export interface DiffLine {
  op: LineOp
  /** Line number in the original document (1-based); null for inserted lines. */
  oldLine: number | null
  /** Line number in the proposed document (1-based); null for deleted lines. */
  newLine: number | null
  text: string
}

export interface Hunk {
  id: string
  /** 1-based start line in the ORIGINAL document this hunk replaces. */
  oldStart: number
  /** How many original lines this hunk consumes (0 for a pure insertion). */
  oldCount: number
  /** The replacement lines. Empty for a pure deletion. */
  newLines: string[]
  /** The original lines being replaced — needed to render and to revert. */
  oldLines: string[]
  added: number
  removed: number
}

const splitLines = (s: string): string[] => s.split(/\r\n|\r|\n/)

/**
 * Longest-common-subsequence line diff.
 *
 * A full O(n·m) table is fine for source files (a 4k-line file is 16M cells in
 * the worst case, but the common-prefix/suffix trim below collapses almost every
 * real edit to a few dozen differing lines first). Files past the guard fall back
 * to a whole-file replacement rather than hanging the UI.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  // Trim the identical head and tail — an AI edit usually touches a tiny slice
  // of a file, so this reduces the LCS problem to almost nothing.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  const aMid = a.slice(head, a.length - tail)
  const bMid = b.slice(head, b.length - tail)

  const out: DiffLine[] = []
  for (let i = 0; i < head; i++) {
    out.push({ op: 'equal', oldLine: i + 1, newLine: i + 1, text: a[i] })
  }

  const MAX_CELLS = 4_000_000
  if (aMid.length * bMid.length > MAX_CELLS) {
    // Too large to align line-by-line: report it as one wholesale replacement.
    aMid.forEach((t, i) => out.push({ op: 'delete', oldLine: head + i + 1, newLine: null, text: t }))
    bMid.forEach((t, i) => out.push({ op: 'insert', oldLine: null, newLine: head + i + 1, text: t }))
  } else {
    const n = aMid.length
    const m = bMid.length
    // lcs[i][j] = length of the LCS of aMid[i:] and bMid[j:]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = aMid[i] === bMid[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (aMid[i] === bMid[j]) {
        out.push({ op: 'equal', oldLine: head + i + 1, newLine: head + j + 1, text: aMid[i] })
        i++; j++
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.push({ op: 'delete', oldLine: head + i + 1, newLine: null, text: aMid[i] })
        i++
      } else {
        out.push({ op: 'insert', oldLine: null, newLine: head + j + 1, text: bMid[j] })
        j++
      }
    }
    while (i < n) { out.push({ op: 'delete', oldLine: head + i + 1, newLine: null, text: aMid[i] }); i++ }
    while (j < m) { out.push({ op: 'insert', oldLine: null, newLine: head + j + 1, text: bMid[j] }); j++ }
  }

  for (let k = 0; k < tail; k++) {
    const oi = a.length - tail + k
    const ni = b.length - tail + k
    out.push({ op: 'equal', oldLine: oi + 1, newLine: ni + 1, text: a[oi] })
  }
  return out
}

/**
 * Group a line diff into contiguous change hunks.
 *
 * Adjacent deletes and inserts collapse into ONE hunk so a modified line reads
 * as a single decision ("replace this with that") rather than two unrelated ones.
 */
export function toHunks(lines: DiffLine[], keyPrefix = 'h'): Hunk[] {
  const hunks: Hunk[] = []
  let i = 0
  let seq = 0

  while (i < lines.length) {
    if (lines[i].op === 'equal') { i++; continue }

    const start = i
    while (i < lines.length && lines[i].op !== 'equal') i++
    const block = lines.slice(start, i)

    const oldLines = block.filter((l) => l.op === 'delete').map((l) => l.text)
    const newLines = block.filter((l) => l.op === 'insert').map((l) => l.text)

    // Anchor a pure insertion after the last preceding original line, so an
    // insert at the very top lands at line 1 rather than line 0.
    const firstDelete = block.find((l) => l.op === 'delete')
    let oldStart: number
    if (firstDelete?.oldLine != null) {
      oldStart = firstDelete.oldLine
    } else {
      let prev = 0
      for (let k = start - 1; k >= 0; k--) {
        if (lines[k].oldLine != null) { prev = lines[k].oldLine as number; break }
      }
      oldStart = prev + 1
    }

    hunks.push({
      id: `${keyPrefix}-${seq++}`,
      oldStart,
      oldCount: oldLines.length,
      oldLines,
      newLines,
      added: newLines.length,
      removed: oldLines.length,
    })
  }
  return hunks
}

export const diffToHunks = (oldText: string, newText: string, keyPrefix?: string): Hunk[] =>
  toHunks(diffLines(oldText, newText), keyPrefix)

/**
 * Rebuild a document applying only the accepted hunks.
 *
 * This is what makes per-hunk review real: the user's selection produces an
 * exact document, not an approximation. Hunks are applied from the bottom up so
 * earlier line numbers stay valid as the text shifts.
 */
export function applyHunks(originalText: string, hunks: Hunk[], accepted: Set<string>): string {
  const lines = splitLines(originalText)
  const chosen = hunks
    .filter((h) => accepted.has(h.id))
    .sort((x, y) => y.oldStart - x.oldStart)

  for (const h of chosen) {
    const idx = h.oldStart - 1
    lines.splice(idx, h.oldCount, ...h.newLines)
  }

  // Preserve the original line ending style — rewriting a CRLF file as LF would
  // show up as a whole-file change in git.
  const eol = /\r\n/.test(originalText) ? '\r\n' : '\n'
  return lines.join(eol)
}

export function diffStats(hunks: Hunk[]): { added: number; removed: number } {
  return hunks.reduce(
    (acc, h) => ({ added: acc.added + h.added, removed: acc.removed + h.removed }),
    { added: 0, removed: 0 },
  )
}
