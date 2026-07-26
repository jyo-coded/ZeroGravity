//! Changelog module — encrypted JSON storage for 0G
//!
//! Uses XChaCha20-Poly1305 (via RustCrypto) for at-rest encryption.
//! Key is derived from a project passphrase using Argon2id.

use anyhow::{Context, Result};
use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde_json;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::types::{ChangelogEntry, EntryStatus};

/// Fixed Argon2 salt for key derivation (project-level, stored in manifest)
const ARGON2_SALT: &[u8] = b"0GWorkspaceV1Salt"; // 17 bytes, embedded

/// Hard cap on ledger length. The metadata per entry is tiny (~200 bytes), so
/// this bounds flush cost + growth without realistically ever dropping history
/// in a normal project. Oldest entries are dropped past this.
const MAX_ENTRIES: usize = 5000;

/// `previous_content` (a FULL file snapshot) is only retained for the most
/// recent N entries. Older entries keep all their metadata but drop the heavy
/// snapshot — revert only ever targets recent changes, and this is what stops
/// a large file edited many times from ballooning the changelog to tens of MB
/// (which was also making every save re-encrypt the whole thing).
const PREV_CONTENT_RETAIN: usize = 80;

/// The changelog is a flat list of entries stored as encrypted JSON
pub struct Changelog {
    path: PathBuf,
    cipher: XChaCha20Poly1305,
    entries: Vec<ChangelogEntry>,
}

impl Changelog {
    /// Open or create a changelog at the given path, unlocking with the passphrase
    pub async fn open(root: &Path, passphrase: &str) -> Result<Self> {
        let path = root.join(".0g").join("changelog.enc");

        // Derive a 32-byte key from the passphrase using Argon2id
        let key = derive_key(passphrase)?;
        let cipher = XChaCha20Poly1305::new((&key).into());

        let entries = if path.exists() {
            load_entries(&path, &cipher).await?
        } else {
            // Create directory if needed
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await?;
            }
            vec![]
        };

        Ok(Self {
            path,
            cipher,
            entries,
        })
    }

    /// Append a new entry and flush to disk
    pub async fn append(&mut self, entry: ChangelogEntry) -> Result<()> {
        self.entries.push(entry);
        self.prune();
        self.flush().await
    }

    /// Bound the ledger's on-disk footprint: cap total entries, and strip the
    /// heavy `previous_content` snapshot from all but the most recent entries.
    /// Metadata (author, model, timestamp, summary, affected lines) is always
    /// preserved — the audit trail stays complete.
    fn prune(&mut self) {
        if self.entries.len() > MAX_ENTRIES {
            let excess = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(0..excess);
        }
        let n = self.entries.len();
        if n > PREV_CONTENT_RETAIN {
            let cutoff = n - PREV_CONTENT_RETAIN;
            for e in &mut self.entries[..cutoff] {
                e.previous_content = None;
            }
        }
    }

    /// Get the last N entries for a specific file (most recent first)
    pub fn last_n_for_file(&self, file: &str, n: usize) -> Vec<ChangelogEntry> {
        self.entries
            .iter()
            .rev()
            .filter(|e| e.file == file)
            .take(n)
            .cloned()
            .collect()
    }

    /// Get the last N entries globally across all files
    pub fn get_last_n_cross_file(&self, n: usize) -> Vec<ChangelogEntry> {
        self.entries.iter().rev().take(n).cloned().collect()
    }

    /// Get all entries, optionally filtered
    pub fn get_filtered(
        &self,
        file: Option<&str>,
        user: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<ChangelogEntry> {
        let iter = self.entries.iter().rev();
        let mut out: Vec<ChangelogEntry> = iter
            .filter(|e| {
                file.map_or(true, |f| e.file == f) && user.map_or(true, |u| e.changed_by == u)
            })
            .cloned()
            .collect();
        if let Some(lim) = limit {
            out.truncate(lim);
        }
        out
    }

    /// Check if a different user recently committed to the same file,
    /// indicating a potential write conflict requiring FCFS re-evaluation.
    /// Checks the last 20 entries within a 30-second window.
    pub fn has_conflict(
        &self,
        file: &str,
        username: &str,
        lines: &[u32],
        functions: &[String],
    ) -> bool {
        let now = chrono::Utc::now();

        self.entries
            .iter()
            .rev()
            .take(20)
            .filter(|e| e.file == file && e.changed_by != username)
            .any(|e| {
                let age_secs = (now - e.timestamp).num_seconds();
                if age_secs > 30 {
                    return false;
                }
                if lines.is_empty() && functions.is_empty() {
                    return true;
                }
                let line_overlap = e.affected_lines.iter().any(|l| lines.contains(l));
                let fn_overlap = e.affected_functions.iter().any(|f| functions.contains(f));
                line_overlap || fn_overlap
            })
    }

    /// Mark the last entry for a file as committed
    #[allow(dead_code)]
    pub async fn mark_committed(&mut self, entry_id: &str) -> Result<()> {
        if let Some(e) = self.entries.iter_mut().find(|e| e.id == entry_id) {
            e.status = EntryStatus::Committed;
        }
        self.flush().await
    }

    /// Flush the in-memory entries to encrypted disk.
    ///
    /// Written atomically: encrypt to a sibling temp file, then rename over the
    /// target. `rename` is atomic on Windows (MoveFileEx with replace) and Unix,
    /// so a crash mid-write can only ever leave the OLD complete file or the NEW
    /// complete file — never a truncated, undecryptable one. This is what
    /// prevents a mid-save crash from permanently bricking the project.
    async fn flush(&self) -> Result<()> {
        let json = serde_json::to_vec(&self.entries)?;
        let encrypted = encrypt(&self.cipher, &json)?;

        // Sibling temp path: "changelog.enc" -> "changelog.enc.tmp"
        let tmp = {
            let mut s = self.path.clone().into_os_string();
            s.push(".tmp");
            PathBuf::from(s)
        };

        fs::write(&tmp, &encrypted)
            .await
            .context("Failed to write changelog temp file")?;
        fs::rename(&tmp, &self.path)
            .await
            .context("Failed to commit changelog")?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn all_entries(&self) -> &[ChangelogEntry] {
        &self.entries
    }

    /// Find an entry by its ID
    pub fn find_by_id(&self, id: &str) -> Option<&ChangelogEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

fn derive_key(passphrase: &str) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), ARGON2_SALT, &mut key)
        .map_err(|e| anyhow::anyhow!("Key derivation failed: {}", e))?;
    Ok(key)
}

fn encrypt(cipher: &XChaCha20Poly1305, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

    // Prepend nonce so we can decrypt later: [24 nonce bytes][ciphertext]
    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt(cipher: &XChaCha20Poly1305, data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < 24 {
        anyhow::bail!("Changelog data too short to contain nonce");
    }
    let nonce = XNonce::from_slice(&data[..24]);
    cipher
        .decrypt(nonce, &data[24..])
        .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))
}

async fn load_entries(path: &Path, cipher: &XChaCha20Poly1305) -> Result<Vec<ChangelogEntry>> {
    let raw = fs::read(path).await?;
    let json = decrypt(cipher, &raw)?;
    let entries: Vec<ChangelogEntry> = serde_json::from_slice(&json)?;
    Ok(entries)
}

// ─── Changelog entry ID generator ─────────────────────────────────────────────

pub fn new_entry_id() -> String {
    let now = chrono::Utc::now();
    let rand_suffix: u16 = rand::random();
    format!("chg_{}_{:04}", now.format("%Y%m%d_%H%M%S"), rand_suffix)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EntryStatus;

    fn tmp_root(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("0g_cl_test_{}_{}", tag, rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn entry(id: &str, file: &str, prev: Option<&str>) -> ChangelogEntry {
        ChangelogEntry {
            id: id.into(),
            file: file.into(),
            changed_by: "tester".into(),
            model: "test".into(),
            timestamp: chrono::Utc::now(),
            summary: "s".into(),
            affected_lines: vec![],
            affected_functions: vec![],
            previous_content: prev.map(|s| s.to_string()),
            status: EntryStatus::Committed,
            conflict_flag: false,
        }
    }

    // Atomic write round-trips: append, drop, reopen with same passphrase,
    // and the entries decrypt back intact. This exercises the temp-file+rename
    // flush path end to end.
    #[tokio::test]
    async fn atomic_roundtrip_persists_entries() {
        let root = tmp_root("roundtrip");
        {
            let mut cl = Changelog::open(&root, "pw123").await.unwrap();
            cl.append(entry("a", "x.rs", Some("old-a"))).await.unwrap();
            cl.append(entry("b", "y.rs", Some("old-b"))).await.unwrap();
        }
        // No stale temp file left behind after a clean flush
        let tmp = root.join(".0g").join("changelog.enc.tmp");
        assert!(!tmp.exists(), "temp file should be renamed away");

        let cl2 = Changelog::open(&root, "pw123").await.unwrap();
        assert_eq!(cl2.all_entries().len(), 2);
        assert_eq!(cl2.find_by_id("a").unwrap().previous_content.as_deref(), Some("old-a"));

        std::fs::remove_dir_all(&root).ok();
    }

    // Wrong passphrase must NOT silently reset — it errors (protects a typo
    // from nuking real history).
    #[tokio::test]
    async fn wrong_passphrase_errors() {
        let root = tmp_root("wrongpw");
        {
            let mut cl = Changelog::open(&root, "correct").await.unwrap();
            cl.append(entry("a", "x.rs", None)).await.unwrap();
        }
        let reopened = Changelog::open(&root, "WRONG").await;
        assert!(reopened.is_err(), "wrong passphrase must fail, not reset");
        std::fs::remove_dir_all(&root).ok();
    }

    // Prune strips previous_content beyond the retain window but keeps metadata.
    #[tokio::test]
    async fn prune_bounds_previous_content() {
        let root = tmp_root("prune");
        let mut cl = Changelog::open(&root, "pw").await.unwrap();
        let total = PREV_CONTENT_RETAIN + 10;
        for i in 0..total {
            cl.append(entry(&format!("e{}", i), "x.rs", Some("blob"))).await.unwrap();
        }
        // All entries still present (well under MAX_ENTRIES)
        assert_eq!(cl.all_entries().len(), total);
        // Oldest entry lost its heavy snapshot...
        assert!(cl.find_by_id("e0").unwrap().previous_content.is_none());
        // ...but kept its metadata (audit trail intact)
        assert_eq!(cl.find_by_id("e0").unwrap().changed_by, "tester");
        // Newest entry still has its snapshot (revert works on recent changes)
        let newest = format!("e{}", total - 1);
        assert_eq!(cl.find_by_id(&newest).unwrap().previous_content.as_deref(), Some("blob"));
        std::fs::remove_dir_all(&root).ok();
    }
}
