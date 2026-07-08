//! Minimal LSP host (A4) — spawns language servers as child processes and
//! speaks JSON-RPC over stdio with Content-Length framing.
//!
//! Design: a deliberately thin generic bridge. The frontend builds LSP params
//! and interprets LSP results; this module only handles process lifecycle,
//! framing, request/response correlation, and pushing server-initiated
//! notifications (diagnostics) to the webview as Tauri events.
//!
//! Servers (all optional — a missing binary just disables that language):
//!   rust       → rust-analyzer          (rustup component add rust-analyzer)
//!   typescript → typescript-language-server --stdio (npm i -g typescript-language-server typescript)
//!   python     → pyright-langserver --stdio         (npm i -g pyright)

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

pub struct LspServer {
    tx: mpsc::Sender<String>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: AtomicI64,
    _child: Child,
}

impl LspServer {
    pub async fn request(&self, method: &str, params: Value, timeout_s: u64) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (txo, rxo) = oneshot::channel();
        self.pending.lock().await.insert(id, txo);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        self.tx.send(msg).await.map_err(|_| "LSP server exited".to_string())?;
        match tokio::time::timeout(Duration::from_secs(timeout_s), rxo).await {
            Ok(Ok(v)) => Ok(v),
            _ => {
                self.pending.lock().await.remove(&id);
                Err(format!("LSP request timed out: {}", method))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let _ = self.tx.send(msg).await;
    }
}

#[derive(Default)]
pub struct LspManager {
    pub servers: Mutex<HashMap<String, Arc<LspServer>>>,
}

impl LspManager {
    pub fn new() -> Self {
        Self::default()
    }
}

/// (program, args, install hint) per language group.
fn server_command(lang: &str) -> Option<(String, Vec<String>, String)> {
    match lang {
        "rust" => Some((
            "rust-analyzer".into(),
            vec![],
            "rust-analyzer not found — install with: rustup component add rust-analyzer".into(),
        )),
        "typescript" => Some(shim(
            "typescript-language-server",
            &["--stdio"],
            "typescript-language-server not found — install with: npm i -g typescript-language-server typescript",
        )),
        "python" => Some(shim(
            "pyright-langserver",
            &["--stdio"],
            "pyright not found — install with: npm i -g pyright",
        )),
        _ => None,
    }
}

/// npm globals are .cmd shims on Windows — they must run through cmd /C.
#[cfg(target_os = "windows")]
fn shim(bin: &str, args: &[&str], hint: &str) -> (String, Vec<String>, String) {
    let mut a = vec!["/C".to_string(), bin.to_string()];
    a.extend(args.iter().map(|s| s.to_string()));
    ("cmd".into(), a, hint.into())
}

#[cfg(not(target_os = "windows"))]
fn shim(bin: &str, args: &[&str], hint: &str) -> (String, Vec<String>, String) {
    (bin.into(), args.iter().map(|s| s.to_string()).collect(), hint.into())
}

/// Spawn + initialize a server for `lang`. Idempotent. Returns Err(hint)
/// when the binary is missing or the handshake fails.
pub async fn start(
    mgr: Arc<LspManager>,
    app: AppHandle,
    lang: String,
    root: String,
) -> Result<(), String> {
    if mgr.servers.lock().await.contains_key(&lang) {
        return Ok(());
    }
    let (prog, args, hint) = server_command(&lang).ok_or("Unsupported language")?;

    let mut cmd = Command::new(&prog);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|_| hint.clone())?;
    let mut stdin = child.stdin.take().ok_or("No stdin on LSP child")?;
    let stdout = child.stdout.take().ok_or("No stdout on LSP child")?;

    // Writer task — owns stdin, applies Content-Length framing
    let (tx, mut rx) = mpsc::channel::<String>(128);
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

    // Reader task — correlates responses, answers server→client requests,
    // forwards diagnostics to the webview
    let pend_r = Arc::clone(&pending);
    let tx_r = tx.clone();
    let app_r = app.clone();
    let lang_r = lang.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut content_len = 0usize;
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => {
                        let _ = app_r.emit("lsp_exited", json!({ "lang": lang_r }));
                        return;
                    }
                    Ok(_) => {}
                }
                let l = line.trim();
                if l.is_empty() {
                    break;
                }
                if let Some(v) = l.strip_prefix("Content-Length:") {
                    content_len = v.trim().parse().unwrap_or(0);
                }
            }
            if content_len == 0 {
                continue;
            }
            let mut buf = vec![0u8; content_len];
            if reader.read_exact(&mut buf).await.is_err() {
                let _ = app_r.emit("lsp_exited", json!({ "lang": lang_r }));
                return;
            }
            let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };

            let has_id = msg.get("id").is_some();
            let has_method = msg.get("method").is_some();

            if has_id && has_method {
                // Server → client request: reply so the server never stalls
                let method = msg["method"].as_str().unwrap_or("");
                let result = match method {
                    "workspace/configuration" => {
                        let n = msg["params"]["items"].as_array().map(|a| a.len()).unwrap_or(1);
                        Value::Array(vec![Value::Null; n])
                    }
                    "workspace/workspaceFolders" => Value::Null,
                    _ => Value::Null,
                };
                let resp = json!({ "jsonrpc": "2.0", "id": msg["id"], "result": result }).to_string();
                let _ = tx_r.send(resp).await;
            } else if has_id {
                // Response to one of our requests
                if let Some(idn) = msg["id"].as_i64() {
                    if let Some(s) = pend_r.lock().await.remove(&idn) {
                        let payload = if msg.get("error").is_some() {
                            json!({ "__lsp_error": msg["error"] })
                        } else {
                            msg.get("result").cloned().unwrap_or(Value::Null)
                        };
                        let _ = s.send(payload);
                    }
                }
            } else if msg["method"] == "textDocument/publishDiagnostics" {
                let _ = app_r.emit(
                    "lsp_diagnostics",
                    json!({ "lang": lang_r, "params": msg["params"] }),
                );
            }
            // other notifications ($/progress, window/logMessage…) are ignored
        }
    });

    let server = Arc::new(LspServer {
        tx,
        pending,
        next_id: AtomicI64::new(1),
        _child: child,
    });

    // ── initialize handshake ────────────────────────────────────────────
    let root_uri = format!("file:///{}", root.replace('\\', "/"));
    let init_params = json!({
        "processId": Value::Null,
        "clientInfo": { "name": "0G", "version": "1.0" },
        "rootUri": root_uri,
        "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
        "capabilities": {
            "textDocument": {
                "synchronization": { "didSave": true },
                "publishDiagnostics": { "relatedInformation": false },
                "completion": {
                    "completionItem": {
                        "snippetSupport": true,
                        "documentationFormat": ["markdown", "plaintext"]
                    }
                },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "signatureHelp": {
                    "signatureInformation": { "documentationFormat": ["markdown", "plaintext"] }
                },
                "definition": {}, "references": {}, "rename": {},
                "codeAction": {
                    "codeActionLiteralSupport": {
                        "codeActionKind": { "valueSet": ["quickfix", "refactor", "source"] }
                    }
                }
            },
            "workspace": { "configuration": true, "workspaceFolders": true }
        }
    });

    server
        .request("initialize", init_params, 30)
        .await
        .map_err(|e| format!("LSP initialize failed: {}", e))?;
    server.notify("initialized", json!({})).await;

    mgr.servers.lock().await.insert(lang.clone(), server);
    log::info!("LSP server started for {}", lang);
    Ok(())
}
