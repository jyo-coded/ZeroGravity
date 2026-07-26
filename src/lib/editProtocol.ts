/**
 * Edit protocol — how the model expresses a code change.
 *
 * The previous design asked the model for a whole rewritten file, then made a
 * SECOND model call to merge it in. That is non-deterministic (the same input
 * can produce different files), expensive, slow, unreviewable, and it silently
 * mangles code when the merge model hallucinates.
 *
 * Here the model emits explicit search/replace blocks. Applying them is pure
 * string work with no model involved: the same blocks always produce the same
 * file, or fail loudly with a reason. That determinism is what makes per-hunk
 * review trustworthy.
 *
 * Wire format (the Aider/Cline convention — well represented in training data,
 * so models produce it reliably):
 *
 *   ```edit src/app.ts
 *   <<<<<<< SEARCH
 *   const a = 1
 *   =======
 *   const a = 2
 *   >>>>>>> REPLACE
 *   ```
 *
 * A block with an empty SEARCH section creates a file (or replaces one wholesale).
 */

export interface EditBlock {
  path: string
  search: string
  replace: string
}

export interface ParsedResponse {
  /** The response with edit blocks stripped — what the user reads as prose. */
  prose: string
  edits: EditBlock[]
}

const FENCE = /```(?:edit|diff)[ \t]+([^\n`]+)\n([\s\S]*?)```/g
const MARKERS = /^<{5,9} SEARCH\s*\n([\s\S]*?)^={5,9}\s*\n([\s\S]*?)^>{5,9} REPLACE\s*$/m

/** Extract every edit block from a model response, plus the prose around them. */
export function parseEditBlocks(response: string): ParsedResponse {
  const edits: EditBlock[] = []
  let prose = response

  const matches = [...response.matchAll(FENCE)]
  for (const m of matches) {
    const path = m[1].trim().replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/')
    const body = m[2]
    const parts = MARKERS.exec(body)
    if (parts) {
      edits.push({ path, search: stripTrailingNewline(parts[1]), replace: stripTrailingNewline(parts[2]) })
    } else {
      // A fenced block tagged `edit` with no markers = whole-file content.
      edits.push({ path, search: '', replace: stripTrailingNewline(body) })
    }
    prose = prose.replace(m[0], '')
  }

  return { prose: prose.trim(), edits }
}

const stripTrailingNewline = (s: string) => s.replace(/\r?\n$/, '')

export type ApplyResult =
  | { ok: true; content: string }
  | { ok: false; reason: string }

/**
 * Apply one edit block to a file's content.
 *
 * Matching is attempted in three passes, each looser than the last, because
 * models reliably reproduce a region's *code* but not always its exact leading
 * whitespace:
 *   1. exact substring
 *   2. normalised line endings
 *   3. per-line trimmed comparison, re-indented from the real file
 *
 * It never guesses beyond that: an unmatched block is reported, not applied
 * somewhere approximate.
 */
export function applyEditBlock(original: string, block: EditBlock): ApplyResult {
  if (block.search === '') {
    return { ok: true, content: block.replace }
  }

  // 1 — exact
  const first = original.indexOf(block.search)
  if (first !== -1) {
    if (original.indexOf(block.search, first + 1) !== -1) {
      return {
        ok: false,
        reason: `the text to change appears more than once in ${block.path}; the model must include more surrounding context to identify which one`,
      }
    }
    return { ok: true, content: original.replace(block.search, block.replace) }
  }

  // 2 — line-ending normalised
  const normOriginal = original.replace(/\r\n/g, '\n')
  const normSearch = block.search.replace(/\r\n/g, '\n')
  const normIdx = normOriginal.indexOf(normSearch)
  if (normIdx !== -1) {
    const eol = /\r\n/.test(original) ? '\r\n' : '\n'
    const replaced = normOriginal.replace(normSearch, block.replace.replace(/\r\n/g, '\n'))
    return { ok: true, content: eol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced }
  }

  // 3 — indentation-insensitive, re-indented to match the file
  const fileLines = normOriginal.split('\n')
  const searchLines = normSearch.split('\n')
  const trimmed = searchLines.map((l) => l.trim())

  for (let i = 0; i + searchLines.length <= fileLines.length; i++) {
    let hit = true
    for (let j = 0; j < searchLines.length; j++) {
      if (fileLines[i + j].trim() !== trimmed[j]) { hit = false; break }
    }
    if (!hit) continue

    // Re-apply the file's own indentation to the replacement so the result keeps
    // the surrounding style rather than the model's guess at it.
    const fileIndent = (fileLines[i].match(/^[ \t]*/) ?? [''])[0]
    const searchIndent = (searchLines[0].match(/^[ \t]*/) ?? [''])[0]
    const replaceLines = block.replace.replace(/\r\n/g, '\n').split('\n').map((l) => {
      if (searchIndent && l.startsWith(searchIndent)) return fileIndent + l.slice(searchIndent.length)
      return l.trim() ? fileIndent + l.trimStart() : l
    })

    const out = [...fileLines.slice(0, i), ...replaceLines, ...fileLines.slice(i + searchLines.length)]
    const joined = out.join('\n')
    return { ok: true, content: /\r\n/.test(original) ? joined.replace(/\n/g, '\r\n') : joined }
  }

  return {
    ok: false,
    reason: `couldn't find the text to change in ${block.path} — the file may have changed since the model read it`,
  }
}

/** Apply every block targeting one file, in order. Stops at the first failure. */
export function applyEditsToFile(original: string, blocks: EditBlock[]): ApplyResult {
  let content = original
  for (const b of blocks) {
    const res = applyEditBlock(content, b)
    if (!res.ok) return res
    content = res.content
  }
  return { ok: true, content }
}

/** Group blocks by target file, preserving order within each file. */
export function groupByFile(edits: EditBlock[]): Map<string, EditBlock[]> {
  const map = new Map<string, EditBlock[]>()
  for (const e of edits) {
    const list = map.get(e.path)
    if (list) list.push(e)
    else map.set(e.path, [e])
  }
  return map
}

/** The instruction block appended to the system prompt so the model emits this format. */
export const EDIT_PROTOCOL_PROMPT = `
When you change code, emit edit blocks in exactly this format — one per contiguous change:

\`\`\`edit <relative/file/path>
<<<<<<< SEARCH
(the exact existing lines to replace, copied verbatim from the file)
=======
(the replacement lines)
>>>>>>> REPLACE
\`\`\`

Rules:
- SEARCH must match the current file exactly, including indentation. Copy it; do not retype it.
- Include enough surrounding lines to make the match unique in the file.
- Use several small blocks rather than one large one. Never reproduce a whole file to change part of it.
- To create a new file, leave the SEARCH section empty and put the full contents in REPLACE.
- Explain your reasoning in normal prose outside the blocks. Never describe an edit you did not emit as a block.
`.trim()
