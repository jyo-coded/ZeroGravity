/**
 * Three-way line merge (diff3).
 *
 * This is what turns 0G's P2P sync from "last write silently wins" into a real
 * reconciliation: when a teammate's saved file and your local copy have both
 * moved on from a common ancestor, we merge the non-overlapping changes
 * automatically and only ask you about the regions where you truly collided.
 *
 * It reuses the same LCS line diff the review surface uses (diff.ts), so a hunk
 * here means exactly what a hunk means everywhere else in the product.
 */

import { diffLines } from './diff'

const splitLines = (s: string): string[] => s.split(/\r\n|\r|\n/)
const eolOf = (s: string): string => (/\r\n/.test(s) ? '\r\n' : '\n')
const arrayEq = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** One region of a merged document. */
export type MergeBlock =
  | { kind: 'stable'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; theirs: string[]; base: string[] }

export interface Merge3 {
  /** True when nothing needed a human — every region resolved to one answer. */
  clean: boolean
  blocks: MergeBlock[]
  /** Count of regions that need a decision. */
  conflicts: number
}

/**
 * Map every base line index that survives *unchanged* into `side` to that
 * side's line index. Built from the LCS diff, so it captures precisely the lines
 * the diff considers common — the anchors a merge can safely pivot on.
 */
function stableMap(base: string, side: string): Map<number, number> {
  const m = new Map<number, number>()
  for (const row of diffLines(base, side)) {
    if (row.op === 'equal' && row.oldLine != null && row.newLine != null) {
      m.set(row.oldLine - 1, row.newLine - 1)
    }
  }
  return m
}

/**
 * Merge `ours` and `theirs` against their common ancestor `base`.
 *
 * The classic algorithm: find the base lines that are stable in BOTH sides —
 * those are the only points where the two edit streams are provably aligned —
 * and reconcile each gap between consecutive anchors independently:
 *
 *   - only ours changed the gap      → take ours
 *   - only theirs changed the gap     → take theirs
 *   - both changed it identically     → take either
 *   - both changed it differently     → conflict (surface all three sides)
 */
export function merge3(baseText: string, oursText: string, theirsText: string): Merge3 {
  const base = splitLines(baseText)
  const ours = splitLines(oursText)
  const theirs = splitLines(theirsText)

  const oursStable = stableMap(baseText, oursText)
  const theirsStable = stableMap(baseText, theirsText)

  // Anchors: base lines unchanged in both sides. Keep only a strictly increasing
  // run in all three coordinates so gaps never overlap or run backwards.
  const anchors: { b: number; o: number; t: number }[] = []
  let lastO = -1
  let lastT = -1
  for (let b = 0; b < base.length; b++) {
    const o = oursStable.get(b)
    const t = theirsStable.get(b)
    if (o !== undefined && t !== undefined && o > lastO && t > lastT) {
      anchors.push({ b, o, t })
      lastO = o
      lastT = t
    }
  }

  // Sentinels at both ends so the leading and trailing gaps are handled by the
  // same loop as the interior ones.
  const seq = [
    { b: -1, o: -1, t: -1 },
    ...anchors,
    { b: base.length, o: ours.length, t: theirs.length },
  ]

  const blocks: MergeBlock[] = []
  let conflicts = 0

  const pushStable = (lines: string[]) => {
    if (lines.length === 0) return
    const last = blocks[blocks.length - 1]
    if (last && last.kind === 'stable') last.lines.push(...lines)
    else blocks.push({ kind: 'stable', lines: [...lines] })
  }

  for (let k = 0; k < seq.length - 1; k++) {
    const A = seq[k]
    const B = seq[k + 1]

    const bSeg = base.slice(A.b + 1, B.b)
    const oSeg = ours.slice(A.o + 1, B.o)
    const tSeg = theirs.slice(A.t + 1, B.t)

    if (arrayEq(oSeg, tSeg)) {
      pushStable(oSeg) // both sides agree (including "both unchanged")
    } else if (arrayEq(oSeg, bSeg)) {
      pushStable(tSeg) // only theirs touched this gap
    } else if (arrayEq(tSeg, bSeg)) {
      pushStable(oSeg) // only ours touched this gap
    } else {
      blocks.push({ kind: 'conflict', ours: oSeg, theirs: tSeg, base: bSeg })
      conflicts++
    }

    // The anchor line B itself is common ground — emit it (skip the tail sentinel).
    if (k < seq.length - 2) pushStable([base[B.b]])
  }

  return { clean: conflicts === 0, blocks, conflicts }
}

export type Side = 'ours' | 'theirs' | 'both-ot' | 'both-to'

/**
 * Flatten a merge into final text, given a choice for each conflict block.
 *
 * `choices[i]` is the decision for the i-th conflict block (in document order).
 * A missing choice defaults to keeping ours — the least surprising fallback,
 * since ours is what's already on the user's disk.
 */
export function resolveMerge(
  merge: Merge3,
  choices: Side[],
  eolSource = '\n',
): string {
  const out: string[] = []
  let ci = 0
  for (const block of merge.blocks) {
    if (block.kind === 'stable') {
      out.push(...block.lines)
      continue
    }
    const choice = choices[ci] ?? 'ours'
    ci++
    switch (choice) {
      case 'ours':
        out.push(...block.ours)
        break
      case 'theirs':
        out.push(...block.theirs)
        break
      case 'both-ot':
        out.push(...block.ours, ...block.theirs)
        break
      case 'both-to':
        out.push(...block.theirs, ...block.ours)
        break
    }
  }
  return out.join(eolOf(eolSource))
}

/**
 * The clean-merge text, or null if any region needs a human. Lets the caller
 * apply an automatic merge without materialising a resolver UI.
 */
export function autoMerged(merge: Merge3, eolSource = '\n'): string | null {
  if (!merge.clean) return null
  return resolveMerge(merge, [], eolOf(eolSource))
}
