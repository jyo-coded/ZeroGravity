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
        self.flush().await
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

    /// Flush the in-memory entries to encrypted disk
    async fn flush(&self) -> Result<()> {
        let json = serde_json::to_vec(&self.entries)?;
        let encrypted = encrypt(&self.cipher, &json)?;
        fs::write(&self.path, &encrypted)
            .await
            .context("Failed to write changelog")?;
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
