/**
 * How a file is presented to the model.
 *
 * The bug this exists to prevent: showing only the HEAD of a long file. The
 * model then cannot see the end of it, so any request touching the bottom
 * ("add a comment at the end", "change the last function") makes it invent a
 * SEARCH block that can never match, and the edit fails with a confusing
 * "couldn't find the text to change".
 *
 * Keeping both ends, and stating exactly which lines were omitted, means edits
 * anywhere in a file of any size are expressible — and the model is told to
 * fetch the middle rather than guess at it.
 */

/** Prefix each line with its 1-based number so the model can cite and copy accurately. */
export function numberLines(content: string, startLine = 1): string {
  return content
    .split('\n')
    .map((l, i) => `${startLine + i}\t${l}`)
    .join('\n')
}

/**
 * Trim a numbered file body to `budget` characters by removing its MIDDLE.
 *
 * 60% of the budget goes to the head (imports, class and function signatures —
 * the structural context) and 40% to the tail, which is what makes end-of-file
 * edits possible at all.
 */
export function windowFile(numbered: string, budget: number, totalLines: number): string {
  if (numbered.length <= budget) return numbered

  const headBudget = Math.floor(budget * 0.6)
  const tailBudget = budget - headBudget
  const head = numbered.slice(0, headBudget)
  const tail = numbered.slice(-tailBudget)

  // Derive the hidden range from what actually survived, so the numbers quoted
  // to the model match the numbers it can see.
  const lastShownHead = Number((head.split('\n').pop() ?? '').split('\t')[0]) || head.split('\n').length
  const firstShownTail = Number((tail.split('\n')[1] ?? tail.split('\n')[0] ?? '').split('\t')[0])
    || Math.max(lastShownHead + 1, totalLines)

  const from = lastShownHead + 1
  const to = Math.max(from, firstShownTail - 1)

  return (
    `${head}\n` +
    `… [lines ${from}-${to} of ${totalLines} are NOT shown. Do not write a SEARCH ` +
    `block for that range — you have not seen it. Fetch it with ` +
    `{"name":"read_file","args":{"path":"…","start":${from},"end":${to}}} if you need it.] …\n` +
    `${tail}`
  )
}

/** Slice a line range (1-based, inclusive) out of a file's content. */
export function sliceLines(content: string, start: number, end: number): {
  body: string
  from: number
  to: number
  total: number
} {
  const lines = content.split('\n')
  const from = Math.max(1, Math.min(start || 1, lines.length))
  const to = Math.max(from, Math.min(end || lines.length, lines.length))
  return {
    body: lines.slice(from - 1, to).join('\n'),
    from,
    to,
    total: lines.length,
  }
}
