use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::RwLock;

use crate::types::{ChangelogEntry, UserIdentity};

const DISCOVERY_PORT: u16 = 47000;
const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB max per TCP message

fn safe_project_join(root: &Path, path: &str) -> Option<PathBuf> {
    if path.trim().is_empty() || Path::new(path).is_absolute() {
        return None;
    }

    let mut out = PathBuf::from(root);
    let mut saw_normal = false;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => {
                out.push(part);
                saw_normal = true;
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    saw_normal.then_some(out)
}

/// Caps on a project snapshot. Generous for real source trees, but bounded so a
/// peer can never make us read an unbounded amount into memory — the ignore
/// rules already drop node_modules/target, which is what actually blows up.
const SYNC_MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const SYNC_MAX_FILES: usize = 3000;
const SYNC_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// Read the project as (relative path, contents) pairs.
///
/// Deliberately reuses `context_scanner::should_ignore`, so a joiner receives
/// exactly the set of files the scanner would have indexed — no separate ignore
/// list to drift out of sync. Non-UTF8 files are skipped: the wire format is
/// JSON strings, and binaries are not what a code project sync is for.
fn collect_project_files(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut total = 0usize;

    let walker = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !crate::context_scanner::should_ignore(e));

    for entry in walker.flatten() {
        if files.len() >= SYNC_MAX_FILES || total >= SYNC_MAX_TOTAL_BYTES {
            warn!("Project snapshot hit its size cap; sending a partial tree");
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.metadata().map(|m| m.len() as usize > SYNC_MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
        total += content.len();
        files.push((rel.to_string_lossy().replace('\\', "/"), content));
    }
    files
}

/// True when there is nothing here worth keeping — the only state in which it is
/// safe to accept a peer's snapshot. A folder holding the user's own work must
/// never be overwritten by a teammate's copy just because they connected.
fn project_is_empty(root: &Path) -> bool {
    let walker = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !crate::context_scanner::should_ignore(e));
    !walker.flatten().any(|e| e.file_type().is_file())
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("0g-sync-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn write(root: &Path, rel: &str, body: &str) {
        let f = root.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, body).unwrap();
    }

    #[test]
    fn snapshot_carries_source_and_drops_junk() {
        let root = scratch("collect");
        write(&root, "src/main.rs", "fn main() {}");
        write(&root, "src/lib/util.ts", "export const x = 1");
        write(&root, "node_modules/dep/index.js", "module.exports={}");
        write(&root, "target/debug/build.log", "noise");
        write(&root, ".0g/changelog.enc", "secret");
        write(&root, ".git/HEAD", "ref: refs/heads/main");

        let files = collect_project_files(&root);
        let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();

        assert!(paths.contains(&"src/main.rs"), "got {paths:?}");
        assert!(paths.contains(&"src/lib/util.ts"), "got {paths:?}");
        // Dependencies, build output and the encrypted ledger are never shipped:
        // the ledger is per-peer, and the rest is regenerable bulk.
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")), "got {paths:?}");
        assert!(!paths.iter().any(|p| p.starts_with("target")), "got {paths:?}");
        assert!(!paths.iter().any(|p| p.starts_with(".0g")), "got {paths:?}");
        assert!(!paths.iter().any(|p| p.starts_with(".git")), "got {paths:?}");
        assert_eq!(files.len(), 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn paths_survive_the_round_trip() {
        // What collect produces must be re-joinable on the receiving side —
        // nested paths included, and always inside the destination root.
        let root = scratch("roundtrip");
        write(&root, "a/b/c/deep.ts", "ok");
        let dest = scratch("roundtrip-dest");
        for (rel, _) in collect_project_files(&root) {
            let abs = safe_project_join(&dest, &rel).expect("must rejoin");
            assert!(abs.starts_with(&dest), "{abs:?} escaped {dest:?}");
        }
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dest).ok();
    }

    #[test]
    fn emptiness_ignores_junk_but_not_source() {
        let empty = scratch("empty");
        assert!(project_is_empty(&empty), "fresh folder must read as empty");

        // A folder holding only dependencies still counts as empty — there is no
        // user work there to protect.
        write(&empty, "node_modules/x/i.js", "x");
        assert!(project_is_empty(&empty));

        // One real source file makes it non-empty, which is what stops a peer's
        // snapshot from landing on top of somebody's own work.
        write(&empty, "main.py", "print(1)");
        assert!(!project_is_empty(&empty));
        fs::remove_dir_all(&empty).ok();
    }

    #[test]
    fn oversized_files_are_skipped() {
        let root = scratch("cap");
        write(&root, "small.txt", "fine");
        write(&root, "huge.txt", &"x".repeat(SYNC_MAX_FILE_BYTES + 1));
        let paths: Vec<String> = collect_project_files(&root).into_iter().map(|(p, _)| p).collect();
        assert!(paths.contains(&"small.txt".to_string()));
        assert!(!paths.contains(&"huge.txt".to_string()), "got {paths:?}");
        fs::remove_dir_all(&root).ok();
    }

    /// The wire format is a serde-tagged enum. A variant that does not round-trip
    /// fails silently at runtime — the peer just ignores the frame — so pin it.
    #[test]
    fn sync_messages_round_trip_on_the_wire() {
        let cases = vec![
            NetworkMessage::SyncRequest,
            NetworkMessage::SyncFile {
                path: "src/a/b.rs".into(),
                content: "fn main() { println!(\"héllo\\n\"); }".into(),
            },
            NetworkMessage::SyncDone { count: 42 },
        ];
        for msg in cases {
            let bytes = serde_json::to_vec(&msg).expect("serialise");
            let back: NetworkMessage = serde_json::from_slice(&bytes).expect("deserialise");
            match (&msg, &back) {
                (NetworkMessage::SyncRequest, NetworkMessage::SyncRequest) => {}
                (
                    NetworkMessage::SyncFile { path: a, content: b },
                    NetworkMessage::SyncFile { path: c, content: d },
                ) => {
                    assert_eq!(a, c);
                    assert_eq!(b, d, "unicode and newlines must survive");
                }
                (NetworkMessage::SyncDone { count: a }, NetworkMessage::SyncDone { count: b }) => {
                    assert_eq!(a, b)
                }
                _ => panic!("variant changed across the wire: {msg:?} -> {back:?}"),
            }
        }
    }

    #[test]
    fn traversal_paths_are_refused_on_receive() {
        let dest = scratch("traversal");
        for evil in ["../escape.txt", "..\\escape.txt", "/etc/passwd", "a/../../b.txt"] {
            assert!(
                safe_project_join(&dest, evil).is_none(),
                "{evil} should have been rejected"
            );
        }
        fs::remove_dir_all(&dest).ok();
    }
}

/// Resolve the open project's root, if one is open.
async fn project_root(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<crate::commands::AppState>();
    let proj = state.project.lock().await;
    proj.as_ref().map(|p| PathBuf::from(&p.root_path))
}

/// Ask a freshly-connected peer for the project, but only when we have nothing.
///
/// Guarded three ways: we must have a project open, its folder must be empty,
/// and we must not have already pulled from someone else. That last flag is what
/// stops a three-person team from transferring the tree twice.
async fn request_sync_if_empty(
    app: &AppHandle,
    node: &Arc<NetworkNode>,
    tx: &mpsc::Sender<NetworkMessage>,
) {
    let Some(root) = project_root(app).await else { return };
    if *node.sync_pulled.read().await {
        return;
    }
    if !project_is_empty(&root) {
        return;
    }
    // Claim the pull before awaiting the reply, so two peers connecting at once
    // cannot both start sending us the same project.
    *node.sync_pulled.write().await = true;
    info!("Project folder is empty — requesting a snapshot from peer");
    let _ = tx.send(NetworkMessage::SyncRequest).await;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub id: String,
    pub username: String,
    pub avatar_color: String,
    pub status: String,
    #[serde(default)]
    pub is_self: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DiscoveryPacket {
    pub invite_hash: String,
    pub tcp_port: u16,
    pub username: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum NetworkMessage {
    Handshake {
        id: String,
        username: String,
        avatar_color: String,
        invite_hash: String,
    },
    HandshakeAck {
        id: String,
        username: String,
        avatar_color: String,
    },
    FileUpdate {
        entry: ChangelogEntry,
        new_content: String,
    },
    PeerStatus {
        id: String,
        status: String, // "idle" | "writing" | "reviewing"
        current_file: Option<String>,
    },
    /// A file (or every file in a folder) was deleted by a peer.
    FileDelete { entry: ChangelogEntry },
    /// A file or folder was renamed/moved by a peer.
    FileRename {
        entry: ChangelogEntry,
        from: String,
        to: String,
    },
    /// T1: opaque CRDT relay. `doc` = file path, `kind` = update|awareness|
    /// request|state|cursor, `data` = base64 payload. The backend never
    /// interprets it — it just fans it out to the mesh and emits to the webview.
    Crdt {
        doc: String,
        kind: String,
        data: String,
    },
    /// T1: team chat line.
    Chat {
        username: String,
        color: String,
        text: String,
        ts: String,
    },
    /// Sent by a peer whose project folder is empty, asking whoever it just
    /// connected to for the project as it currently stands. Without this, joining
    /// a team gave you a working encrypted link to an empty directory: files only
    /// ever moved when somebody *edited* one.
    SyncRequest,
    /// One file of a snapshot, in reply to `SyncRequest`. Sent per-file rather
    /// than as one archive so a large project streams instead of building a
    /// single frame that would blow the 16 MB message ceiling.
    SyncFile { path: String, content: String },
    /// End of a snapshot. `count` is what the sender actually transmitted.
    SyncDone { count: usize },
}

pub struct NetworkNode {
    pub peer_id: String,
    pub invite_hash: RwLock<String>,
    pub identity: RwLock<Option<UserIdentity>>,
    pub connections: RwLock<HashMap<String, mpsc::Sender<NetworkMessage>>>,
    pub peer_info: RwLock<HashMap<String, PeerInfo>>,
    /// T0-8: every TCP frame is XChaCha20-Poly1305 sealed with this cipher,
    /// keyed by Argon2id(passphrase, salt=H(invite_code)). Peers without the
    /// passphrase fail frame decryption and are disconnected.
    pub frame_cipher: RwLock<Option<XChaCha20Poly1305>>,
    /// T1: our bound TCP listen port (for manual WAN connect-by-address).
    pub tcp_port: RwLock<u16>,
    /// Set once we have pulled a project snapshot from some peer, so connecting
    /// to a second teammate does not trigger a redundant second transfer.
    pub sync_pulled: RwLock<bool>,
}

/// Derive the shared frame cipher. Deterministic across peers: the salt is
/// bound to the invite code, the secret is the project passphrase.
fn derive_frame_cipher(invite_code: &str, passphrase: &str) -> Option<XChaCha20Poly1305> {
    let mut hasher = Sha256::new();
    hasher.update(b"0g-net-v1:");
    hasher.update(invite_code.as_bytes());
    let salt = hasher.finalize();

    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .ok()?;
    Some(XChaCha20Poly1305::new((&key).into()))
}

/// Frame layout on the wire: [random 24-byte nonce][ciphertext+tag].
fn encrypt_frame(cipher: &XChaCha20Poly1305, plain: &[u8]) -> Option<Vec<u8>> {
    let nonce_bytes: [u8; 24] = rand::random();
    let ct = cipher.encrypt(XNonce::from_slice(&nonce_bytes), plain).ok()?;
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Some(out)
}

fn decrypt_frame(cipher: &XChaCha20Poly1305, data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 25 {
        return None;
    }
    let (nonce, ct) = data.split_at(24);
    cipher.decrypt(XNonce::from_slice(nonce), ct).ok()
}

/// Seal a plaintext frame if a cipher is configured; otherwise pass through
/// (no cipher only happens if start() ran without a passphrase — legacy path).
fn seal(cipher: &Option<XChaCha20Poly1305>, plain: &[u8]) -> Vec<u8> {
    match cipher {
        Some(c) => encrypt_frame(c, plain).unwrap_or_default(),
        None => plain.to_vec(),
    }
}

/// Open a wire frame. When a cipher is set, decryption failure returns None
/// (caller disconnects). Without a cipher, the frame is treated as plaintext.
fn open(cipher: &Option<XChaCha20Poly1305>, framed: &[u8]) -> Option<Vec<u8>> {
    match cipher {
        Some(c) => decrypt_frame(c, framed),
        None => Some(framed.to_vec()),
    }
}
use tokio::sync::mpsc;

impl Default for NetworkNode {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkNode {
    pub fn new() -> Self {
        Self {
            peer_id: format!("peer_{}", uuid::Uuid::new_v4()),
            invite_hash: RwLock::new(String::new()),
            identity: RwLock::new(None),
            connections: RwLock::new(HashMap::new()),
            peer_info: RwLock::new(HashMap::new()),
            frame_cipher: RwLock::new(None),
            tcp_port: RwLock::new(0),
            sync_pulled: RwLock::new(false),
        }
    }

    pub async fn start(
        node: Arc<NetworkNode>,
        app: AppHandle,
        invite_code: &str,
        passphrase: &str,
        identity: UserIdentity,
    ) -> anyhow::Result<()> {
        let mut hasher = Sha256::new();
        hasher.update(invite_code.as_bytes());
        let hash = format!("{:x}", hasher.finalize());

        *node.invite_hash.write().await = hash.clone();
        *node.identity.write().await = Some(identity.clone());
        // T0-8: derive the shared frame cipher for this project session
        *node.frame_cipher.write().await = derive_frame_cipher(invite_code, passphrase);

        // Bind TCP Listener
        let listener = TcpListener::bind("0.0.0.0:0").await?;
        let tcp_port = listener.local_addr()?.port();
        *node.tcp_port.write().await = tcp_port;

        info!("P2P Network started. TCP bound to {}", tcp_port);

        // Spawn TCP Listener task
        let node_tcp = node.clone();
        let app_tcp = app.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((stream, addr)) = listener.accept().await {
                    info!("Incoming connection from {}", addr);
                    Self::handle_new_connection(node_tcp.clone(), app_tcp.clone(), stream, true)
                        .await;
                }
            }
        });

        // Bind UDP for broadcasting discovery
        let udp_socket = UdpSocket::bind("0.0.0.0:0").await?;
        udp_socket.set_broadcast(true)?;
        let broadcast_addr: SocketAddr = SocketAddr::V4(SocketAddrV4::new(
            Ipv4Addr::new(255, 255, 255, 255),
            DISCOVERY_PORT,
        ));

        let node_udp_tx = node.clone();
        tokio::spawn(async move {
            loop {
                let hash = node_udp_tx.invite_hash.read().await.clone();
                if hash.is_empty() {
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    continue;
                }

                let id = node_udp_tx.peer_id.clone();
                let ident_guard = node_udp_tx.identity.read().await;
                let username = ident_guard
                    .as_ref()
                    .map(|i| i.username.clone())
                    .unwrap_or_else(|| "Unknown".into());
                drop(ident_guard);

                let packet = DiscoveryPacket {
                    invite_hash: hash,
                    tcp_port,
                    username,
                    id,
                };

                if let Ok(data) = serde_json::to_vec(&packet) {
                    let _ = udp_socket.send_to(&data, &broadcast_addr).await;
                }

                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            }
        });

        // Bind UDP listener for incoming discovery
        let udp_listen = UdpSocket::bind(SocketAddr::V4(SocketAddrV4::new(
            Ipv4Addr::new(0, 0, 0, 0),
            DISCOVERY_PORT,
        )))
        .await;
        if let Ok(udp_listen) = udp_listen {
            let node_udp_rx = node.clone();
            let app_udp = app.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 1024];
                loop {
                    if let Ok((len, addr)) = udp_listen.recv_from(&mut buf).await {
                        if let Ok(packet) = serde_json::from_slice::<DiscoveryPacket>(&buf[..len]) {
                            let curr_hash = node_udp_rx.invite_hash.read().await.clone();
                            // Deterministic tie-break: both peers see each other's
                            // broadcasts, but only the one with the smaller peer_id
                            // dials — the other waits to accept. Without this, both
                            // dial simultaneously (the connections map is still empty
                            // mid-handshake) and we end up with two TCP links, duplicate
                            // messages, and zombie reader/writer tasks for one peer.
                            let should_dial = node_udp_rx.peer_id.as_str() < packet.id.as_str();
                            if packet.invite_hash == curr_hash && should_dial {
                                let is_known = node_udp_rx
                                    .connections
                                    .read()
                                    .await
                                    .contains_key(&packet.id);
                                if !is_known {
                                    // Harden: a malformed address must skip this peer,
                                    // not panic (and kill) the whole discovery task.
                                    let tcp_addr: SocketAddr =
                                        match format!("{}:{}", addr.ip(), packet.tcp_port).parse() {
                                            Ok(a) => a,
                                            Err(e) => {
                                                warn!(
                                                    "Ignoring peer with unparseable address {}:{} — {}",
                                                    addr.ip(),
                                                    packet.tcp_port,
                                                    e
                                                );
                                                continue;
                                            }
                                        };
                                    info!(
                                        "Discovered matching peer {} at {} — dialing",
                                        packet.username, addr
                                    );
                                    if let Ok(stream) = TcpStream::connect(tcp_addr).await {
                                        Self::handle_new_connection(
                                            node_udp_rx.clone(),
                                            app_udp.clone(),
                                            stream,
                                            false,
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                    }
                }
            });
        } else {
            error!("Could not bind UDP discovery port {}", DISCOVERY_PORT);
        }

        Ok(())
    }

    async fn handle_new_connection(
        node: Arc<NetworkNode>,
        app: AppHandle,
        mut stream: TcpStream,
        _is_incoming: bool,
    ) {
        let (tx, mut rx) = mpsc::channel::<NetworkMessage>(100);

        let ident_guard = node.identity.read().await;
        let self_ident = ident_guard.clone().unwrap_or(UserIdentity {
            username: "Guest".into(),
            avatar_color: "#eee".into(),
        });
        drop(ident_guard);

        let self_hash = node.invite_hash.read().await.clone();
        // T0-8: snapshot the shared cipher for this connection's tasks
        let cipher = node.frame_cipher.read().await.clone();

        let hs = NetworkMessage::Handshake {
            id: node.peer_id.clone(),
            username: self_ident.username.clone(),
            avatar_color: self_ident.avatar_color.clone(),
            invite_hash: self_hash.clone(),
        };

        // Send handshake immediately (sealed if a cipher is configured)
        if let Ok(data) = serde_json::to_vec(&hs) {
            let payload = seal(&cipher, &data);
            let len = (payload.len() as u32).to_be_bytes();
            let _ = stream.write_all(&len).await;
            let _ = stream.write_all(&payload).await;
        }

        let (mut read_half, mut write_half) = stream.into_split();
        let peer_id_slot = Arc::new(RwLock::new(String::new()));

        // Writer task
        let pid_w = peer_id_slot.clone();
        let node_w = node.clone();
        let app_w = app.clone();
        let cipher_w = cipher.clone();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let Ok(data) = serde_json::to_vec(&msg) {
                    let payload = seal(&cipher_w, &data);
                    let len = (payload.len() as u32).to_be_bytes();
                    if write_half.write_all(&len).await.is_err() {
                        break;
                    }
                    if write_half.write_all(&payload).await.is_err() {
                        break;
                    }
                }
            }

            // Clean up on disconnect
            let pid = pid_w.read().await.clone();
            if !pid.is_empty() {
                node_w.connections.write().await.remove(&pid);
                node_w.peer_info.write().await.remove(&pid);
                let _ = app_w.emit("peer_left", serde_json::json!({ "id": pid }));
            }
        });

        // Reader task
        let pid_r = peer_id_slot.clone();
        let node_r = node.clone();
        let app_r = app.clone();
        let cipher_r = cipher.clone();
        tokio::spawn(async move {
            loop {
                let mut len_buf = [0u8; 4];
                if read_half.read_exact(&mut len_buf).await.is_err() {
                    break;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                if len > MAX_MESSAGE_SIZE {
                    warn!("Peer sent oversized message ({} bytes), disconnecting", len);
                    break;
                }

                let mut framed = vec![0u8; len];
                if read_half.read_exact(&mut framed).await.is_err() {
                    break;
                }
                // T0-8: unseal — a peer with the wrong passphrase fails here
                let pbuf = match open(&cipher_r, &framed) {
                    Some(p) => p,
                    None => {
                        warn!("Frame decryption failed — wrong passphrase or tampered data; disconnecting");
                        break;
                    }
                };

                if let Ok(msg) = serde_json::from_slice::<NetworkMessage>(&pbuf) {
                    match msg {
                        NetworkMessage::Handshake {
                            id,
                            username,
                            avatar_color,
                            invite_hash,
                        } => {
                            if invite_hash != node_r.invite_hash.read().await.as_str() {
                                warn!("Handshake failed: mismatched invite hash");
                                break; // Disconnect
                            }

                            // Dedup: if we're already connected to this peer, this is a
                            // redundant link (lost tie-break race / reconnect). Drop it
                            // WITHOUT touching the map — leave pid empty so the writer's
                            // cleanup won't evict the live connection's entry.
                            if node_r.connections.read().await.contains_key(&id) {
                                warn!("Duplicate connection from peer {} — dropping redundant link", id);
                                break;
                            }

                            *pid_r.write().await = id.clone();
                            node_r
                                .connections
                                .write()
                                .await
                                .insert(id.clone(), tx.clone());

                            let info = PeerInfo {
                                id: id.clone(),
                                username: username.clone(),
                                avatar_color: avatar_color.clone(),
                                status: "idle".into(),
                                is_self: false,
                            };
                            node_r
                                .peer_info
                                .write()
                                .await
                                .insert(id.clone(), info.clone());

                            // Send Ack
                            let ack = NetworkMessage::HandshakeAck {
                                id: node_r.peer_id.clone(),
                                username: self_ident.username.clone(),
                                avatar_color: self_ident.avatar_color.clone(),
                            };
                            let _ = tx.send(ack).await;

                            // Emit peer joined
                            let _ = app_r.emit("peer_joined", info);

                            // If our project folder is empty, this peer is the
                            // first one who can tell us what the project is.
                            request_sync_if_empty(&app_r, &node_r, &tx).await;
                        }
                        NetworkMessage::HandshakeAck {
                            id,
                            username,
                            avatar_color,
                        } => {
                            // Dedup (see Handshake arm): reject a redundant link to a
                            // peer we already hold, leaving pid empty so cleanup is a no-op.
                            if node_r.connections.read().await.contains_key(&id) {
                                warn!("Duplicate ack from peer {} — dropping redundant link", id);
                                break;
                            }

                            *pid_r.write().await = id.clone();
                            node_r
                                .connections
                                .write()
                                .await
                                .insert(id.clone(), tx.clone());

                            let info = PeerInfo {
                                id: id.clone(),
                                username: username.clone(),
                                avatar_color: avatar_color.clone(),
                                status: "idle".into(),
                                is_self: false,
                            };
                            node_r
                                .peer_info
                                .write()
                                .await
                                .insert(id.clone(), info.clone());

                            // Emit peer joined
                            let _ = app_r.emit("peer_joined", info);

                            // If our project folder is empty, this peer is the
                            // first one who can tell us what the project is.
                            request_sync_if_empty(&app_r, &node_r, &tx).await;
                        }
                        NetworkMessage::PeerStatus {
                            id,
                            status,
                            current_file,
                        } => {
                            // Update local peer_info and notify frontend
                            let mut peer_lock = node_r.peer_info.write().await;
                            if let Some(info) = peer_lock.get_mut(&id) {
                                info.status = status.clone();
                            }
                            drop(peer_lock);
                            let _ = app_r.emit(
                                "peer_status",
                                serde_json::json!({
                                    "id": id,
                                    "status": status,
                                    "current_file": current_file,
                                }),
                            );
                        }
                        NetworkMessage::FileUpdate { entry, new_content } => {
                            // Enforce FCFS via state.changelog lock natively if project available
                            let state = app_r.state::<crate::commands::AppState>();

                            let mut root_path = None;
                            if let Some(proj) = state.project.lock().await.as_ref() {
                                root_path = Some(
                                    tokio::fs::canonicalize(&proj.root_path)
                                        .await
                                        .unwrap_or_else(|_| PathBuf::from(&proj.root_path)),
                                );
                            }

                            if let Some(root) = root_path {
                                let mut cl_lock = state.changelog.lock().await;
                                if let Some(ref mut changelog) = *cl_lock {
                                    match state
                                        .orchestrator
                                        .apply_remote_update(
                                            entry.clone(),
                                            new_content,
                                            changelog,
                                            root,
                                        )
                                        .await
                                    {
                                        Ok(crate::orchestrator::RemoteOutcome::Applied(processed)) => {
                                            let _ = app_r.emit("peer_entry", processed);
                                        }
                                        // Diverged: park the conflict so it survives a
                                        // panel reload, then surface it. Nothing was
                                        // written — the resolver decides what lands.
                                        Ok(crate::orchestrator::RemoteOutcome::Conflict(info)) => {
                                            drop(cl_lock);
                                            state
                                                .pending_conflicts
                                                .lock()
                                                .await
                                                .retain(|c| c.file != info.file);
                                            state
                                                .pending_conflicts
                                                .lock()
                                                .await
                                                .push(info.clone());
                                            let _ = app_r.emit("conflict://detected", info);
                                        }
                                        Err(e) => {
                                            log::error!("apply_remote_update failed: {e}");
                                            let _ = app_r.emit("peer_entry", entry);
                                        }
                                    }
                                } else {
                                    // Fallback if changelog missing
                                    let _ = app_r.emit("peer_entry", entry);
                                }
                            } else {
                                let _ = app_r.emit("peer_entry", entry);
                            }
                        }
                        NetworkMessage::FileDelete { entry } => {
                            let state = app_r.state::<crate::commands::AppState>();
                            let root = state
                                .project
                                .lock()
                                .await
                                .as_ref()
                                .map(|p| PathBuf::from(&p.root_path));
                            if let Some(root) = root {
                                if let Some(abs) = safe_project_join(&root, &entry.file) {
                                    let _ = tokio::fs::remove_file(&abs).await;
                                    let mut cl_lock = state.changelog.lock().await;
                                    if let Some(ref mut changelog) = *cl_lock {
                                        let _ = changelog.append(entry.clone()).await;
                                    }
                                } else {
                                    warn!("Rejected remote delete outside project: {}", entry.file);
                                }
                            }
                            let _ = app_r.emit("peer_entry", entry);
                        }
                        NetworkMessage::FileRename { entry, from, to } => {
                            let state = app_r.state::<crate::commands::AppState>();
                            let root = state
                                .project
                                .lock()
                                .await
                                .as_ref()
                                .map(|p| PathBuf::from(&p.root_path));
                            if let Some(root) = root {
                                if let (Some(src), Some(dst)) = (
                                    safe_project_join(&root, &from),
                                    safe_project_join(&root, &to),
                                ) {
                                    if let Some(parent) = dst.parent() {
                                        tokio::fs::create_dir_all(parent).await.ok();
                                    }
                                    let _ = tokio::fs::rename(&src, &dst).await;
                                    let mut cl_lock = state.changelog.lock().await;
                                    if let Some(ref mut changelog) = *cl_lock {
                                        let _ = changelog.append(entry.clone()).await;
                                    }
                                } else {
                                    warn!("Rejected remote rename outside project: {} -> {}", from, to);
                                }
                            }
                            let _ = app_r.emit("peer_entry", entry);
                        }
                        NetworkMessage::SyncRequest => {
                            // A teammate joined with an empty folder. Stream them the
                            // project on a separate task so a big tree does not stall
                            // this connection's reader loop.
                            let app_s = app_r.clone();
                            let tx_s = tx.clone();
                            tokio::spawn(async move {
                                let Some(root) = project_root(&app_s).await else { return };
                                let files = tokio::task::spawn_blocking(move || {
                                    collect_project_files(&root)
                                })
                                .await
                                .unwrap_or_default();

                                let count = files.len();
                                info!("Sending project snapshot to peer: {} file(s)", count);
                                for (path, content) in files {
                                    if tx_s
                                        .send(NetworkMessage::SyncFile { path, content })
                                        .await
                                        .is_err()
                                    {
                                        return; // peer went away mid-transfer
                                    }
                                }
                                let _ = tx_s.send(NetworkMessage::SyncDone { count }).await;
                            });
                        }
                        NetworkMessage::SyncFile { path, content } => {
                            // Same path validation as every other remote write: a
                            // peer must never be able to place a file outside the
                            // project root.
                            if let Some(root) = project_root(&app_r).await {
                                match safe_project_join(&root, &path) {
                                    Some(abs) => {
                                        if let Some(parent) = abs.parent() {
                                            tokio::fs::create_dir_all(parent).await.ok();
                                        }
                                        if let Err(e) =
                                            tokio::fs::write(&abs, content.as_bytes()).await
                                        {
                                            warn!("Could not write synced file {}: {}", path, e);
                                        }
                                    }
                                    None => warn!("Rejected synced file outside project: {}", path),
                                }
                            }
                        }
                        NetworkMessage::SyncDone { count } => {
                            info!("Project snapshot received: {} file(s)", count);
                            let _ = app_r.emit(
                                "project://synced",
                                serde_json::json!({ "count": count }),
                            );
                        }
                        NetworkMessage::Crdt { doc, kind, data } => {
                            // Pure relay — hand the payload to the webview with sender id
                            let from = pid_r.read().await.clone();
                            let _ = app_r.emit(
                                "crdt_message",
                                serde_json::json!({
                                    "doc": doc, "kind": kind, "data": data, "from": from,
                                }),
                            );
                        }
                        NetworkMessage::Chat {
                            username,
                            color,
                            text,
                            ts,
                        } => {
                            let from = pid_r.read().await.clone();
                            let _ = app_r.emit(
                                "chat_message",
                                serde_json::json!({
                                    "username": username, "color": color,
                                    "text": text, "ts": ts, "from": from,
                                }),
                            );
                        }
                    }
                }
            }

            // Clean up
            let pid = pid_r.read().await.clone();
            if !pid.is_empty() {
                node_r.connections.write().await.remove(&pid);
                node_r.peer_info.write().await.remove(&pid);
                let _ = app_r.emit("peer_left", serde_json::json!({ "id": pid }));
            }
        });
    }

    pub async fn broadcast_update(&self, entry: ChangelogEntry, new_content: String) {
        let msg = NetworkMessage::FileUpdate { entry, new_content };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }

    pub async fn broadcast_delete(&self, entry: ChangelogEntry) {
        let msg = NetworkMessage::FileDelete { entry };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }

    pub async fn broadcast_rename(&self, entry: ChangelogEntry, from: String, to: String) {
        let msg = NetworkMessage::FileRename { entry, from, to };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }

    /// T1: fan a CRDT payload out to every connected peer.
    pub async fn broadcast_crdt(&self, doc: String, kind: String, data: String) {
        let msg = NetworkMessage::Crdt { doc, kind, data };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }

    /// T1: fan a chat line out to every connected peer.
    pub async fn broadcast_chat(&self, username: String, color: String, text: String, ts: String) {
        let msg = NetworkMessage::Chat {
            username,
            color,
            text,
            ts,
        };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }

    /// T1: manually connect to a peer by address (WAN / cross-subnet where UDP
    /// discovery can't reach). The handshake + frame cipher still gate access.
    pub async fn connect_to(node: Arc<NetworkNode>, app: AppHandle, addr: &str) -> anyhow::Result<()> {
        let stream = TcpStream::connect(addr).await?;
        Self::handle_new_connection(node, app, stream, false).await;
        Ok(())
    }

    pub async fn broadcast_status(
        &self,
        self_id: &str,
        status: &str,
        current_file: Option<String>,
    ) {
        let msg = NetworkMessage::PeerStatus {
            id: self_id.to_string(),
            status: status.to_string(),
            current_file,
        };
        let conns = self.connections.read().await;
        for (_, tx) in conns.iter() {
            let _ = tx.send(msg.clone()).await;
        }
    }
}
