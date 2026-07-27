//! Tauri commands exposed to the React frontend

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use std::collections::HashMap;

use crate::{
    changelog::Changelog, context_scanner::start_scanner, graph::CodeGraph, model::ModelClient,
    network::NetworkNode, orchestrator::Orchestrator, types::*,
};

/// Global app state managed by Tauri
pub struct AppState {
    pub identity: Mutex<Option<UserIdentity>>,
    pub model_config: Mutex<Option<ModelConfig>>,
    pub project: Mutex<Option<Project>>,
    pub project_context: Arc<Mutex<HashMap<String, String>>>,
    /// Semantic knowledge graph — built from project files, updated on every file change.
    /// Gives each AI model structural context (imports, reverse-deps, definitions)
    /// instead of just raw file content.
    pub code_graph: Arc<Mutex<CodeGraph>>,
    /// Cached project summary (dir tree + type detection). Rebuilding this walks
    /// the filesystem, so it's cached here and invalidated by the scanner whenever
    /// a file changes — instead of re-walking on every single AI message.
    pub project_summary_cache: Arc<Mutex<Option<String>>>,
    pub changelog: Mutex<Option<Changelog>>,
    pub orchestrator: Arc<Orchestrator>,
    pub model_client: Arc<ModelClient>,
    pub network: Arc<NetworkNode>,
    /// Ordered failover list (B4) — user-editable, synced from the frontend.
    pub rotation: Arc<Mutex<Vec<ModelConfig>>>,
    /// Per-provider request counts vs known free-tier caps.
    pub usage: Arc<Mutex<HashMap<String, crate::rotation::ProviderUsage>>>,
    /// Label of the model that served the previous request (B5 handoff).
    pub last_model_used: Arc<Mutex<Option<String>>>,
    /// Handle of the in-flight chat generation — abortable via cancel_ai.
    pub ai_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Language server host (A4) — one server per language group.
    pub lsp: Arc<crate::lsp::LspManager>,
    /// Remote writes held back because the local copy diverged. Kept here (not
    /// just fired as an event) so a resolver panel can repopulate after a reload
    /// instead of stranding an unresolved conflict off-screen.
    pub pending_conflicts: Arc<Mutex<Vec<ConflictInfo>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            identity: Mutex::new(None),
            model_config: Mutex::new(None),
            project: Mutex::new(None),
            project_context: Arc::new(Mutex::new(HashMap::new())),
            code_graph: Arc::new(Mutex::new(CodeGraph::new())),
            project_summary_cache: Arc::new(Mutex::new(None)),
            changelog: Mutex::new(None),
            orchestrator: Arc::new(Orchestrator::new()),
            model_client: Arc::new(ModelClient::new()),
            network: Arc::new(NetworkNode::new()),
            rotation: Arc::new(Mutex::new(Vec::new())),
            usage: Arc::new(Mutex::new(HashMap::new())),
            last_model_used: Arc::new(Mutex::new(None)),
            ai_task: Arc::new(Mutex::new(None)),
            lsp: Arc::new(crate::lsp::LspManager::new()),
            pending_conflicts: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

// ─── Conflict resolution ────────────────────────────────────────────────────

/// Conflicts still awaiting a decision. The resolver panel calls this on mount
/// so a reload never loses track of an unresolved merge.
#[tauri::command]
pub async fn list_conflicts(state: State<'_, AppState>) -> Result<Vec<ConflictInfo>, String> {
    Ok(state.pending_conflicts.lock().await.clone())
}

/// Drop a conflict once it has been resolved (the resolved content is written
/// separately, through `commit_write`, so it flows through the ledger and back
/// out to peers like any other change). Idempotent: dismissing an unknown id is
/// a no-op, so a double-click or a stale panel can't error.
#[tauri::command]
pub async fn dismiss_conflict(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.pending_conflicts.lock().await.retain(|c| c.id != id);
    Ok(())
}

// ─── LSP bridge (A4) ──────────────────────────────────────────────────────────

/// Start (or confirm) the language server for a language group.
/// Returns { ok, hint? } — a missing binary is a soft failure with an
/// install hint, not an error.
#[tauri::command]
pub async fn lsp_start(
    lang: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| p.root_path.clone())
        .ok_or("No project open")?;

    match crate::lsp::start(Arc::clone(&state.lsp), app, lang, root).await {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(hint) => Ok(json!({ "ok": false, "hint": hint })),
    }
}

#[tauri::command]
pub async fn lsp_request(
    lang: String,
    method: String,
    params: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state
        .lsp
        .servers
        .lock()
        .await
        .get(&lang)
        .cloned()
        .ok_or("not_running")?;
    server.request(&method, params, 25).await
}

#[tauri::command]
pub async fn lsp_notify(
    lang: String,
    method: String,
    params: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let server = state
        .lsp
        .servers
        .lock()
        .await
        .get(&lang)
        .cloned()
        .ok_or("not_running")?;
    server.notify(&method, params).await;
    Ok(())
}

/// Abort the in-flight chat generation (T0-3).
#[tauri::command]
pub async fn cancel_ai(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    if let Some(handle) = state.ai_task.lock().await.take() {
        handle.abort();
        let _ = app.emit("ai_write_error", json!({ "error": "Generation stopped." }));
    }
    Ok(())
}

// ─── Model rotation (B4) ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn configure_rotation(
    list: Vec<ModelConfig>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    *state.rotation.lock().await = list;
    Ok(())
}

#[tauri::command]
pub async fn get_rotation(state: State<'_, AppState>) -> Result<Vec<ModelConfig>, String> {
    Ok(state.rotation.lock().await.clone())
}

#[tauri::command]
pub async fn get_usage_stats(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(crate::rotation::usage_stats(&state.usage).await)
}

#[tauri::command]
pub async fn import_usage(
    seeds: Vec<(String, u32, String)>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::rotation::import_day_counts(&state.usage, seeds).await;
    Ok(())
}

#[tauri::command]
pub async fn start_network(
    invite_code: String,
    passphrase: String,
    identity: UserIdentity,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    NetworkNode::start(
        state.network.clone(),
        app_handle,
        &invite_code,
        &passphrase,
        identity,
    )
    .await
    .map_err(|e| e.to_string())
}

// ─── Identity ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_identity(
    identity: UserIdentity,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut lock = state.identity.lock().await;
    *lock = Some(identity);
    Ok(())
}

#[tauri::command]
pub async fn load_identity(state: State<'_, AppState>) -> Result<Option<UserIdentity>, String> {
    Ok(state.identity.lock().await.clone())
}

// ─── Model config ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn configure_model(
    config: ModelConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut lock = state.model_config.lock().await;
    *lock = Some(config);
    Ok(())
}

#[tauri::command]
pub async fn load_model_config(state: State<'_, AppState>) -> Result<Option<ModelConfig>, String> {
    Ok(state.model_config.lock().await.clone())
}

// ─── Project ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_project(
    name: String,
    passphrase: String,
    root_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Project, String> {
    let root = PathBuf::from(&root_path);
    let invite_code = generate_invite_code();

    let project = Project {
        id: format!("proj_{}", uuid::Uuid::new_v4()),
        name,
        invite_code,
        root_path: root_path.clone(),
        created_at: Utc::now(),
        owner: state
            .identity
            .lock()
            .await
            .as_ref()
            .map(|i| i.username.clone())
            .unwrap_or_default(),
    };

    // Open or create the changelog — if decryption fails (wrong passphrase for existing file),
    let cl = Changelog::open(&root, &passphrase).await.map_err(|e| {
        format!(
            "Could not unlock this 0G changelog. Check the passphrase. {}",
            e
        )
    })?;
    // Rename the undecryptable file rather than deleting it — preserves data

    let manifest_path = root.join(".0g").join("manifest.json");
    if !manifest_path.exists() {
        let manifest = ProjectManifest {
            members: vec![Member {
                username: project.owner.clone(),
                permission: Permission::Owner,
            }],
        };
        tokio::fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .await
        .ok();
    }

    *state.project.lock().await = Some(project.clone());
    *state.changelog.lock().await = Some(cl);

    // Initialize the file watcher, context map, and code graph
    state.project_context.lock().await.clear();
    *state.code_graph.lock().await = CodeGraph::new();
    *state.project_summary_cache.lock().await = None;
    start_scanner(
        root.clone(),
        Arc::clone(&state.project_context),
        Arc::clone(&state.code_graph),
        Arc::clone(&state.project_summary_cache),
        app.clone(),
    )
    .await;

    Ok(project)
}

#[tauri::command]
pub async fn get_project(state: State<'_, AppState>) -> Result<Option<Project>, String> {
    Ok(state.project.lock().await.clone())
}

#[tauri::command]
pub async fn join_project(
    invite_code: String,
    passphrase: String,
    root_path: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Project, String> {
    let root = PathBuf::from(&root_path);

    // Try to open existing changelog — fails gracefully if not yet synced
    let cl_result = Changelog::open(&root, &passphrase).await;

    let project = Project {
        id: format!("proj_{}", uuid::Uuid::new_v4()),
        name: format!("Project-{}", invite_code),
        invite_code: invite_code.to_uppercase(),
        root_path,
        created_at: Utc::now(),
        owner: String::new(),
    };

    *state.project.lock().await = Some(project.clone());
    if let Ok(cl) = cl_result {
        *state.changelog.lock().await = Some(cl);
    }

    // Initialize the file watcher, context map, and code graph
    state.project_context.lock().await.clear();
    *state.code_graph.lock().await = CodeGraph::new();
    *state.project_summary_cache.lock().await = None;
    start_scanner(
        root.clone(),
        Arc::clone(&state.project_context),
        Arc::clone(&state.code_graph),
        Arc::clone(&state.project_summary_cache),
        app.clone(),
    )
    .await;

    let manifest_path = root.join(".0g").join("manifest.json");
    if !manifest_path.exists() {
        // Fallback if missing
        let current_user = state
            .identity
            .lock()
            .await
            .as_ref()
            .map(|i| i.username.clone())
            .unwrap_or_default();
        let manifest = ProjectManifest {
            members: vec![Member {
                username: current_user,
                permission: Permission::Owner,
            }],
        };
        tokio::fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .await
        .ok();
    } else if let Ok(data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(mut manifest) = serde_json::from_str::<ProjectManifest>(&data) {
            let current_user = state
                .identity
                .lock()
                .await
                .as_ref()
                .map(|i| i.username.clone())
                .unwrap_or_default();
            if !manifest.members.iter().any(|m| m.username == current_user) {
                manifest.members.push(Member {
                    username: current_user,
                    permission: Permission::Alter,
                });
                tokio::fs::write(
                    &manifest_path,
                    serde_json::to_string_pretty(&manifest).unwrap(),
                )
                .await
                .ok();
            }
        }
    }

    Ok(project)
}

// ─── File system ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_file_tree(state: State<'_, AppState>) -> Result<Vec<FileNode>, String> {
    let project_lock = state.project.lock().await;
    let root = match &*project_lock {
        Some(p) => PathBuf::from(&p.root_path),
        None => return Ok(vec![]),
    };
    drop(project_lock);

    build_file_tree(&root, &root).map_err(|e| e.to_string())
}

fn build_file_tree(root: &PathBuf, base: &PathBuf) -> Result<Vec<FileNode>, anyhow::Error> {
    let mut nodes = vec![];
    for entry in walkdir::WalkDir::new(root)
        .min_depth(1)
        .max_depth(1)
        .sort_by_file_name()
    {
        let entry = entry?;
        let path = entry
            .path()
            .strip_prefix(base)?
            .to_string_lossy()
            .replace('\\', "/");

        // Skip hidden directories
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        if entry.file_type().is_dir() {
            let children = build_file_tree(&entry.path().to_path_buf(), base).unwrap_or_default();
            nodes.push(FileNode {
                name: entry.file_name().to_string_lossy().to_string(),
                path,
                is_dir: true,
                children: Some(children),
                last_edited_by: None,
                last_edited_at: None,
                last_editor_color: None,
            });
        } else {
            nodes.push(FileNode {
                name: entry.file_name().to_string_lossy().to_string(),
                path,
                is_dir: false,
                children: None,
                last_edited_by: None,
                last_edited_at: None,
                last_editor_color: None,
            });
        }
    }
    Ok(nodes)
}

fn normalize_project_path(path: &str) -> Result<String, String> {
    if path.trim().is_empty() || Path::new(path).is_absolute() {
        return Err("Invalid project-relative path".into());
    }

    let mut parts = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                let segment = part
                    .to_str()
                    .ok_or_else(|| "Path contains non-UTF-8 characters".to_string())?;
                if segment.is_empty() {
                    return Err("Invalid project-relative path".into());
                }
                parts.push(segment.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Path must stay inside the open project".into());
            }
        }
    }

    if parts.is_empty() {
        return Err("Invalid project-relative path".into());
    }

    Ok(parts.join("/"))
}

fn join_project_path(root: &Path, path: &str) -> Result<(String, PathBuf), String> {
    let normalized = normalize_project_path(path)?;
    Ok((normalized.clone(), root.join(&normalized)))
}

#[tauri::command]
pub async fn open_file(
    path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let project_lock = state.project.lock().await;
    let root = match &*project_lock {
        Some(p) => PathBuf::from(&p.root_path),
        None => return Err("No project open".into()),
    };
    drop(project_lock);

    let (path, abs_path) = join_project_path(&root, &path)?;
    let bytes = tokio::fs::read(&abs_path)
        .await
        .map_err(|e| e.to_string())?;
    let (content, is_binary) = decode_file_preview(&path, &bytes);

    let cl_lock = state.changelog.lock().await;
    let entries = cl_lock
        .as_ref()
        .map(|cl| {
            // #6: follow rename lineage so history survives renames.
            // A rename entry's summary is "Renamed from {old_path}".
            let mut collected = cl.last_n_for_file(&path, 10);
            let mut current = path.clone();
            for _ in 0..5 {
                let Some(old) = cl
                    .get_filtered(Some(&current), None, None)
                    .iter()
                    .find_map(|e| e.summary.strip_prefix("Renamed from ").map(|s| s.to_string()))
                else {
                    break;
                };
                collected.extend(cl.last_n_for_file(&old, 10));
                current = old;
            }
            collected.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            collected.dedup_by(|a, b| a.id == b.id);
            collected.truncate(10);
            collected
        })
        .unwrap_or_default();
    drop(cl_lock);

    Ok(json!({ "content": content, "entries": entries, "is_binary": is_binary }))
}

#[tauri::command]
pub async fn create_file(
    file: String,
    content: Option<String>,
    state: State<'_, AppState>,
) -> Result<ChangelogEntry, String> {
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }

    let (file, abs_path) = join_project_path(&root, &file)?;
    if abs_path.exists() {
        return Err(format!("File already exists: {}", file));
    }
    if let Some(parent) = abs_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let initial = content.unwrap_or_default();
    tokio::fs::write(&abs_path, initial.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let entry = ChangelogEntry {
        id: crate::changelog::new_entry_id(),
        file: file.clone(),
        changed_by: username,
        model: model_label,
        timestamp: Utc::now(),
        summary: "Created file".to_string(),
        affected_lines: vec![],
        affected_functions: vec![],
        previous_content: None,
        status: EntryStatus::Committed,
        conflict_flag: false,
        session_id: None,
    };

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;
    changelog
        .append(entry.clone())
        .await
        .map_err(|e| e.to_string())?;

    state.network.broadcast_update(entry.clone(), initial).await;
    Ok(entry)
}

#[tauri::command]
pub async fn commit_write(
    file: String,
    content: String,
    summary: String,
    affected_lines: Vec<u32>,
    affected_functions: Vec<String>,
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<ChangelogEntry, String> {
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }

    let payload = CommitWritePayload {
        file: normalize_project_path(&file)?,
        content: content.clone(),
        summary,
        affected_lines,
        affected_functions,
        session_id,
    };

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;

    let orchestrator = Arc::clone(&state.orchestrator);
    let entry = orchestrator
        .intercept_write(payload, username, model_label, changelog, root)
        .await
        .map_err(|e| e.to_string())?;

    state.network.broadcast_update(entry.clone(), content).await;

    Ok(entry)
}

#[tauri::command]
pub async fn get_changelog(
    file: Option<String>,
    user: Option<String>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<ChangelogEntry>, String> {
    let cl_lock = state.changelog.lock().await;
    Ok(cl_lock
        .as_ref()
        .map(|cl| cl.get_filtered(file.as_deref(), user.as_deref(), limit))
        .unwrap_or_default())
}

#[tauri::command]
pub async fn invoke_ai(
    file: String,
    prompt: String,
    current_content: String,
    chat_context: String,
    image_base64: Option<String>,
    image_mime_type: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let config = state
        .model_config
        .lock()
        .await
        .clone()
        .ok_or("Model not configured")?;

    let root_path = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| p.root_path.clone())
        .ok_or("No project open")?;

    // Use the cached summary if the scanner hasn't invalidated it since the last
    // build; otherwise walk the tree once and repopulate the cache. This turns a
    // per-message filesystem walk into (at most) one walk per file change.
    let project_summary = {
        let cached = state.project_summary_cache.lock().await.clone();
        match cached {
            Some(s) => s,
            None => {
                let s = build_project_summary(&PathBuf::from(&root_path)).await;
                *state.project_summary_cache.lock().await = Some(s.clone());
                s
            }
        }
    };

    let project_context_guard = state.project_context.lock().await;
    let graph_guard = state.code_graph.lock().await;

    let cl_lock = state.changelog.lock().await;
    let enriched = state.orchestrator.enrich_prompt(
        &prompt,
        &file,
        &current_content,
        &project_summary,
        cl_lock.as_ref(),
        &chat_context,
        Some(&*project_context_guard),
        Some(&*graph_guard),
    );
    drop(cl_lock);
    drop(graph_guard);
    drop(project_context_guard);

    let client = Arc::clone(&state.model_client);
    let rotation_list = state.rotation.lock().await.clone();
    let usage = Arc::clone(&state.usage);
    let last_model = Arc::clone(&state.last_model_used);

    // Spawn async task — emit ai_chunk deltas while tokens stream (T0-3)
    let app_clone = app.clone();
    let file_clone = file.clone();
    let handle = tokio::spawn(async move {
        let _ = app_clone.emit("ai_write_start", json!({ "file": file_clone }));

        let image = match (image_base64, image_mime_type) {
            (Some(b64), Some(mime)) if !b64.is_empty() => Some((b64, mime)),
            _ => None,
        };
        let last_used = last_model.lock().await.clone();

        // B4/B5: failover chain with fresh-context handoff markers
        let chunk_app = app_clone.clone();
        let chunk_file = file_clone.clone();
        let mut on_chunk = move |delta: &str| {
            let _ = chunk_app.emit("ai_chunk", json!({ "file": chunk_file, "delta": delta }));
        };
        let result = crate::rotation::invoke_with_failover_stream(
            client,
            &app_clone,
            config,
            rotation_list,
            usage,
            last_used,
            enriched,
            image,
            &mut on_chunk,
        )
        .await;

        match result {
            Ok((output, served_by)) => {
                *last_model.lock().await = Some(served_by.label.clone());
                let _ = app_clone.emit(
                    "ai_write_complete",
                    json!({ "file": file_clone, "output": output, "model_used": served_by.label }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit("ai_write_error", json!({ "error": e }));
            }
        }
    });

    // Replace any previous in-flight generation
    if let Some(prev) = state.ai_task.lock().await.replace(handle) {
        prev.abort();
    }

    Ok(())
}

// ─── Collaborators (Phase 3 stub) ─────────────────────────────────────────────

#[tauri::command]
pub async fn get_collaborators(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let peers: Vec<serde_json::Value> = state
        .network
        .peer_info
        .read()
        .await
        .values()
        .cloned()
        .map(|p| serde_json::to_value(p).unwrap())
        .collect();
    Ok(peers)
}

#[tauri::command]
pub async fn broadcast_peer_status(
    status: String,
    current_file: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = state.network.peer_id.clone();
    state
        .network
        .broadcast_status(&id, &status, current_file)
        .await;
    Ok(())
}

/// T1: relay a CRDT payload to all peers. Returns our stable network peer_id
/// so the frontend can label/deduplicate its own presence.
#[tauri::command]
pub async fn broadcast_crdt(
    doc: String,
    kind: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.network.broadcast_crdt(doc, kind, data).await;
    Ok(())
}

#[tauri::command]
pub async fn get_peer_id(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.network.peer_id.clone())
}

/// Open the native folder picker from the Rust side (most reliable — the
/// dialog plugin is fully initialized here). Returns the chosen path, or None
/// if the user cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let path = folder.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string());
        let _ = tx.send(path);
    });
    rx.await.map_err(|_| "Folder dialog was dismissed unexpectedly".to_string())
}

/// T1: send a team chat line to all peers.
#[tauri::command]
pub async fn send_chat(
    username: String,
    color: String,
    text: String,
    ts: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .network
        .broadcast_chat(username, color, text, ts)
        .await;
    Ok(())
}

/// T1: our own address for manual WAN connect. LAN IP is discovered with the
/// dependency-free "connect a UDP socket to a public addr, read local_addr" trick.
#[tauri::command]
pub async fn get_network_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let port = *state.network.tcp_port.read().await;
    let ip = local_lan_ip().unwrap_or_else(|| "127.0.0.1".to_string());
    Ok(json!({
        "peer_id": state.network.peer_id.clone(),
        "tcp_port": port,
        "ip": ip,
    }))
}

/// T1: manually connect to a peer at ip:port (bypasses UDP discovery).
#[tauri::command]
pub async fn connect_peer(
    addr: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    crate::network::NetworkNode::connect_to(state.network.clone(), app, &addr)
        .await
        .map_err(|e| format!("Could not connect to {}: {}", addr, e))
}

fn local_lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // No packet is actually sent; this just selects the outbound interface.
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

#[tauri::command]
pub async fn apply_code(
    file: String,
    snippet: String,
    current_content: String,
    chat_context: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<ChangelogEntry, String> {
    let config = state
        .model_config
        .lock()
        .await
        .clone()
        .ok_or("Model not configured")?;

    // Fast path: if the file is empty, the snippet IS the new content — no merge needed
    let merged_content = if current_content.trim().is_empty() {
        extract_code_from_fences(&snippet)
    } else {
        // Include truncated conversation context so the merge AI understands
        // the user's intent, not just the raw code snippet.
        let context_hint = if chat_context.is_empty() {
            String::new()
        } else {
            let truncated = if chat_context.len() > 2000 {
                let start = chat_context.len() - 2000;
                let safe_start = chat_context[start..]
                    .find('\n')
                    .map(|i| start + i + 1)
                    .unwrap_or(start);
                &chat_context[safe_start..]
            } else {
                &chat_context
            };
            format!(
                "\nCONVERSATION CONTEXT (understand the user's intent from this):\n{}\n",
                truncated
            )
        };

        let prompt = format!(
            "You are a deterministic senior software engineer specialized in precise source-code integration.\n\
            Your sole responsibility is to merge the provided SNIPPET into the CURRENT FILE with maximum correctness and zero regressions.\n\
            \n\
            OUTPUT RULES (MANDATORY):\n\
            - Return ONLY the final merged file.\n\
            - Output exactly ONE markdown code block.\n\
            - No explanations, no commentary, no markdown outside the code block.\n\
            - Never truncate code.\n\
            - Never use placeholders such as '...', '// existing code', 'TODO', or omitted sections.\n\
            - The response must be a complete, compilable, production-ready file.\n\
            \n\
            PRIMARY OBJECTIVE:\n\
            Integrate the snippet naturally into the existing architecture while preserving all valid existing behavior.\n\
            \n\
            MERGE DIRECTIVES:\n\
            1. Fully analyze the CURRENT FILE before modifying anything.\n\
            2. Infer the intended integration point and surrounding architecture.\n\
            3. Preserve existing logic unless the snippet explicitly replaces or modifies it.\n\
            4. Resolve:\n\
               - duplicate imports\n\
               - symbol conflicts\n\
               - naming collisions\n\
               - incompatible scopes\n\
               - stale references\n\
               - dependency ordering issues\n\
            5. Maintain the file's existing:\n\
               - coding style\n\
               - formatting\n\
               - naming conventions\n\
               - architectural patterns\n\
               - typing patterns\n\
            6. Ensure all introduced code is fully wired into the system.\n\
            7. Update related logic if required for correctness.\n\
            8. Remove obsolete or conflicting code ONLY if necessary.\n\
            9. Preserve meaningful comments and documentation.\n\
            10. Ensure the final result is syntactically and semantically valid.\n\
            \n\
            CRITICAL VALIDATION CHECKLIST:\n\
            Before producing the final answer, internally verify:\n\
            - imports are valid\n\
            - no duplicate definitions exist\n\
            - references resolve correctly\n\
            - function/class integrations are complete\n\
            - control flow remains intact\n\
            - indentation and formatting are correct\n\
            - no partial implementations remain\n\
            - no runtime-breaking omissions exist\n\
            \n\
            HARD FAILURE CONDITIONS:\n\
            - incomplete merges\n\
            - broken syntax\n\
            - unresolved references\n\
            - duplicated logic blocks\n\
            - orphaned code\n\
            - missing integrations\n\
            - placeholder text\n\
            - shortened output\n\
            {3}\n\
            CURRENT FILE ({0}):\n\
            ```\n{1}\n```\n\
            \n\
            SNIPPET TO MERGE:\n\
            ```\n{2}\n```",
            file,
            current_content,
            snippet,
            context_hint,
        );

        // Merge prompts are self-contained — failover applies, handoff doesn't
        let rotation_list = state.rotation.lock().await.clone();
        let (output, served_by) = crate::rotation::invoke_with_failover(
            Arc::clone(&state.model_client),
            &app,
            config.clone(),
            rotation_list,
            Arc::clone(&state.usage),
            None,
            prompt,
            None,
        )
        .await?;
        *state.last_model_used.lock().await = Some(served_by.label);

        let extracted = extract_code_from_fences(&output);

        // Validation: reject obviously broken merge results
        if extracted.trim().is_empty() {
            return Err("AI merge returned empty output — apply aborted. Try again.".into());
        }

        // Detect prose contamination — the model returned explanation instead of code
        let first_line = extracted.lines().next().unwrap_or("").trim().to_lowercase();
        let prose_markers = [
            "here's", "here is", "i've", "i have", "below is", "the merged",
            "sure,", "certainly", "of course", "let me",
        ];
        if prose_markers.iter().any(|m| first_line.starts_with(m)) {
            return Err(
                "AI merge returned prose instead of code — apply aborted. Try again.".into(),
            );
        }

        extracted
    };

    // Commit logic
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;
    let file = normalize_project_path(&file)?;

    let payload = CommitWritePayload {
        file,
        content: merged_content.clone(),
        summary: "Applied AI snippet via merge".to_string(),
        affected_lines: vec![],
        affected_functions: vec![],
        session_id: None,
    };

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;

    let orchestrator = Arc::clone(&state.orchestrator);
    let entry = orchestrator
        .intercept_write(payload, username, model_label, changelog, root)
        .await
        .map_err(|e| e.to_string())?;

    state
        .network
        .broadcast_update(entry.clone(), merged_content)
        .await;

    Ok(entry)
}

// ─── Graph ────────────────────────────────────────────────────────────────────

/// Returns the structural graph context string for a given file.
/// Frontend can use this to display import maps, or it can be called
/// programmatically to preview what context the AI will receive.
#[tauri::command]
pub async fn get_graph_context(file: String, state: State<'_, AppState>) -> Result<String, String> {
    let graph = state.code_graph.lock().await;
    Ok(graph.query_context(&file))
}

/// Returns a JSON snapshot of the full project knowledge graph.
/// Useful for debugging and for building a visual graph explorer in the UI.
#[tauri::command]
pub async fn get_graph_json(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let graph = state.code_graph.lock().await;
    Ok(graph.to_json())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn generate_invite_code() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..6)
        .map(|_| {
            let idx = rand::random::<u8>() as usize % CHARS.len();
            CHARS[idx] as char
        })
        .collect()
}

pub async fn build_project_summary(root: &std::path::Path) -> String {
    let mut st = String::new();
    let mut tree = String::new();
    let mut key_files = Vec::new();
    let mut readme_content = String::new();
    let mut file_count = 0;

    let walker = walkdir::WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| !crate::context_scanner::should_ignore(e));

    for entry in walker {
        if let Ok(e) = entry {
            if file_count > 100 {
                tree.push_str("  ... (truncated)\n");
                break;
            }
            if let Ok(rel) = e.path().strip_prefix(root) {
                let indent = "  ".repeat(rel.components().count().saturating_sub(1));
                let name = e.file_name().to_string_lossy();
                tree.push_str(&format!("{}|-- {}\n", indent, name));
                if !e.file_type().is_dir() {
                    file_count += 1;
                    let n = name.as_ref();
                    if [
                        "package.json",
                        "Cargo.toml",
                        "main.rs",
                        "index.js",
                        "App.tsx",
                        "app.py",
                        "requirements.txt",
                        "go.mod",
                    ]
                    .contains(&n)
                    {
                        key_files.push(rel.to_string_lossy().to_string());
                    }
                    if n.to_lowercase() == "readme.md" && readme_content.is_empty() {
                        if let Ok(content) = std::fs::read_to_string(e.path()) {
                            readme_content = content.chars().take(500).collect();
                        }
                    }
                }
            }
        }
    }

    let mut project_type = "Generic / Unknown Workspace".to_string();
    if root.join("package.json").exists() {
        project_type = "Node.js (NPM/Yarn) Application".to_string();
    } else if root.join("Cargo.toml").exists() {
        project_type = "Rust Cargo Workspace".to_string();
    } else if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        project_type = "Python Application".to_string();
    } else if root.join("go.mod").exists() {
        project_type = "Go Application".to_string();
    }

    st.push_str(&format!("Project Type: {}\n", project_type));
    st.push_str("Project Structure:\n");
    st.push_str(&tree);
    st.push_str(&format!("Key Files: {}\n", key_files.join(", ")));
    if !readme_content.is_empty() {
        st.push_str(&format!(
            "README: {}\n...\n",
            readme_content.replace("\n", "  ")
        ));
    }

    st
}

fn decode_file_preview(path: &str, bytes: &[u8]) -> (String, bool) {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), false);
    }

    let preview_len = bytes.len().min(1024);
    let mut preview = String::new();
    preview.push_str(&format!(
        "# Binary preview: {}\n# {} bytes. This file is opened read-only.\n\n",
        path,
        bytes.len()
    ));

    for (offset, chunk) in bytes[..preview_len].chunks(16).enumerate() {
        let absolute = offset * 16;
        let hex = chunk
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ");
        let ascii = chunk
            .iter()
            .map(|b| {
                if b.is_ascii_graphic() || *b == b' ' {
                    *b as char
                } else {
                    '.'
                }
            })
            .collect::<String>();
        preview.push_str(&format!("{:08X}  {:<47}  {}\n", absolute, hex, ascii));
    }

    if bytes.len() > preview_len {
        preview.push_str("\n# Preview truncated.\n");
    }

    (preview, true)
}

#[tauri::command]
pub async fn revert_file(
    entry_id: String,
    state: State<'_, AppState>,
) -> Result<ChangelogEntry, String> {
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;

    let (file, previous_content) = {
        let target_entry = changelog
            .find_by_id(&entry_id)
            .ok_or_else(|| format!("Changelog entry {} not found", entry_id))?;

        let file = target_entry.file.clone();
        let previous_content = target_entry
            .previous_content
            .clone()
            .ok_or_else(|| format!("No previous content available for entry {}", entry_id))?;
        (file, previous_content)
    };

    let payload = CommitWritePayload {
        file: file.clone(),
        content: previous_content.clone(),
        summary: format!("Reverted changes from entry {}", entry_id),
        affected_lines: vec![],
        affected_functions: vec![],
        session_id: None,
    };

    let orchestrator = Arc::clone(&state.orchestrator);
    let entry = orchestrator
        .intercept_write(payload, username, model_label, changelog, root)
        .await
        .map_err(|e| e.to_string())?;

    state
        .network
        .broadcast_update(entry.clone(), previous_content)
        .await;

    Ok(entry)
}

/// Undo an entire agent run in one action.
///
/// A run can touch many files; reverting them one entry at a time is both tedious
/// and wrong — reverting the *latest* entry for a file only rewinds its last
/// write, not the run's first touch. So for each file the run changed we take the
/// EARLIEST entry in the session, whose `previous_content` is the file's state
/// before the run began, and restore that. Files the run created (no prior
/// content) are removed. Every restore flows through the orchestrator and the
/// ledger, so the undo is itself an attributed, revertible change — and syncs to
/// peers like any other.
#[tauri::command]
pub async fn revert_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChangelogEntry>, String> {
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;

    // Earliest entry per file in this session = that file's pre-run baseline.
    let mut baseline: HashMap<String, ChangelogEntry> = HashMap::new();
    for e in changelog.all_entries() {
        if e.session_id.as_deref() == Some(session_id.as_str()) {
            baseline
                .entry(e.file.clone())
                .and_modify(|cur| {
                    if e.timestamp < cur.timestamp {
                        *cur = e.clone();
                    }
                })
                .or_insert_with(|| e.clone());
        }
    }
    if baseline.is_empty() {
        return Err("No changes found for that agent run".into());
    }

    // Deterministic order so the ledger reads cleanly and tests are stable.
    let mut files: Vec<ChangelogEntry> = baseline.into_values().collect();
    files.sort_by(|a, b| a.file.cmp(&b.file));

    let mut reverted = Vec::new();
    let mut stale: Vec<String> = Vec::new();

    for base in files {
        match base.previous_content.clone() {
            Some(prev) => {
                let payload = CommitWritePayload {
                    file: base.file.clone(),
                    content: prev.clone(),
                    summary: format!("Undo agent run · {}", base.summary),
                    affected_lines: vec![],
                    affected_functions: vec![],
                    session_id: None,
                };
                let entry = state
                    .orchestrator
                    .intercept_write(
                        payload,
                        username.clone(),
                        model_label.clone(),
                        changelog,
                        root.clone(),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                state.network.broadcast_update(entry.clone(), prev).await;
                reverted.push(entry);
            }
            None => {
                // No prior content. Either the run created the file (undo = delete
                // it) or the snapshot was pruned from the ledger (can't restore).
                let abs = root.join(&base.file);
                if abs.exists() {
                    if tokio::fs::remove_file(&abs).await.is_err() {
                        stale.push(base.file.clone());
                        continue;
                    }
                    let entry = ChangelogEntry {
                        id: crate::changelog::new_entry_id(),
                        file: base.file.clone(),
                        changed_by: username.clone(),
                        model: model_label.clone(),
                        timestamp: Utc::now(),
                        summary: "Undo agent run · removed created file".to_string(),
                        affected_lines: vec![],
                        affected_functions: vec![],
                        previous_content: None,
                        status: EntryStatus::Committed,
                        conflict_flag: false,
                        session_id: None,
                    };
                    changelog
                        .append(entry.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                    state.network.broadcast_delete(entry.clone()).await;
                    reverted.push(entry);
                } else {
                    stale.push(base.file.clone());
                }
            }
        }
    }

    if reverted.is_empty() {
        return Err(format!(
            "This run is too old to undo automatically — its pre-change snapshots have been pruned from the ledger ({} file{}).",
            stale.len(),
            if stale.len() == 1 { "" } else { "s" }
        ));
    }

    Ok(reverted)
}

// ─── File operations (A1) ─────────────────────────────────────────────────────

/// Validates a project-relative path and returns (username, model_label, root).
async fn fileop_preamble(
    path: &str,
    state: &State<'_, AppState>,
) -> Result<(String, String, PathBuf), String> {
    normalize_project_path(path)?;
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }
    Ok((username, model_label, root))
}

/// Delete a file or folder. Every deleted file gets a changelog entry with its
/// previous_content, so the existing `revert_file` command makes deletes undoable.
#[tauri::command]
pub async fn delete_path(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChangelogEntry>, String> {
    let (username, model_label, root) = fileop_preamble(&path, &state).await?;
    let (path, abs) = join_project_path(&root, &path)?;
    if !abs.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Collect the files being deleted (single file, or every file under a dir)
    let mut victims: Vec<String> = vec![];
    if abs.is_dir() {
        for e in walkdir::WalkDir::new(&abs).into_iter().flatten() {
            if e.file_type().is_file() {
                if let Ok(rel) = e.path().strip_prefix(&root) {
                    victims.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        if victims.len() > 500 {
            return Err(format!(
                "Refusing to delete {} files at once — delete subfolders individually.",
                victims.len()
            ));
        }
    } else {
        victims.push(path.clone());
    }

    // One changelog entry per file, previous_content preserved for undo
    let mut entries = vec![];
    {
        let mut cl_lock = state.changelog.lock().await;
        let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;
        for victim in &victims {
            let vabs = root.join(victim);
            let previous_content = tokio::fs::read_to_string(&vabs).await.ok();
            let entry = ChangelogEntry {
                id: crate::changelog::new_entry_id(),
                file: victim.clone(),
                changed_by: username.clone(),
                model: model_label.clone(),
                timestamp: Utc::now(),
                summary: "Deleted file".to_string(),
                affected_lines: vec![],
                affected_functions: vec![],
                previous_content,
                status: EntryStatus::Committed,
                conflict_flag: false,
                session_id: None,
            };
            changelog
                .append(entry.clone())
                .await
                .map_err(|e| e.to_string())?;
            entries.push(entry);
        }
    }

    // Remove from disk, then broadcast each delete to peers
    if abs.is_dir() {
        tokio::fs::remove_dir_all(&abs)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        tokio::fs::remove_file(&abs)
            .await
            .map_err(|e| e.to_string())?;
    }
    for entry in &entries {
        state.network.broadcast_delete(entry.clone()).await;
    }

    Ok(entries)
}

/// Rename or move a file/folder. Emits a changelog entry and a P2P rename.
#[tauri::command]
pub async fn rename_path(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<ChangelogEntry, String> {
    let (username, model_label, root) = fileop_preamble(&from, &state).await?;
    let (from, src) = join_project_path(&root, &from)?;
    let (to, dst) = join_project_path(&root, &to)?;

    if !src.exists() {
        return Err(format!("Source does not exist: {}", from));
    }
    if dst.exists() {
        return Err(format!("Target already exists: {}", to));
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::rename(&src, &dst)
        .await
        .map_err(|e| e.to_string())?;

    let entry = ChangelogEntry {
        id: crate::changelog::new_entry_id(),
        file: to.clone(),
        changed_by: username,
        model: model_label,
        timestamp: Utc::now(),
        summary: format!("Renamed from {}", from),
        affected_lines: vec![],
        affected_functions: vec![],
        previous_content: None,
        status: EntryStatus::Committed,
        conflict_flag: false,
        session_id: None,
    };

    let mut cl_lock = state.changelog.lock().await;
    let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;
    changelog
        .append(entry.clone())
        .await
        .map_err(|e| e.to_string())?;
    drop(cl_lock);

    state
        .network
        .broadcast_rename(entry.clone(), from, to)
        .await;

    Ok(entry)
}

/// Create an empty folder (local convenience — peers see it once a file lands in it).
#[tauri::command]
pub async fn create_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let (_, _, root) = fileop_preamble(&path, &state).await?;
    let (path, abs) = join_project_path(&root, &path)?;
    if abs.exists() {
        return Err(format!("Already exists: {}", path));
    }
    tokio::fs::create_dir_all(&abs)
        .await
        .map_err(|e| e.to_string())
}

/// Reveal a file/folder in the OS file manager.
#[tauri::command]
pub async fn reveal_in_explorer(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;
    let (_, abs) = join_project_path(&root, &path)?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", abs.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = abs.parent().unwrap_or(&abs);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Project-wide search & replace (A3) ───────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SearchMatch {
    pub file: String,
    pub line: u32,
    pub col: u32, // byte offset within the line
    pub len: u32, // byte length of the match
    pub line_text: String,
}

#[derive(serde::Deserialize)]
pub struct ReplaceTarget {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub len: u32,
}

/// Char-wise case-insensitive find — byte offsets always align with the
/// ORIGINAL line, so Unicode case folds can't drift replacement targets (#7).
fn find_ci(line: &str, needle_lower: &[char]) -> Vec<(usize, usize)> {
    if needle_lower.is_empty() {
        return vec![];
    }
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let mut out = vec![];
    let mut i = 0;
    while i + needle_lower.len() <= chars.len() {
        let mut ok = true;
        for (k, nc) in needle_lower.iter().enumerate() {
            if chars[i + k].1.to_lowercase().next() != Some(*nc) {
                ok = false;
                break;
            }
        }
        if ok {
            let start = chars[i].0;
            let end = chars
                .get(i + needle_lower.len())
                .map(|(b, _)| *b)
                .unwrap_or(line.len());
            out.push((start, end - start));
            i += needle_lower.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Minimal glob: `*` = any within segment, `**` = anything, `?` = one char.
/// Comma-separated alternatives; bare patterns (no `/`) match the basename.
fn glob_match(pattern: &str, path: &str) -> bool {
    pattern
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .any(|p| single_glob(p, path))
}

fn single_glob(p: &str, path: &str) -> bool {
    let mut rx = String::from("^");
    let mut chars = p.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    rx.push_str(".*");
                } else {
                    rx.push_str("[^/]*");
                }
            }
            '?' => rx.push('.'),
            c if "\\.+()[]{}^$|".contains(c) => {
                rx.push('\\');
                rx.push(c);
            }
            c => rx.push(c),
        }
    }
    rx.push('$');
    let target = if p.contains('/') {
        path
    } else {
        path.rsplit('/').next().unwrap_or(path)
    };
    regex::Regex::new(&rx)
        .map(|r| r.is_match(target))
        .unwrap_or(false)
}

/// Search every scanned project file (context map — hot in RAM, ignore rules
/// already applied). Capped at 500 matches.
#[tauri::command]
pub async fn search_project(
    query: String,
    case_sensitive: Option<bool>,
    is_regex: Option<bool>,
    include_glob: Option<String>,
    exclude_glob: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchMatch>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let cs = case_sensitive.unwrap_or(false);
    let rx = is_regex.unwrap_or(false);

    let regex = if rx {
        let pattern = if cs { query.clone() } else { format!("(?i){}", query) };
        Some(regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?)
    } else {
        None
    };
    let needle = if cs { query.clone() } else { query.to_lowercase() };
    let needle_chars: Vec<char> = needle.chars().collect();

    let map = state.project_context.lock().await;
    let mut out: Vec<SearchMatch> = vec![];

    'files: for (path, content) in map.iter() {
        if let Some(g) = &include_glob {
            if !g.trim().is_empty() && !glob_match(g, path) {
                continue;
            }
        }
        if let Some(g) = &exclude_glob {
            if !g.trim().is_empty() && glob_match(g, path) {
                continue;
            }
        }
        for (i, line) in content.lines().enumerate() {
            if let Some(re) = &regex {
                for m in re.find_iter(line) {
                    out.push(SearchMatch {
                        file: path.clone(),
                        line: (i + 1) as u32,
                        col: m.start() as u32,
                        len: (m.end() - m.start()).max(1) as u32,
                        line_text: line.chars().take(300).collect(),
                    });
                    if out.len() >= 500 {
                        break 'files;
                    }
                }
            } else if cs {
                let mut start = 0usize;
                while let Some(pos) = line[start..].find(&needle) {
                    let abs = start + pos;
                    out.push(SearchMatch {
                        file: path.clone(),
                        line: (i + 1) as u32,
                        col: abs as u32,
                        len: needle.len() as u32,
                        line_text: line.chars().take(300).collect(),
                    });
                    start = abs + needle.len().max(1);
                    if out.len() >= 500 {
                        break 'files;
                    }
                }
            } else {
                for (col, len) in find_ci(line, &needle_chars) {
                    out.push(SearchMatch {
                        file: path.clone(),
                        line: (i + 1) as u32,
                        col: col as u32,
                        len: len as u32,
                        line_text: line.chars().take(300).collect(),
                    });
                    if out.len() >= 500 {
                        break 'files;
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| a.file.cmp(&b.file).then(a.line.cmp(&b.line)).then(a.col.cmp(&b.col)));
    Ok(out)
}

/// Apply selected replacements. Each modified file goes through the
/// orchestrator (changelog entry + P2P broadcast) — never raw disk writes.
#[tauri::command]
pub async fn replace_in_files(
    targets: Vec<ReplaceTarget>,
    replacement: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChangelogEntry>, String> {
    let identity_lock = state.identity.lock().await;
    let (username, model_label) = match (&*identity_lock, state.model_config.lock().await.clone()) {
        (Some(id), Some(mc)) => (id.username.clone(), mc.label.clone()),
        _ => return Err("Identity or model not configured".into()),
    };
    drop(identity_lock);

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    let manifest_path = root.join(".0g").join("manifest.json");
    if let Ok(manifest_data) = tokio::fs::read_to_string(&manifest_path).await {
        if let Ok(manifest) = serde_json::from_str::<ProjectManifest>(&manifest_data) {
            if let Some(member) = manifest.members.iter().find(|m| m.username == username) {
                if member.permission == Permission::Read {
                    return Err(
                        "PermissionDenied: You have view-only access to this project.".into(),
                    );
                }
            }
        }
    }

    let mut by_file: HashMap<String, Vec<ReplaceTarget>> = HashMap::new();
    for t in targets {
        if let Ok(file) = normalize_project_path(&t.file) {
            by_file.entry(file).or_default().push(ReplaceTarget { file: t.file, ..t });
        }
    }

    let mut entries = vec![];
    for (file, mut ts) in by_file {
        let (_, abs) = join_project_path(&root, &file)?;
        let content = tokio::fs::read_to_string(&abs)
            .await
            .map_err(|e| format!("{}: {}", file, e))?;

        // Split on '\n' keeping any '\r' — line endings survive the round-trip
        let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
        // Apply bottom-up, right-to-left so earlier offsets stay valid
        ts.sort_by(|a, b| b.line.cmp(&a.line).then(b.col.cmp(&a.col)));
        let count = ts.len();
        for t in &ts {
            let idx = (t.line as usize).saturating_sub(1);
            if idx >= lines.len() {
                continue;
            }
            let line = &mut lines[idx];
            let start = t.col as usize;
            let end = start + t.len as usize;
            if end <= line.len() && line.is_char_boundary(start) && line.is_char_boundary(end) {
                line.replace_range(start..end, &replacement);
            }
        }
        let new_content = lines.join("\n");

        let payload = CommitWritePayload {
            file: file.clone(),
            content: new_content.clone(),
            summary: format!("Find & Replace ({} match{})", count, if count == 1 { "" } else { "es" }),
            affected_lines: ts.iter().map(|t| t.line).collect(),
            affected_functions: vec![],
            session_id: None,
        };

        let mut cl_lock = state.changelog.lock().await;
        let changelog = cl_lock.as_mut().ok_or("Changelog not initialized")?;
        let entry = state
            .orchestrator
            .intercept_write(payload, username.clone(), model_label.clone(), changelog, root.clone())
            .await
            .map_err(|e| e.to_string())?;
        drop(cl_lock);

        state.network.broadcast_update(entry.clone(), new_content).await;
        entries.push(entry);
    }

    Ok(entries)
}

// ─── Git awareness (A6 — read-only; the changelog stays the history system) ──

fn run_git(root: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Branch name + modified/untracked paths. `is_repo: false` when git or the
/// repo is absent — the frontend silently hides all git UI in that case.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    tokio::task::spawn_blocking(move || {
        let Some(branch) = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return Ok(json!({ "is_repo": false }));
        };
        let mut modified: Vec<String> = vec![];
        let mut untracked: Vec<String> = vec![];
        if let Some(status) = run_git(&root, &["status", "--porcelain"]) {
            for line in status.lines() {
                if line.len() < 4 {
                    continue;
                }
                let code = &line[..2];
                // Renames come through as "old -> new" — keep the new path
                let path = line[3..].split(" -> ").last().unwrap_or(&line[3..]).trim();
                let path = path.trim_matches('"').replace('\\', "/");
                if code == "??" {
                    untracked.push(path);
                } else {
                    modified.push(path);
                }
            }
        }
        Ok(json!({
            "is_repo": true,
            "branch": branch.trim(),
            "modified": modified,
            "untracked": untracked,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Uncommitted hunks for one file → [{start, end, kind}] in new-file line
/// numbers. kind: "add" | "mod" | "del" (del anchors at the line after).
#[tauri::command]
pub async fn git_diff_file(
    file: String,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or("No project open")?;

    tokio::task::spawn_blocking(move || {
        let Some(diff) = run_git(&root, &["diff", "--unified=0", "--", &file]) else {
            return Ok(vec![]);
        };
        let mut hunks = vec![];
        for line in diff.lines() {
            if !line.starts_with("@@") {
                continue;
            }
            // @@ -oldStart[,oldCount] +newStart[,newCount] @@
            let parse = |part: &str| -> (u32, u32) {
                let p = part.trim_start_matches(['-', '+']);
                let mut it = p.splitn(2, ',');
                let start = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let count = it.next().and_then(|s| s.parse().ok()).unwrap_or(1);
                (start, count)
            };
            let mut parts = line.split_whitespace();
            let (_, old) = (parts.next(), parts.next().map(parse));
            let new = parts.next().map(parse);
            let (Some((_, old_count)), Some((new_start, new_count))) = (old, new) else {
                continue;
            };
            let kind = if old_count == 0 {
                "add"
            } else if new_count == 0 {
                "del"
            } else {
                "mod"
            };
            let start = new_start.max(1);
            let end = if new_count == 0 { start } else { start + new_count - 1 };
            hunks.push(json!({ "start": start, "end": end, "kind": kind }));
        }
        Ok(hunks)
    })
    .await
    .map_err(|e| e.to_string())?
}

const PRETTIER_EXTS: &[&str] = &["js", "jsx", "ts", "tsx", "json", "css", "scss", "html", "md"];

/// Build the formatter invocation for an extension. `root` is used to find a
/// project-local prettier before falling back to a global install.
fn formatter_command(
    ext: &str,
    file: &str,
    root: Option<&std::path::Path>,
) -> Result<(std::process::Command, String), String> {
    use std::process::Command;

    // Prettier ships as a .cmd shim on Windows — must run through cmd /C
    fn prettier_cmd(root: Option<&std::path::Path>) -> std::process::Command {
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("cmd");
            let local = root.map(|r| r.join("node_modules").join(".bin").join("prettier.cmd"));
            match local {
                Some(p) if p.exists() => { c.arg("/C").arg(p); }
                _ => { c.arg("/C").arg("prettier"); }
            }
            c
        }
        #[cfg(not(target_os = "windows"))]
        {
            let local = root.map(|r| r.join("node_modules").join(".bin").join("prettier"));
            match local {
                Some(p) if p.exists() => Command::new(p),
                _ => Command::new("prettier"),
            }
        }
    }

    match ext {
        "rs" => {
            let mut c = Command::new("rustfmt");
            c.args(["--edition", "2021"]);
            Ok((c, "rustfmt not found — install with: rustup component add rustfmt".into()))
        }
        "py" => {
            let mut c = Command::new("black");
            c.args(["-q", "-"]);
            Ok((c, "black not found — install with: pip install black".into()))
        }
        e if PRETTIER_EXTS.contains(&e) => {
            let mut c = prettier_cmd(root);
            c.args(["--stdin-filepath", file]);
            Ok((c, "prettier not found — install with: npm i -g prettier".into()))
        }
        _ => Err(format!("No formatter wired for .{} files", ext)),
    }
}

/// Format a document via the matching CLI formatter (stdin → stdout).
/// Rust → rustfmt, Python → black, JS/TS/JSON/CSS/HTML/MD → prettier
/// (project-local install preferred over global).
#[tauri::command]
pub async fn format_document(
    file: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ext = std::path::Path::new(&file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path));

    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        use std::process::Stdio;

        let (mut cmd, hint) = formatter_command(&ext, &file, root.as_deref())?;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| hint.clone())?;

        child
            .stdin
            .as_mut()
            .ok_or("Failed to open formatter stdin")?
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;

        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            // Windows cmd /C reports a missing program on stderr with exit 1
            if stderr.to_lowercase().contains("not recognized") || stderr.is_empty() {
                return Err(hint);
            }
            return Err(format!("Formatter failed: {}", stderr));
        }
        let formatted = String::from_utf8_lossy(&out.stdout).to_string();
        if formatted.trim().is_empty() {
            return Err("Formatter returned empty output".into());
        }
        Ok(formatted)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which CLI formatters exist on this machine (used to decide whether the
/// prettier provider should shadow Monaco's built-in JS/TS formatter).
#[tauri::command]
pub async fn detect_formatters(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let root = state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path));

    tokio::task::spawn_blocking(move || {
        let probe = |ext: &str| -> bool {
            formatter_command(ext, "probe.tmp", root.as_deref())
                .ok()
                .and_then(|(mut c, _)| {
                    c.arg("--version")
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .stdin(std::process::Stdio::null())
                        .status()
                        .ok()
                })
                .map(|s| s.success())
                .unwrap_or(false)
        };
        Ok(json!({
            "rustfmt": probe("rs"),
            "black": probe("py"),
            "prettier": probe("ts"),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Probe a local Ollama instance and return its model list (B2).
/// Errors with "not_running" when the endpoint is unreachable.
#[tauri::command]
pub async fn detect_ollama(base_url: Option<String>) -> Result<serde_json::Value, String> {
    let base = base_url.unwrap_or_else(|| "http://localhost:11434".into());
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            r.json::<serde_json::Value>().await.map_err(|e| e.to_string())
        }
        Ok(r) => Err(format!("Ollama responded with {}", r.status())),
        Err(_) => Err("not_running".into()),
    }
}

fn extract_code_from_fences(output: &str) -> String {
    let mut in_fence = false;
    let mut code_lines = Vec::new();
    
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if !in_fence {
                in_fence = true;
                // Skip the opening fence line (e.g. ```python)
                continue;
            } else {
                // Reached the closing fence line
                break;
            }
        }
        if in_fence {
            code_lines.push(line);
        }
    }
    
    if code_lines.is_empty() {
        // Fallback if no code block was found
        output.trim().to_string()
    } else {
        code_lines.join("\n")
    }
}
