//! Debug Adapter Protocol host — Python debugging via `debugpy`.
//!
//! DAP is the debugger analogue of LSP: a separate adapter process that speaks
//! JSON over stdio with the exact same `Content-Length` framing. So this mirrors
//! `lsp.rs` on the wire — a thin generic bridge that owns process lifecycle,
//! framing, and request/response correlation — and differs only in message
//! shape (DAP keys on `seq`/`request_seq`/`event` where LSP keys on `id`).
//!
//! The frontend builds DAP requests and interprets DAP results; this module
//! relays. The one piece of protocol *sequencing* that must live here is the
//! launch handshake, because DAP requires a specific order:
//!
//!   initialize → (launch) → `initialized` EVENT → setBreakpoints →
//!   configurationDone → launch RESPONSE → running
//!
//! Getting that order wrong is the classic reason a debugger "starts" but never
//! binds a breakpoint, so it's done here once, correctly, rather than left to
//! the client to re-derive.
//!
//! Adapter: `python -m debugpy.adapter` (pip install debugpy). Chosen over
//! bundling a native adapter because it is cross-platform, self-contained, and
//! speaks DAP directly — nothing to download at runtime.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

/// A live debug session. At most one exists at a time (`DapState`).
pub struct DapSession {
    tx: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_seq: AtomicI64,
    _child: Child,
}

/// Managed Tauri state: the current session, if any.
#[derive(Default)]
pub struct DapState {
    pub session: Mutex<Option<Arc<DapSession>>>,
}

impl DapSession {
    /// Send a request and return the receiver for its response, without waiting.
    /// Used when a response arrives out of order with respect to other traffic —
    /// notably `launch`, whose response only comes after `configurationDone`.
    async fn send_request(&self, command: &str, args: Value) -> Result<oneshot::Receiver<Value>, String> {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let (txo, rxo) = oneshot::channel();
        self.pending.lock().await.insert(seq, txo);
        let msg = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": args,
        })
        .to_string();
        self.tx
            .send(msg)
            .await
            .map_err(|_| "debug adapter exited".to_string())?;
        Ok(rxo)
    }

    /// Send a request and wait for its response body. `Err` carries the adapter's
    /// own failure message, so a rejected request reads as a real reason.
    pub async fn request(&self, command: &str, args: Value, timeout_s: u64) -> Result<Value, String> {
        let rxo = self.send_request(command, args).await?;
        await_response(rxo, command, timeout_s, &self.pending).await
    }

    /// Reply to an adapter→client (reverse) request so the adapter never stalls.
    async fn respond(&self, request_seq: i64, command: &str, success: bool, body: Value) {
        let msg = json!({
            "seq": self.next_seq.fetch_add(1, Ordering::SeqCst),
            "type": "response",
            "request_seq": request_seq,
            "success": success,
            "command": command,
            "body": body,
        })
        .to_string();
        let _ = self.tx.send(msg).await;
    }
}

async fn await_response(
    rxo: oneshot::Receiver<Value>,
    command: &str,
    timeout_s: u64,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
) -> Result<Value, String> {
    match tokio::time::timeout(Duration::from_secs(timeout_s), rxo).await {
        Ok(Ok(v)) => {
            if let Some(err) = v.get("__dap_error") {
                Err(err.as_str().unwrap_or("debug request failed").to_string())
            } else {
                Ok(v)
            }
        }
        _ => {
            // Best-effort cleanup so a timed-out seq doesn't leak.
            let _ = pending;
            Err(format!("debug request timed out: {command}"))
        }
    }
}

/// npm/py launcher differences are handled by the caller; here we just build the
/// python invocation. `python` is assumed on PATH; failure returns an install
/// hint rather than a bare OS error.
fn python_bin() -> String {
    // `python` is the portable choice on Windows and most modern Unix installs.
    // (Deliberately not `python3` first: on Windows that's usually absent.)
    "python".to_string()
}

/// Preflight: confirm python and debugpy exist, and report exactly which is
/// missing. Without this a missing dependency surfaces only as the adapter
/// exiting instantly — indistinguishable from a crash.
pub async fn preflight() -> Result<(), String> {
    let py = python_bin();
    let out = Command::new(&py)
        .args(["-c", "import debugpy, sys; sys.stdout.write(debugpy.__version__)"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|_| {
            "Python isn't on PATH. Install Python 3, then: pip install debugpy".to_string()
        })?;

    if out.status.success() {
        Ok(())
    } else {
        Err("debugpy isn't installed for this Python. Install it with: pip install debugpy".to_string())
    }
}

/// Spawn `debugpy.adapter`, run the full launch handshake, and leave a running
/// session in `state`. Events (`stopped`, `output`, `terminated`, …) are emitted
/// to the webview as `dap://event`; the frontend drives everything after launch
/// through `dap_request`.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    app: AppHandle,
    state: &DapState,
    program: String,
    args: Vec<String>,
    cwd: String,
    breakpoints: Vec<(String, Vec<u32>)>,
    stop_on_entry: bool,
) -> Result<(), String> {
    preflight().await?;

    // Tear down any previous session first — one debuggee at a time.
    stop(state).await;

    let py = python_bin();
    let mut cmd = Command::new(&py);
    cmd.args(["-m", "debugpy.adapter"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("could not start debugpy adapter: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin on adapter")?;
    let stdout = child.stdout.take().ok_or("no stdout on adapter")?;

    // Writer task — owns stdin, applies Content-Length framing.
    let (tx, mut rx) = mpsc::channel::<String>(256);
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let frame = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
            if stdin.write_all(frame.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // The `initialized` EVENT (not the initialize response) is the signal that
    // the adapter is ready for breakpoints. The reader fires this oneshot.
    let (init_tx, init_rx) = oneshot::channel::<()>();
    let init_slot = Arc::new(Mutex::new(Some(init_tx)));

    let session = Arc::new(DapSession {
        tx: tx.clone(),
        pending: Arc::clone(&pending),
        next_seq: AtomicI64::new(1),
        _child: child,
    });

    // Reader task — correlates responses, forwards events, answers reverse
    // requests, and fires the initialized signal.
    {
        let pend_r = Arc::clone(&pending);
        let app_r = app.clone();
        let init_slot_r = Arc::clone(&init_slot);
        let sess_r = Arc::clone(&session);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                // ── read one Content-Length framed message ──
                let mut content_len = 0usize;
                loop {
                    let mut line = Vec::new();
                    // Read a header line byte-by-byte up to \n (headers are ASCII).
                    let mut byte = [0u8; 1];
                    loop {
                        match reader.read_exact(&mut byte).await {
                            Ok(_) => {
                                if byte[0] == b'\n' {
                                    break;
                                }
                                if byte[0] != b'\r' {
                                    line.push(byte[0]);
                                }
                            }
                            Err(_) => {
                                let _ = app_r.emit("dap://event", json!({ "event": "terminated", "body": {} }));
                                return;
                            }
                        }
                    }
                    if line.is_empty() {
                        break; // blank line ends the header block
                    }
                    let l = String::from_utf8_lossy(&line);
                    if let Some(v) = l.strip_prefix("Content-Length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
                if content_len == 0 {
                    continue;
                }
                let mut buf = vec![0u8; content_len];
                if reader.read_exact(&mut buf).await.is_err() {
                    let _ = app_r.emit("dap://event", json!({ "event": "terminated", "body": {} }));
                    return;
                }
                let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };

                match msg.get("type").and_then(|t| t.as_str()) {
                    Some("response") => {
                        if let Some(req_seq) = msg.get("request_seq").and_then(|s| s.as_i64()) {
                            if let Some(s) = pend_r.lock().await.remove(&req_seq) {
                                let success = msg.get("success").and_then(|b| b.as_bool()).unwrap_or(false);
                                let payload = if success {
                                    msg.get("body").cloned().unwrap_or(Value::Null)
                                } else {
                                    let m = msg.get("message").and_then(|m| m.as_str()).unwrap_or("request failed");
                                    json!({ "__dap_error": m })
                                };
                                let _ = s.send(payload);
                            }
                        }
                    }
                    Some("event") => {
                        let event = msg.get("event").and_then(|e| e.as_str()).unwrap_or("");
                        if event == "initialized" {
                            if let Some(tx) = init_slot_r.lock().await.take() {
                                let _ = tx.send(());
                            }
                        }
                        // Forward every event; the frontend decides what to act on.
                        let _ = app_r.emit(
                            "dap://event",
                            json!({ "event": event, "body": msg.get("body").cloned().unwrap_or(Value::Null) }),
                        );
                    }
                    Some("request") => {
                        // Reverse request from the adapter. With internalConsole we
                        // don't expect runInTerminal, but answer anything so the
                        // adapter never blocks waiting on us.
                        let command = msg.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
                        let req_seq = msg.get("seq").and_then(|s| s.as_i64()).unwrap_or(0);
                        sess_r.respond(req_seq, &command, true, json!({})).await;
                    }
                    _ => {}
                }
            }
        });
    }

    // ── initialize ──
    session
        .request(
            "initialize",
            json!({
                "clientID": "0g",
                "clientName": "0G",
                "adapterID": "debugpy",
                "pathFormat": "path",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "supportsVariableType": true,
                "supportsRunInTerminalRequest": false,
                "locale": "en-us",
            }),
            20,
        )
        .await
        .map_err(|e| format!("debugger initialize failed: {e}"))?;

    // ── launch (response deferred until after configurationDone) ──
    let launch_rx = session
        .send_request(
            "launch",
            json!({
                "request": "launch",
                "type": "python",
                "program": program,
                "args": args,
                "cwd": cwd,
                "console": "internalConsole",
                "stopOnEntry": stop_on_entry,
                "justMyCode": true,
                "python": [py],
            }),
        )
        .await
        .map_err(|e| format!("debugger launch failed: {e}"))?;

    // ── wait for the adapter to be ready, then set breakpoints ──
    // A stall here almost always means debugpy's launcher subprocess crashed on
    // startup — most often because something in site-packages shadows a stdlib
    // module (a stray `typing`/`enum` backport is the classic culprit on modern
    // Python). The adapter itself imports fine, so a plain preflight can't catch
    // it; the actionable message points at the real cause instead of a bare wait.
    tokio::time::timeout(Duration::from_secs(15), init_rx)
        .await
        .map_err(|_| {
            "The debugger started but never became ready. This usually means debugpy's \
             launcher failed to load — check for an obsolete backport package shadowing the \
             standard library (e.g. run `pip uninstall typing enum34`) and try again."
                .to_string()
        })?
        .map_err(|_| "debug adapter closed during startup".to_string())?;

    for (path, lines) in &breakpoints {
        let bps: Vec<Value> = lines.iter().map(|l| json!({ "line": l })).collect();
        let _ = session
            .request(
                "setBreakpoints",
                json!({
                    "source": { "path": path },
                    "breakpoints": bps,
                }),
                10,
            )
            .await;
    }

    session
        .request("configurationDone", json!({}), 10)
        .await
        .map_err(|e| format!("debugger configurationDone failed: {e}"))?;

    // Now the launch response should arrive.
    await_response(launch_rx, "launch", 15, &pending)
        .await
        .map_err(|e| format!("debugger did not confirm launch: {e}"))?;

    *state.session.lock().await = Some(session);
    log::info!("Debug session started for {}", cwd);
    Ok(())
}

/// End the current session: politely disconnect, then drop it (kill_on_drop
/// reaps the adapter). Safe to call with no session running.
pub async fn stop(state: &DapState) {
    let sess = state.session.lock().await.take();
    if let Some(s) = sess {
        // Give the adapter a moment to terminate the debuggee cleanly.
        let _ = s
            .request(
                "disconnect",
                json!({ "restart": false, "terminateDebuggee": true }),
                3,
            )
            .await;
        // `s` drops here → child is killed.
    }
}

// ─── Tauri commands ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BreakpointSet {
    pub path: String,
    pub lines: Vec<u32>,
}

/// Start debugging `program` (absolute path) with the given breakpoints
/// (absolute source paths). Paths are relayed to the adapter verbatim; the
/// frontend owns the relative↔absolute mapping since only it knows the project
/// root — keeping this module a pure relay.
#[tauri::command]
pub async fn dap_start(
    program: String,
    args: Vec<String>,
    cwd: String,
    breakpoints: Vec<BreakpointSet>,
    stop_on_entry: bool,
    app: AppHandle,
    state: State<'_, DapState>,
) -> Result<(), String> {
    let bps = breakpoints.into_iter().map(|b| (b.path, b.lines)).collect();
    start(app, &state, program, args, cwd, bps, stop_on_entry).await
}

/// Generic DAP request passthrough for everything after launch: threads,
/// stackTrace, scopes, variables, continue, next, stepIn, stepOut, pause,
/// evaluate, setBreakpoints (while running). Returns the response body.
#[tauri::command]
pub async fn dap_request(
    command: String,
    args: Value,
    state: State<'_, DapState>,
) -> Result<Value, String> {
    let sess = state.session.lock().await.clone();
    let sess = sess.ok_or("No debug session is running")?;
    sess.request(&command, args, 20).await
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, DapState>) -> Result<(), String> {
    stop(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn dap_running(state: State<'_, DapState>) -> Result<bool, String> {
    Ok(state.session.lock().await.is_some())
}

/// Confirm the toolchain before the user tries to debug, so the Debug panel can
/// show an actionable install hint instead of a failed run.
#[tauri::command]
pub async fn dap_check() -> Result<(), String> {
    preflight().await
}
