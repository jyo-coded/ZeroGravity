// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod changelog;
mod commands;
mod completion;
mod context_scanner;
mod git;
mod graph;
mod lsp;
mod model;
mod network;
mod orchestrator;
mod parser;
mod rotation;
mod terminal;
mod types;

use commands::AppState;
use tauri::Manager; // brings `.state()` into scope for the window-event hook
use terminal::TerminalState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            commands::save_identity,
            commands::load_identity,
            commands::configure_model,
            commands::load_model_config,
            commands::create_project,
            commands::get_project,
            commands::join_project,
            commands::get_file_tree,
            commands::open_file,
            commands::create_file,
            commands::commit_write,
            commands::get_changelog,
            commands::invoke_ai,
            commands::get_collaborators,
            commands::start_network,
            commands::apply_code,
            commands::revert_file,
            commands::broadcast_peer_status,
            commands::get_graph_context,
            commands::get_graph_json,
            commands::delete_path,
            commands::rename_path,
            commands::create_folder,
            commands::reveal_in_explorer,
            commands::format_document,
            commands::detect_ollama,
            commands::search_project,
            commands::replace_in_files,
            commands::configure_rotation,
            commands::get_rotation,
            commands::get_usage_stats,
            commands::git_status,
            commands::git_diff_file,
            commands::detect_formatters,
            commands::import_usage,
            commands::cancel_ai,
            commands::lsp_start,
            commands::lsp_request,
            commands::lsp_notify,
            commands::broadcast_crdt,
            commands::get_peer_id,
            commands::send_chat,
            commands::get_network_info,
            commands::connect_peer,
            commands::pick_folder,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_kill,
            terminal::pty_list,
            git::git_status_full,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_log,
            git::git_branches,
            git::git_checkout,
            git::git_blame,
            git::git_file_diff_text,
            completion::ai_complete,
            completion::test_model,
            completion::list_models,
            agent::ai_raw,
        ])
        // Kill every PTY when the app exits. Without this, closing the window
        // leaves orphaned shell processes running with no terminal attached.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                terminal::shutdown_all(&window.state::<TerminalState>());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running 0G application");
}
