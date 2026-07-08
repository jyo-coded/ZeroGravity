//! CodeGraph — the semantic knowledge graph of ZeroGravity.
//!
//! Instead of injecting raw file contents into AI prompts, the CodeGraph gives
//! every model a structured architectural picture of the codebase before it writes:
//! what a file imports, what depends on it, and what it defines.
//!
//! ## Graph Schema
//!
//! ```text
//! Nodes:
//!   File     - "file:src/auth.ts"
//!   Function - "fn:src/auth.ts::verifyToken"
//!   TypeDef  - "type:src/auth.ts::AuthConfig"
//!
//! Edges:
//!   Imports  - File -> File     (A imports B)
//!   Defines  - File -> Function (A defines F)
//!   Defines  - File -> TypeDef  (A defines T)
//! ```
//!
//! ## Usage
//!
//! ```ignore
//! let mut graph = CodeGraph::new();
//! graph.build_from_map(&context_map);
//! graph.update_file("src/auth.ts", new_content, &known_files);
//! let ctx = graph.query_context("src/auth.ts");
//! ```

use std::collections::{HashMap, HashSet};

use petgraph::stable_graph::{NodeIndex, StableDiGraph};
use petgraph::visit::EdgeRef;
use petgraph::Direction;
use serde::{Deserialize, Serialize};

use crate::parser::{parse_file, resolve_import};

// ─── Node / Edge types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum NodeKind {
    File,
    Function,
    TypeDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    /// Stable unique ID: "file:path" | "fn:path::name" | "type:path::name"
    pub id: String,
    pub kind: NodeKind,
    /// Display name: basename for files, symbol name for functions/types
    pub name: String,
    /// Containing file path (relative, forward-slash normalised)
    pub path: String,
    /// Source line number where defined (None for File nodes)
    pub line: Option<u32>,
    /// For TypeDef nodes: "class" | "struct" | "interface" | "enum" | "trait" | "type" | "impl"
    pub type_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EdgeKind {
    /// source File imports target File
    Imports,
    /// File defines a Function or TypeDef
    Defines,
}

// ─── CodeGraph ────────────────────────────────────────────────────────────────

/// The live, in-memory knowledge graph for a ZeroGravity project session.
///
/// Kept behind `Arc<Mutex<CodeGraph>>` in AppState. Built once on project open,
/// then incrementally updated by the file watcher whenever a file changes.
pub struct CodeGraph {
    graph: StableDiGraph<GraphNode, EdgeKind>,
    /// node_id → NodeIndex — O(1) lookup
    index: HashMap<String, NodeIndex>,
    /// file_path → [node_ids] — used to wipe a file's contribution on update
    file_nodes: HashMap<String, Vec<String>>,
}

impl Default for CodeGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl CodeGraph {
    pub fn new() -> Self {
        Self {
            graph: StableDiGraph::new(),
            index: HashMap::new(),
            file_nodes: HashMap::new(),
        }
    }

    // ─── Build / Update ───────────────────────────────────────────────────────

    /// Full initial build from a populated context_map (path → content).
    /// Called once after the project file scan completes.
    pub fn build_from_map(&mut self, context_map: &HashMap<String, String>) {
        let known_files: HashSet<String> = context_map.keys().cloned().collect();

        // Pass 1 — ensure all File nodes exist before adding any edges
        for path in context_map.keys() {
            self.ensure_file_node(path);
        }

        // Pass 2 — parse each file and add Defines + Imports edges
        for (path, content) in context_map {
            self.index_file_content(path, content, &known_files);
        }

        log::info!(
            "CodeGraph built: {} nodes, {} edges across {} files",
            self.graph.node_count(),
            self.graph.edge_count(),
            self.file_nodes.len()
        );
    }

    /// Incremental update when a single file changes on disk.
    /// Removes all nodes/edges previously contributed by this file,
    /// then re-parses and re-inserts.
    pub fn update_file(&mut self, path: &str, content: &str, known_files: &HashSet<String>) {
        self.remove_file_nodes(path);
        self.ensure_file_node(path);
        self.index_file_content(path, content, known_files);
        log::debug!("CodeGraph updated for {}", path);
    }

    // ─── Query ────────────────────────────────────────────────────────────────

    /// Returns a `[GRAPH CONTEXT]` block for the given file,
    /// ready to be injected into an AI prompt.
    ///
    /// Returns an empty string if the file isn't in the graph yet.
    pub fn query_context(&self, file: &str) -> String {
        let file_id = format!("file:{}", file);
        let file_idx = match self.index.get(&file_id) {
            Some(&idx) => idx,
            None => return String::new(),
        };

        let mut out = format!("[GRAPH CONTEXT]\nStructural map of: {}\n", file);
        let mut has_content = false;

        // ── Direct imports (this file → other files) ──────────────────────────
        let mut imports: Vec<String> = self
            .graph
            .edges_directed(file_idx, Direction::Outgoing)
            .filter(|e| e.weight() == &EdgeKind::Imports)
            .map(|e| {
                let tgt = &self.graph[e.target()];
                let defs = self.file_define_summary(e.target());
                if defs.is_empty() {
                    format!("  → {}", tgt.path)
                } else {
                    format!("  → {}\n     Defines: {}", tgt.path, defs)
                }
            })
            .collect();
        imports.sort(); // deterministic output

        if !imports.is_empty() {
            out.push_str("\nDirect imports (this file depends on):\n");
            out.push_str(&imports.join("\n"));
            out.push('\n');
            has_content = true;
        }

        // ── Reverse imports (other files → this file) ─────────────────────────
        let mut rev_imports: Vec<String> = self
            .graph
            .edges_directed(file_idx, Direction::Incoming)
            .filter(|e| e.weight() == &EdgeKind::Imports)
            .map(|e| {
                let src = &self.graph[e.source()];
                format!("  → {}", src.path)
            })
            .collect();
        rev_imports.sort();

        if !rev_imports.is_empty() {
            out.push_str("\nImported by (files that depend on this):\n");
            out.push_str(&rev_imports.join("\n"));
            out.push('\n');
            has_content = true;
        }

        // ── Definitions in this file ──────────────────────────────────────────
        let defs = self.file_define_summary(file_idx);
        if !defs.is_empty() {
            out.push_str(&format!("\nThis file defines: {}\n", defs));
            has_content = true;
        }

        if has_content {
            out
        } else {
            String::new()
        }
    }

    /// Return a graph statistics summary (used in logs and the frontend command).
    pub fn stats(&self) -> String {
        format!(
            "{} nodes ({} files, {} functions, {} types), {} edges",
            self.graph.node_count(),
            self.file_nodes.len(),
            self.graph
                .node_weights()
                .filter(|n| n.kind == NodeKind::Function)
                .count(),
            self.graph
                .node_weights()
                .filter(|n| n.kind == NodeKind::TypeDef)
                .count(),
            self.graph.edge_count(),
        )
    }

    /// Serialize the full graph to JSON — useful for debugging or frontend display.
    pub fn to_json(&self) -> serde_json::Value {
        let nodes: Vec<_> = self
            .graph
            .node_weights()
            .map(|n| serde_json::to_value(n).unwrap_or_default())
            .collect();

        let edges: Vec<_> = self
            .graph
            .edge_indices()
            .filter_map(|eidx| {
                let (src, tgt) = self.graph.edge_endpoints(eidx)?;
                Some(serde_json::json!({
                    "from":  self.graph[src].id,
                    "to":    self.graph[tgt].id,
                    "kind":  format!("{:?}", self.graph[eidx]),
                }))
            })
            .collect();

        serde_json::json!({ "nodes": nodes, "edges": edges })
    }

    #[allow(dead_code)]
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }
    #[allow(dead_code)]
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    /// Get or create a File node for `path`. Returns its NodeIndex.
    fn ensure_file_node(&mut self, path: &str) -> NodeIndex {
        let id = format!("file:{}", path);
        if let Some(&idx) = self.index.get(&id) {
            return idx;
        }
        let name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());

        let node = GraphNode {
            id: id.clone(),
            kind: NodeKind::File,
            name,
            path: path.to_string(),
            line: None,
            type_kind: None,
        };
        let idx = self.graph.add_node(node);
        self.index.insert(id.clone(), idx);
        self.file_nodes
            .entry(path.to_string())
            .or_default()
            .push(id);
        idx
    }

    /// Parse a file's content and add Function/TypeDef nodes + Imports/Defines edges.
    fn index_file_content(&mut self, path: &str, content: &str, known_files: &HashSet<String>) {
        let parsed = parse_file(path, content);
        let file_idx = self.ensure_file_node(path);

        // ── Function nodes ────────────────────────────────────────────────────
        for func in &parsed.functions {
            let id = format!("fn:{}::{}", path, func.name);
            if self.index.contains_key(&id) {
                continue;
            }
            let node = GraphNode {
                id: id.clone(),
                kind: NodeKind::Function,
                name: func.name.clone(),
                path: path.to_string(),
                line: Some(func.line),
                type_kind: None,
            };
            let fn_idx = self.graph.add_node(node);
            self.index.insert(id.clone(), fn_idx);
            self.file_nodes
                .entry(path.to_string())
                .or_default()
                .push(id);
            self.graph.add_edge(file_idx, fn_idx, EdgeKind::Defines);
        }

        // ── TypeDef nodes ─────────────────────────────────────────────────────
        for t in &parsed.types {
            let id = format!("type:{}::{}", path, t.name);
            if self.index.contains_key(&id) {
                continue;
            }
            let node = GraphNode {
                id: id.clone(),
                kind: NodeKind::TypeDef,
                name: t.name.clone(),
                path: path.to_string(),
                line: Some(t.line),
                type_kind: Some(t.kind.clone()),
            };
            let type_idx = self.graph.add_node(node);
            self.index.insert(id.clone(), type_idx);
            self.file_nodes
                .entry(path.to_string())
                .or_default()
                .push(id);
            self.graph.add_edge(file_idx, type_idx, EdgeKind::Defines);
        }

        // ── Imports edges (File → File) ───────────────────────────────────────
        for raw_import in &parsed.raw_imports {
            if let Some(resolved) = resolve_import(raw_import, path, known_files) {
                let target_idx = self.ensure_file_node(&resolved);

                // Avoid duplicate Imports edges
                let already_linked = self
                    .graph
                    .edges_directed(file_idx, Direction::Outgoing)
                    .any(|e| e.target() == target_idx && e.weight() == &EdgeKind::Imports);

                if !already_linked {
                    self.graph.add_edge(file_idx, target_idx, EdgeKind::Imports);
                }
            }
        }
    }

    /// Wipe all nodes (and their edges) that were contributed by `path`.
    /// StableDiGraph ensures remaining NodeIndexes stay valid after removals.
    fn remove_file_nodes(&mut self, path: &str) {
        if let Some(node_ids) = self.file_nodes.remove(path) {
            for id in node_ids {
                if let Some(idx) = self.index.remove(&id) {
                    self.graph.remove_node(idx);
                }
            }
        }
    }

    /// Build a compact one-line summary of everything a File node defines:
    /// `"verifyToken(), hashPassword(), [interface] AuthConfig, [enum] Role"`
    fn file_define_summary(&self, file_idx: NodeIndex) -> String {
        let mut fns: Vec<String> = vec![];
        let mut types: Vec<String> = vec![];

        for e in self.graph.edges_directed(file_idx, Direction::Outgoing) {
            if e.weight() != &EdgeKind::Defines {
                continue;
            }
            let node = &self.graph[e.target()];
            match node.kind {
                NodeKind::Function => fns.push(format!("{}()", node.name)),
                NodeKind::TypeDef => {
                    let prefix = node.type_kind.as_deref().unwrap_or("type");
                    types.push(format!("[{}] {}", prefix, node.name));
                }
                NodeKind::File => {}
            }
        }

        fns.sort();
        types.sort();
        let mut all = fns;
        all.extend(types);
        all.join(", ")
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn test_build_and_query() {
        let map = make_map(&[
            (
                "src/utils.ts",
                "export function helper() {}\nexport type Config = {}",
            ),
            (
                "src/app.ts",
                "import { helper } from './utils'\nexport function main() {}",
            ),
        ]);

        let mut g = CodeGraph::new();
        g.build_from_map(&map);

        // app.ts should have an Imports edge to utils.ts
        let ctx = g.query_context("src/app.ts");
        assert!(ctx.contains("src/utils.ts"), "Missing import edge: {}", ctx);
        assert!(
            ctx.contains("helper()"),
            "Missing function from utils: {}",
            ctx
        );

        // utils.ts reverse-import should mention app.ts
        let ctx2 = g.query_context("src/utils.ts");
        assert!(
            ctx2.contains("src/app.ts"),
            "Missing reverse import: {}",
            ctx2
        );
    }

    #[test]
    fn test_incremental_update() {
        let map = make_map(&[("src/a.ts", "export function foo() {}")]);
        let mut g = CodeGraph::new();
        g.build_from_map(&map);

        let known: HashSet<String> = map.keys().cloned().collect();
        g.update_file("src/a.ts", "export function bar() {}", &known);

        let ctx = g.query_context("src/a.ts");
        assert!(
            ctx.contains("bar()"),
            "Should have bar after update: {}",
            ctx
        );
        assert!(
            !ctx.contains("foo()"),
            "foo() should be gone after update: {}",
            ctx
        );
    }

    #[test]
    fn test_empty_file_returns_empty_context() {
        let g = CodeGraph::new();
        let ctx = g.query_context("nonexistent.ts");
        assert!(ctx.is_empty());
    }
}
