//! semindex.rs — local, offline relevance index for code retrieval.
//!
//! When you ask the agent about something, the most relevant code is often in a
//! file you never opened. Grep finds exact strings; this ranks *chunks of the
//! whole project* by relevance to the query and feeds the top few into the
//! prompt, so the model sees the right code without the user hunting for it.
//!
//! WHY NOT NEURAL EMBEDDINGS: the obvious choice (fastembed / ONNX) downloads a
//! model from the network on first use and ships a native runtime. That breaks
//! the two things 0G promises — works air-gapped, and never hangs waiting on a
//! download mid-demo. So the default embedder here is dependency-free and
//! deterministic: feature-hashed TF-IDF over code tokens. It captures the lexical
//! overlap that dominates code search (identifiers get reused), runs offline, and
//! is instant. Neural embeddings via the user's own provider are the upgrade path
//! (see `enrich_prompt` — the retrieved block is provider-agnostic), not a
//! dependency we force on every user to open a file.

use std::collections::HashMap;

/// Embedding width. Feature hashing maps every token into this many buckets;
/// 1024 keeps collisions rare for code vocabularies while staying tiny in RAM.
const DIM: usize = 1024;
/// Lines per chunk, and how far the window advances (so chunks overlap, and a
/// definition split across a boundary still lands whole in one of them).
const CHUNK_LINES: usize = 50;
const CHUNK_STRIDE: usize = 40;
/// Don't index files bigger than this — generated bundles and data blobs would
/// swamp the index with irrelevant chunks and slow the build for no benefit.
const MAX_FILE_BYTES: usize = 200_000;
/// Cap on a retrieved chunk's characters when injected into a prompt.
const MAX_CHUNK_CHARS: usize = 1_400;

#[derive(Clone)]
pub struct Chunk {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    /// L2-normalised TF-IDF vector. Cosine similarity is then just a dot product.
    vec: Vec<f32>,
}

#[derive(Clone, serde::Serialize)]
pub struct Hit {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: f32,
    pub text: String,
}

pub struct SemIndex {
    chunks: Vec<Chunk>,
    idf: Vec<f32>,
    /// Number of source files last indexed — used to notice adds/removes cheaply.
    indexed_files: usize,
}

impl Default for SemIndex {
    fn default() -> Self {
        Self { chunks: Vec::new(), idf: vec![0.0; DIM], indexed_files: 0 }
    }
}

/// Split code into search tokens.
///
/// Beyond splitting on non-alphanumerics, this breaks `camelCase` and
/// `snake_case` apart, so a query for "parse edit block" matches
/// `parseEditBlock` and `parse_edit_block` alike — the whole point of indexing
/// code rather than prose.
fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();

    let flush_word = |word: &str, out: &mut Vec<String>| {
        // Split a run of [A-Za-z0-9] into camelCase / digit-boundary sub-tokens.
        let chars: Vec<char> = word.chars().collect();
        let mut piece = String::new();
        for i in 0..chars.len() {
            let c = chars[i];
            let prev = if i > 0 { Some(chars[i - 1]) } else { None };
            let boundary = matches!(prev, Some(p)
                if (c.is_uppercase() && p.is_lowercase())      // fooBar -> foo|Bar
                || (c.is_alphabetic() && p.is_ascii_digit())    // foo2bar
                || (c.is_ascii_digit() && p.is_alphabetic()));  // bar2
            if boundary && !piece.is_empty() {
                push_token(&piece, out);
                piece.clear();
            }
            piece.push(c);
        }
        if !piece.is_empty() {
            push_token(&piece, out);
        }
    };

    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            if ch == '_' {
                if !cur.is_empty() { flush_word(&cur, &mut out); cur.clear(); }
            } else {
                cur.push(ch);
            }
        } else if !cur.is_empty() {
            flush_word(&cur, &mut out);
            cur.clear();
        }
    }
    if !cur.is_empty() { flush_word(&cur, &mut out); }
    out
}

fn push_token(tok: &str, out: &mut Vec<String>) {
    let t = tok.to_lowercase();
    // Skip 1-char noise and absurdly long tokens (minified blobs); keep the rest.
    if t.len() >= 2 && t.len() <= 40 && !t.chars().all(|c| c.is_ascii_digit()) {
        out.push(t);
    }
}

fn bucket(token: &str) -> usize {
    // FNV-1a — small, fast, well-distributed for short strings.
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in token.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (hash % DIM as u64) as usize
}

/// True for text worth indexing (skips binaries and oversized generated files).
fn is_indexable(content: &str) -> bool {
    content.len() <= MAX_FILE_BYTES && !content.contains('\0')
}

impl SemIndex {
    /// Rebuild only when the file set changed since the last index. Content edits
    /// within existing files don't force a rebuild — retrieval is fuzzy, so a few
    /// stale lines don't change which chunks rank highest, and rebuilding on every
    /// keystroke-save would be wasteful on a large repo. `reindex` forces it.
    pub fn ensure_built(&mut self, map: &HashMap<String, String>) {
        if self.chunks.is_empty() || self.indexed_files != map.len() {
            self.build(map);
        }
    }

    /// Number of indexed chunks — a rough gauge of how much the index covers.
    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    #[allow(dead_code)] // paired with len() to satisfy clippy::len_without_is_empty
    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    pub fn build(&mut self, map: &HashMap<String, String>) {
        // Pass 1: cut files into line-window chunks, record term presence per chunk.
        struct Raw { file: String, start: usize, end: usize, text: String, tf: HashMap<usize, f32> }
        let mut raws: Vec<Raw> = Vec::new();
        let mut df = vec![0u32; DIM];

        let mut files: Vec<&String> = map.keys().collect();
        files.sort(); // deterministic chunk order → deterministic tie-breaking

        for file in files {
            let content = &map[file];
            if !is_indexable(content) { continue; }
            let lines: Vec<&str> = content.lines().collect();
            if lines.is_empty() { continue; }

            let mut start = 0;
            while start < lines.len() {
                let end = (start + CHUNK_LINES).min(lines.len());
                let text = lines[start..end].join("\n");
                let mut tf: HashMap<usize, f32> = HashMap::new();
                for tok in tokenize(&text) {
                    *tf.entry(bucket(&tok)).or_insert(0.0) += 1.0;
                }
                if !tf.is_empty() {
                    for &b in tf.keys() { df[b] += 1; }
                    raws.push(Raw { file: file.clone(), start: start + 1, end, text, tf });
                }
                if end == lines.len() { break; }
                start += CHUNK_STRIDE;
            }
        }

        // IDF over chunks: rare tokens weigh more. +1 smoothing avoids div-by-zero.
        let n = raws.len().max(1) as f32;
        let mut idf = vec![0.0f32; DIM];
        for b in 0..DIM {
            idf[b] = ((n + 1.0) / (df[b] as f32 + 1.0)).ln() + 1.0;
        }

        // Pass 2: weight each chunk by tf-idf and L2-normalise.
        let chunks = raws
            .into_iter()
            .map(|r| {
                let mut v = vec![0.0f32; DIM];
                for (&b, &f) in &r.tf {
                    v[b] = f * idf[b];
                }
                normalize(&mut v);
                Chunk { file: r.file, start_line: r.start, end_line: r.end, text: r.text, vec: v }
            })
            .collect();

        self.chunks = chunks;
        self.idf = idf;
        self.indexed_files = map.len();
    }

    /// Top-`k` chunks for a query, most relevant first. Empty when nothing clears
    /// a small floor — an irrelevant query should add nothing to the prompt rather
    /// than pad it with noise.
    pub fn search(&self, query: &str, k: usize) -> Vec<Hit> {
        if self.chunks.is_empty() { return Vec::new(); }

        let mut q = vec![0.0f32; DIM];
        for tok in tokenize(query) {
            let b = bucket(&tok);
            q[b] += self.idf[b];
        }
        normalize(&mut q);
        if q.iter().all(|x| *x == 0.0) { return Vec::new(); }

        let mut scored: Vec<Hit> = self
            .chunks
            .iter()
            .map(|c| Hit {
                file: c.file.clone(),
                start_line: c.start_line,
                end_line: c.end_line,
                score: dot(&q, &c.vec),
                text: c.text.clone(),
            })
            .filter(|h| h.score > 0.03)
            .collect();

        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored
    }

    /// Render the top hits as a prompt block, or empty string if there are none.
    /// Kept out of `enrich_prompt` so the retrieval source stays swappable.
    pub fn context_block(&self, query: &str, k: usize) -> String {
        let hits = self.search(query, k);
        if hits.is_empty() { return String::new(); }
        let mut out = String::from(
            "[RELEVANT CODE]\nThe most relevant code found across the whole project for this request \
             (retrieved, may be from files that are not open):\n\n",
        );
        for h in hits {
            let body = if h.text.len() > MAX_CHUNK_CHARS {
                format!("{}\n… [truncated]", &h.text[..MAX_CHUNK_CHARS])
            } else {
                h.text
            };
            out.push_str(&format!(
                "── {} (lines {}-{}) ──\n{}\n\n",
                h.file, h.start_line, h.end_line, body
            ));
        }
        out
    }
}

fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() { *x /= norm; }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn tokenizes_camel_and_snake() {
        let t = tokenize("parseEditBlock parse_edit_block");
        assert!(t.contains(&"parse".to_string()));
        assert!(t.contains(&"edit".to_string()));
        assert!(t.contains(&"block".to_string()));
    }

    #[test]
    fn retrieves_the_relevant_file() {
        let m = map(&[
            ("auth.ts", "export function verifyPassword(hash: string) {\n  return argon2.verify(hash)\n}"),
            ("ui.tsx", "export function Button() {\n  return <button>click</button>\n}"),
            ("math.ts", "export function add(a: number, b: number) {\n  return a + b\n}"),
        ]);
        let mut idx = SemIndex::default();
        idx.build(&m);
        let hits = idx.search("how does password verification work", 2);
        assert!(!hits.is_empty(), "expected at least one hit");
        assert_eq!(hits[0].file, "auth.ts", "most relevant file should rank first");
    }

    #[test]
    fn irrelevant_query_returns_nothing() {
        let m = map(&[("math.ts", "export function add(a, b) { return a + b }")]);
        let mut idx = SemIndex::default();
        idx.build(&m);
        let hits = idx.search("zzznonexistenttokenqqq", 3);
        assert!(hits.is_empty());
    }

    #[test]
    fn rebuilds_when_file_count_changes() {
        let mut idx = SemIndex::default();
        idx.ensure_built(&map(&[("a.ts", "function alpha() {}")]));
        let before = idx.indexed_files;
        idx.ensure_built(&map(&[("a.ts", "function alpha() {}"), ("b.ts", "function beta() {}")]));
        assert_ne!(before, idx.indexed_files);
        assert_eq!(idx.indexed_files, 2);
    }

    #[test]
    fn context_block_names_the_file() {
        let m = map(&[("net.rs", "fn connect_peer(addr: String) { /* tcp handshake */ }")]);
        let mut idx = SemIndex::default();
        idx.build(&m);
        let block = idx.context_block("connect to a peer over tcp", 3);
        assert!(block.contains("net.rs"), "block should cite its source file");
        assert!(block.contains("[RELEVANT CODE]"));
    }
}
