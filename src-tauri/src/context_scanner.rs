use log::{error, info, warn};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use walkdir::WalkDir;

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};

use crate::graph::CodeGraph;

pub fn should_ignore(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    name.starts_with('.')
        || name == "node_modules"
        || name == "dist"
        || name == "__pycache__"
        || name == "target"
        || name.ends_with(".png")
        || name.ends_with(".jpg")
        || name.ends_with(".lock")
        || name.ends_with(".exe")
        || name.ends_with(".so")
        || name.ends_with(".dll")
}

/// Start the background project scanner.
///
/// 1. Does an initial full walk to populate `context_map` (path → content).
/// 2. Builds the `CodeGraph` from the populated map — gives every AI model
///    structural context (imports, definitions, reverse deps) on first use.
/// 3. Watches for file changes; on each change, updates both the context map
///    and the graph incrementally (no full rebuild needed).
pub async fn start_scanner(
    root: PathBuf,
    context_map_ref: Arc<Mutex<HashMap<String, String>>>,
    graph_ref: Arc<Mutex<CodeGraph>>,
    summary_cache_ref: Arc<Mutex<Option<String>>>,
    app: AppHandle,
) {
    info!("Starting project context scanner for {:?}", root);

    // ── Initial full scan ─────────────────────────────────────────────────────
    let root_clone = root.clone();
    let map_clone = Arc::clone(&context_map_ref);
    let graph_clone = Arc::clone(&graph_ref);
    let app_scan = app.clone();

    tokio::task::spawn_blocking(move || {
        let walker = WalkDir::new(&root_clone)
            .into_iter()
            .filter_entry(|e| !should_ignore(e));

        let mut initial_map: HashMap<String, String> = HashMap::new();

        for entry in walker.flatten() {
            if entry.file_type().is_file() {
                let path = entry.path();
                if let Ok(rel_path) = path.strip_prefix(&root_clone) {
                    if let Ok(content) = std::fs::read_to_string(path) {
                        let uniform_path = rel_path.to_string_lossy().replace('\\', "/");
                        initial_map.insert(uniform_path, content);
                    }
                }
            }
        }

        // Build graph from initial_map BEFORE moving it into the shared map —
        // avoids holding two locks at once.
        let mut graph = graph_clone.blocking_lock();
        graph.build_from_map(&initial_map);
        let stats = graph.stats();
        info!("CodeGraph ready: {}", stats);
        drop(graph);

        // Tell the frontend the graph is populated. Without this, the Constellation
        // view fetches once on mount — often BEFORE this background scan finishes —
        // gets an empty graph, and never refetches (its only other trigger is a
        // changelog commit), so it renders empty until the user happens to save.
        let _ = app_scan.emit("graph_ready", serde_json::json!({ "stats": stats }));

        // Commit context map
        let mut map = map_clone.blocking_lock();
        *map = initial_map;
        info!(
            "Project context map fully synchronised ({} files).",
            map.len()
        );
    });

    // ── Incremental file watcher ──────────────────────────────────────────────
    let root_watch = root.clone();
    let map_watch = Arc::clone(&context_map_ref);
    let graph_watch = Arc::clone(&graph_ref);
    let summary_watch = Arc::clone(&summary_cache_ref);

    tokio::task::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(500), tx) {
            Ok(d) => d,
            Err(e) => {
                error!("Failed to build file debouncer: {}", e);
                return;
            }
        };

        if let Err(e) = debouncer
            .watcher()
            .watch(&root_watch, RecursiveMode::Recursive)
        {
            error!("Failed to watch {:?}: {}", root_watch, e);
            return;
        }

        for res in rx {
            match res {
                Ok(events) => {
                    for event in events {
                        let path = event.path;

                        // Apply ignore rules
                        if path.components().any(|c| {
                            let s = c.as_os_str().to_string_lossy();
                            s.starts_with('.')
                                || s == "node_modules"
                                || s == "target"
                                || s == "dist"
                        }) {
                            continue;
                        }

                        // Notify frontend of ANY fs change (create, modify, delete)
                        // so it can refresh the tree / reload clean buffers.
                        if let Ok(rel) = path.strip_prefix(&root_watch) {
                            let uniform = rel.to_string_lossy().replace('\\', "/");
                            let _ = app.emit(
                                "fs_external_change",
                                serde_json::json!({ "path": uniform }),
                            );
                        }

                        // Any change (including create/delete/rename) can alter the
                        // project summary's tree — drop the cache so the next AI
                        // message rebuilds it fresh.
                        *summary_watch.blocking_lock() = None;

                        if !path.is_file() {
                            continue;
                        }

                        if let Ok(rel_path) = path.strip_prefix(&root_watch) {
                            if let Ok(content) = std::fs::read_to_string(&path) {
                                let uniform_path = rel_path.to_string_lossy().replace('\\', "/");

                                // Update context map first
                                let mut map = map_watch.blocking_lock();
                                map.insert(uniform_path.clone(), content.clone());
                                let known_files: HashSet<String> = map.keys().cloned().collect();
                                drop(map);

                                // Then update graph with the current known_files set
                                let mut graph = graph_watch.blocking_lock();
                                graph.update_file(&uniform_path, &content, &known_files);
                                drop(graph);
                            }
                        }
                    }
                }
                Err(e) => warn!("Watch error: {:?}", e),
            }
        }
    });
}
