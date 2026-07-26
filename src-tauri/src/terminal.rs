//! terminal.rs — integrated terminal backed by a real PTY.
//!
//! This is a genuine pseudo-terminal (via `portable-pty`), not a
//! `Command::output()` wrapper. That distinction is the whole point: a PTY gives
//! the child process a terminal on the other end, so interactive programs work
//! — shells with prompts and job control, `git commit` opening an editor, REPLs,
//! progress bars that repaint, colour, and Ctrl+C.
//!
//! Data flow:
//!   frontend --pty_write--> master writer --> shell
//!   shell --> reader thread --> `pty://output` event --> xterm.js
//!
//! Output is sent base64-encoded rather than as a String on purpose. Reads land
//! on arbitrary byte boundaries, so a multi-byte UTF-8 character (or any of the
//! escape sequences a TUI emits) can be split across two chunks; decoding each
//! chunk as UTF-8 independently would corrupt it. Raw bytes go to xterm.js,
//! which owns the stream decoding.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use log::{info, warn};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One live terminal session.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    /// base64 of the raw bytes — see the module note on why this isn't a String.
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    code: Option<u32>,
}

/// Pick a shell. Honours the user's own configuration first; the fallbacks only
/// matter on a machine where those variables aren't set.
fn default_shell() -> String {
    if let Ok(s) = std::env::var("ZEROG_SHELL") {
        return s;
    }
    #[cfg(windows)]
    {
        // PowerShell if present (it's the Windows 11 default), else cmd.
        if std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe").exists() {
            return r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
pub async fn pty_spawn(
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    shell: Option<String>,
    state: State<'_, TerminalState>,
    app: AppHandle,
) -> Result<(), String> {
    // Reject a duplicate id rather than silently leaking the previous session's
    // shell process (which would keep reading and emitting under the same id).
    if state.sessions.lock().unwrap().contains_key(&id) {
        return Err(format!("terminal '{id}' already exists"));
    }

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("could not open a pty: {e}"))?;

    let program = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    if let Some(dir) = cwd.as_deref() {
        if std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        }
    }
    // Tell programs they're on a capable terminal so they emit colour and use
    // full-screen redraw; without this many tools fall back to dumb output.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("could not start '{program}': {e}"))?;
    // The slave handle must be dropped or the child never sees EOF on exit.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("could not read from the pty: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("could not write to the pty: {e}"))?;

    state.sessions.lock().unwrap().insert(
        id.clone(),
        Session { master: pair.master, writer, child },
    );

    // Reader thread: blocking reads are why this is an OS thread rather than a
    // tokio task — it would otherwise occupy a runtime worker for the session's
    // whole lifetime.
    let app_reader = app.clone();
    let sessions = Arc::clone(&state.sessions);
    let rid = id.clone();
    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // shell exited
                Ok(n) => {
                    let _ = app_reader.emit(
                        "pty://output",
                        PtyOutput { id: rid.clone(), data: engine.encode(&buf[..n]) },
                    );
                }
                Err(e) => {
                    // A closed pty on teardown is expected, not an error worth shouting about.
                    if e.kind() != std::io::ErrorKind::BrokenPipe {
                        warn!("pty {rid} read ended: {e}");
                    }
                    break;
                }
            }
        }

        // Reap the child and report the exit so the UI can mark the tab dead
        // instead of showing a terminal that silently accepts input forever.
        let code = sessions
            .lock()
            .unwrap()
            .get_mut(&rid)
            .and_then(|s| s.child.try_wait().ok().flatten())
            .map(|st| st.exit_code());
        sessions.lock().unwrap().remove(&rid);
        let _ = app_reader.emit("pty://exit", PtyExit { id: rid.clone(), code });
        info!("terminal {rid} closed");
    });

    info!("terminal {id} started ({program}, {cols}x{rows})");
    Ok(())
}

#[tauri::command]
pub async fn pty_write(id: String, data: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("terminal is not running")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("terminal is not running")?;
    s.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pty_kill(id: String, state: State<'_, TerminalState>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_list(state: State<'_, TerminalState>) -> Result<Vec<String>, String> {
    Ok(state.sessions.lock().unwrap().keys().cloned().collect())
}

/// Kill every session — called on app exit so no orphaned shells survive the
/// window closing.
pub fn shutdown_all(state: &TerminalState) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, s) in sessions.iter_mut() {
        let _ = s.child.kill();
    }
    sessions.clear();
}
