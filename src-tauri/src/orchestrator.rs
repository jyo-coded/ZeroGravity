//! Orchestrator — the write gatekeeper for 0G
//!
//! All model writes must pass through the Orchestrator before touching disk.
//! Implements FCFS ordering, conflict detection, and change log commitment.
//!
//! Also owns `enrich_prompt` — assembles the full AI context block from:
//!   [SYSTEM CONTEXT]  — project type, structure, key files, README
//!   [GRAPH CONTEXT]   — structural map: imports, reverse-deps, definitions
//!   Currently open file content
//!   [REFERENCED FILES]— any files mentioned in chat that exist in the project
//!   [TEAM CONTEXT]    — recent cross-file activity + per-file changelog
//!   [USER REQUEST]    — the actual user prompt

use anyhow::Result;
use chrono::Utc;
use std::path::{Component, Path, PathBuf};

use crate::{
    changelog::{new_entry_id, Changelog},
    graph::CodeGraph,
    types::{ChangelogEntry, CommitWritePayload, ConflictInfo, EntryStatus},
};

pub struct Orchestrator;

/// What happened to a write arriving from a peer.
///
/// `Applied` means it landed on disk (either cleanly, or because the local copy
/// was identical / had not diverged). `Conflict` means the local copy moved on
/// independently and reconciling the two needs a 3-way merge — the payload
/// carries the three sides for the frontend to merge or resolve. Crucially, in
/// the `Conflict` case **nothing is written**: the remote write is held, not
/// dropped, and the local file is left untouched, so no keystroke is ever lost
/// to a race the way last-write-wins would lose it.
pub enum RemoteOutcome {
    Applied(ChangelogEntry),
    Conflict(ConflictInfo),
}

fn safe_project_join(root: &Path, path: &str) -> Result<PathBuf> {
    if path.trim().is_empty() || Path::new(path).is_absolute() {
        anyhow::bail!("Invalid project-relative path");
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
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("Path must stay inside the open project");
            }
        }
    }

    if !saw_normal {
        anyhow::bail!("Invalid project-relative path");
    }

    Ok(out)
}

/// The edit contract sent with every request.
///
/// Placed FIRST in the prompt so it survives context truncation: if a long file
/// pushes content out of the window, the model must still know how to express a
/// change. Without this the model returns prose or whole-file rewrites, and the
/// deterministic applier has nothing to apply.
const EDIT_PROTOCOL: &str = r#"[HOW TO EDIT CODE]
When you change code, emit edit blocks in exactly this format - one per contiguous change:

```edit <relative/file/path>
<<<<<<< SEARCH
(the exact existing lines to replace, copied verbatim from the file)
=======
(the replacement lines)
>>>>>>> REPLACE
```

Rules:
- SEARCH must match the current file exactly, including indentation. Copy it; do not retype it.
- Include enough surrounding lines to make the match unique within the file.
- Use several small blocks rather than one large one. Never reproduce a whole file to change part of it.
- To create a new file, leave the SEARCH section empty and put the full contents in REPLACE.
- Explain your reasoning in prose outside the blocks. Never describe an edit you did not emit as a block.
- If you are only answering a question, emit no blocks at all."#;

impl Orchestrator {
    pub fn new() -> Self {
        Self
    }

    /// Main entry point: intercept a write, check conflicts, commit or re-evaluate.
    pub async fn intercept_write(
        &self,
        payload: CommitWritePayload,
        username: String,
        model_label: String,
        changelog: &mut Changelog,
        root: PathBuf,
    ) -> Result<ChangelogEntry> {
        let has_conflict = changelog.has_conflict(
            &payload.file,
            &username,
            &payload.affected_lines,
            &payload.affected_functions,
        );

        if has_conflict {
            log::warn!(
                "Conflict detected for {} — queuing for re-evaluation",
                payload.file
            );
            // Flag the commit but don't block — conflict re-evaluation is a future feature
            return self
                .commit_entry(payload, username, model_label, changelog, root, true)
                .await;
        }

        self.commit_entry(payload, username, model_label, changelog, root, false)
            .await
    }

    /// Process a write arriving from a remote P2P peer.
    ///
    /// Reconciles instead of clobbering. The old behaviour wrote the incoming
    /// content over whatever was on disk and, at most, set a flag — so if a
    /// teammate saved a change to *any* line while you had unsaved-to-ledger
    /// edits of your own, your work vanished with no trace. Here the local copy
    /// is compared against the version the peer actually edited:
    ///
    ///   • identical to theirs        → nothing to do (idempotent re-delivery)
    ///   • unchanged since the base   → fast-forward: safe to take theirs wholesale
    ///   • diverged                   → hand all three sides back as a Conflict;
    ///                                   the file on disk is left exactly as-is
    ///
    /// The line/function overlap heuristic is deliberately gone from this path:
    /// for whole-file sync it produced false "no conflict" verdicts (two people
    /// editing different lines of the same file) that were exactly the silent-
    /// data-loss case. Divergence is decided by content, not by a 30-second timer.
    pub async fn apply_remote_update(
        &self,
        entry: ChangelogEntry,
        new_content: String,
        changelog: &mut Changelog,
        root: PathBuf,
    ) -> Result<RemoteOutcome> {
        let abs_path = safe_project_join(&root, &entry.file)?;
        let ours = if abs_path.exists() {
            tokio::fs::read_to_string(&abs_path).await.ok()
        } else {
            None
        };

        // Already in sync (or a duplicate delivery): record the history entry so
        // the ledger reflects the peer's change, but don't rewrite an identical file.
        if ours.as_deref() == Some(new_content.as_str()) {
            let mut final_entry = entry.clone();
            final_entry.conflict_flag = false;
            changelog.append(final_entry.clone()).await?;
            return Ok(RemoteOutcome::Applied(final_entry));
        }

        // We diverged from what the peer edited — only merge3 can reconcile that,
        // and that lives on the frontend where the diff engine already is. Hold
        // the remote write; touch nothing on disk.
        let local_diverged = match (&ours, &entry.previous_content) {
            // No local file yet, or no known ancestor: if the contents differ we
            // can't prove they're compatible, so treat as a conflict to be safe.
            (None, _) => abs_path.exists(),
            // Local copy still matches the ancestor → we have no competing edit,
            // so taking theirs is a plain fast-forward, not a conflict.
            (Some(o), Some(base)) => o != base,
            // Ancestor unknown but local content differs from theirs → diverged.
            (Some(_), None) => true,
        };

        if local_diverged {
            log::warn!(
                "Remote update for {} conflicts with local edits — holding for merge",
                entry.file
            );
            return Ok(RemoteOutcome::Conflict(ConflictInfo {
                id: new_entry_id(),
                file: entry.file.clone(),
                base: entry.previous_content.clone(),
                ours: ours.unwrap_or_default(),
                theirs: new_content,
                their_user: entry.changed_by.clone(),
                their_summary: entry.summary.clone(),
                their_model: entry.model.clone(),
            }));
        }

        // Fast-forward: local is unchanged since the base, so theirs supersedes it
        // cleanly. Keep the pre-write content as previous_content so this remote
        // change is revertible from the local ledger like any other.
        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(&abs_path, new_content.as_bytes()).await?;

        let mut final_entry = entry.clone();
        final_entry.conflict_flag = false;
        final_entry.previous_content = ours;
        changelog.append(final_entry.clone()).await?;
        log::info!(
            "Applied remote P2P entry {} for {}",
            final_entry.id,
            final_entry.file
        );

        Ok(RemoteOutcome::Applied(final_entry))
    }

    // ─── Prompt enrichment ────────────────────────────────────────────────────

    /// Build the full enriched prompt that every AI invocation receives.
    ///
    /// Layer order (most structural → most specific):
    ///   1. Project summary (type, tree, key files, README)
    ///   2. **Graph context** (imports, reverse-deps, definitions for the active file)
    ///   3. Active file content
    ///   4. Referenced files (files mentioned by name in chat)
    ///   5. Team context (recent cross-file + per-file changelog activity)
    ///   6. User request
    #[allow(clippy::too_many_arguments)]
    pub fn enrich_prompt(
        &self,
        base_prompt: &str,
        file: &str,
        current_content: &str,
        project_summary: &str,
        changelog: Option<&Changelog>,
        chat_context: &str,
        context_map: Option<&std::collections::HashMap<String, String>>,
        graph: Option<&CodeGraph>,
    ) -> String {
        // ── Graph context block ───────────────────────────────────────────────
        let graph_block = graph.map(|g| g.query_context(file)).unwrap_or_default();

        // ── Referenced files (mentioned by name in chat) ──────────────────────
        let mut referenced_blocks = String::new();
        if let Some(map) = context_map {
            let mut matched = 0;
            for (path, content) in map.iter() {
                if path == file {
                    continue;
                }
                if chat_context.contains(path) {
                    referenced_blocks
                        .push_str(&format!("File: {}\nContent:\n{}\n\n", path, content));
                    matched += 1;
                    if matched >= 3 {
                        break;
                    }
                }
            }
        }

        let referenced_section = if referenced_blocks.is_empty() {
            String::new()
        } else {
            format!("[REFERENCED FILES]\n{}\n", referenced_blocks)
        };

        // ── Team context (cross-file) ─────────────────────────────────────────
        let cross_file_entries = changelog
            .map(|cl| cl.get_last_n_cross_file(5))
            .unwrap_or_default();

        let team_context_block = if cross_file_entries.is_empty() {
            "No recent modifications.".to_string()
        } else {
            cross_file_entries
                .iter()
                .map(|e| {
                    format!(
                        "- {} | {} via {}: {} in {}",
                        e.timestamp.format("%H:%M:%S"),
                        e.changed_by,
                        e.model,
                        e.summary,
                        e.file
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        // ── Per-file changelog ────────────────────────────────────────────────
        let file_entries = changelog
            .map(|cl| cl.last_n_for_file(file, 5))
            .unwrap_or_default();

        let previous_content_block = file_entries
            .iter()
            .find_map(|e| e.previous_content.as_ref())
            .map(|content| {
                format!(
                    "[PREVIOUS FILE CONTENT]\n\
                    Below is the content of the file before the latest change. Use this if the user asks you to undo or revert changes:\n\
                    {}\n\n",
                    content
                )
            })
            .unwrap_or_default();

        let current_file_block = if file_entries.is_empty() {
            "No recent modifications.".to_string()
        } else {
            file_entries
                .iter()
                .map(|e| {
                    format!(
                        "- {} | {} via {}: {}",
                        e.timestamp.format("%H:%M:%S"),
                        e.changed_by,
                        e.model,
                        e.summary
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        // ── Conversation history (enables multi-turn vibe coding) ────────────
        // Truncate to last ~4000 chars to stay within context budgets.
        let conversation_block = if chat_context.is_empty() {
            String::new()
        } else {
            let truncated = if chat_context.len() > 4000 {
                let start = chat_context.len() - 4000;
                // Find the next newline after the cut point to avoid splitting a message
                let safe_start = chat_context[start..]
                    .find('\n')
                    .map(|i| start + i + 1)
                    .unwrap_or(start);
                format!(
                    "[CONVERSATION HISTORY]\n(earlier messages truncated)\n{}\n\n",
                    &chat_context[safe_start..]
                )
            } else {
                format!("[CONVERSATION HISTORY]\n{}\n\n", chat_context)
            };
            truncated
        };

        // ── Assemble the full prompt ──────────────────────────────────────────
        // Graph context is injected right after the project summary so the model
        // understands architecture BEFORE reading the raw file content.
        let graph_section = if graph_block.is_empty() {
            String::new()
        } else {
            format!("{}\n\n", graph_block)
        };

        format!(
            "{}\n\n[SYSTEM CONTEXT]\n{}\n\n{}Currently Open File: {}\nFile Content:\n{}\n\n{}{}[TEAM CONTEXT]\nRecent teammate changes (last 5 cross-file):\n{}\n\nChangelog for current file (last 5 entries):\n{}\n\n{}[USER REQUEST]\n{}",
            EDIT_PROTOCOL,
            project_summary,
            graph_section,
            file,
            current_content,
            previous_content_block,
            referenced_section,
            team_context_block,
            current_file_block,
            conversation_block,
            base_prompt,
        )
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    async fn commit_entry(
        &self,
        payload: CommitWritePayload,
        username: String,
        model_label: String,
        changelog: &mut Changelog,
        root: PathBuf,
        conflict_flag: bool,
    ) -> Result<ChangelogEntry> {
        let abs_path = safe_project_join(&root, &payload.file)?;
        let previous_content = if abs_path.exists() {
            tokio::fs::read_to_string(&abs_path).await.ok()
        } else {
            None
        };

        if let Some(parent) = abs_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&abs_path, payload.content.as_bytes()).await?;

        let entry = ChangelogEntry {
            id: new_entry_id(),
            file: payload.file,
            changed_by: username,
            model: model_label,
            timestamp: Utc::now(),
            summary: payload.summary,
            affected_lines: payload.affected_lines,
            affected_functions: payload.affected_functions,
            previous_content,
            status: EntryStatus::Committed,
            conflict_flag,
            session_id: payload.session_id,
        };

        changelog.append(entry.clone()).await?;
        log::info!("Committed entry {} for {}", entry.id, entry.file);
        Ok(entry)
    }
}
