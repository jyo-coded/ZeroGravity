//! git.rs — source control.
//!
//! Drives the user's own `git` binary rather than linking libgit2. That choice
//! is deliberate: it honours the user's real configuration (credential helpers,
//! signing keys, hooks, includes, aliases, safe.directory), which a library
//! reimplementation silently ignores — and a commit that behaves differently
//! from the one the user would have typed is worse than no commit button.
//!
//! Every command is a plain data read or a single explicit write. Nothing here
//! rewrites history, force-pushes, or touches a remote.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::commands::AppState;

/// Run git and capture stdout, stderr, and success separately — callers need to
/// surface the real message when git refuses (nothing staged, bad branch name…)
/// rather than a generic failure.
fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git is not available on PATH: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { "git command failed".into() } else { err })
    }
}

async fn root_of(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .project
        .lock()
        .await
        .as_ref()
        .map(|p| PathBuf::from(&p.root_path))
        .ok_or_else(|| "No project open".to_string())
}

#[derive(Serialize)]
pub struct FileChange {
    pub path: String,
    /// Two-letter porcelain code, e.g. " M", "M ", "??", "A ", "UU".
    pub code: String,
    pub staged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize)]
pub struct Status {
    pub is_repo: bool,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<FileChange>,
}

/// Full working-tree status, split into staged / unstaged / untracked, plus how
/// far the branch has drifted from its upstream.
#[tauri::command]
pub async fn git_status_full(state: State<'_, AppState>) -> Result<Status, String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let Ok(branch_out) = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]) else {
            return Ok(Status {
                is_repo: false,
                branch: String::new(),
                upstream: None,
                ahead: 0,
                behind: 0,
                changes: vec![],
            });
        };
        let branch = branch_out.trim().to_string();

        let upstream = git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // "<behind>\t<ahead>" against the upstream, when one exists.
        let (mut ahead, mut behind) = (0u32, 0u32);
        if upstream.is_some() {
            if let Ok(counts) = git(&root, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]) {
                let mut it = counts.split_whitespace();
                behind = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                ahead = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            }
        }

        let mut changes = vec![];
        // -z gives NUL-separated entries, so paths containing spaces or quotes
        // survive intact; the human-readable format mangles them.
        if let Ok(raw) = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]) {
            let mut parts = raw.split('\0').filter(|s| !s.is_empty()).peekable();
            while let Some(entry) = parts.next() {
                if entry.len() < 3 {
                    continue;
                }
                let code = entry[..2].to_string();
                let mut path = entry[3..].to_string();
                // A rename entry is followed by its source path; consume it so
                // the source is never treated as a change of its own.
                if code.starts_with('R') || code.starts_with('C') {
                    let _ = parts.next();
                }
                path = path.replace('\\', "/");

                let x = code.chars().next().unwrap_or(' ');
                let y = code.chars().nth(1).unwrap_or(' ');
                changes.push(FileChange {
                    conflicted: code == "UU" || x == 'U' || y == 'U',
                    untracked: code == "??",
                    staged: x != ' ' && x != '?',
                    code,
                    path,
                });
            }
        }

        Ok(Status { is_repo: true, branch, upstream, ahead, behind, changes })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&root, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&root, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Throw away working-tree edits to a tracked file. Destructive and
/// unrecoverable through git, so the UI must confirm before calling it.
#[tauri::command]
pub async fn git_discard(paths: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<&str> = vec!["restore", "--worktree", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        git(&root, &args).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_commit(
    message: String,
    stage_all: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("A commit needs a message".into());
    }
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        if stage_all {
            git(&root, &["add", "-A"])?;
        }
        git(&root, &["commit", "-m", &message])?;
        let sha = git(&root, &["rev-parse", "--short", "HEAD"])?;
        Ok(sha.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Commit {
    pub sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[tauri::command]
pub async fn git_log(limit: u32, state: State<'_, AppState>) -> Result<Vec<Commit>, String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let n = format!("-{}", limit.clamp(1, 500));
        // Unit separator between fields — safe against subjects containing any
        // printable delimiter a person might type.
        let out = git(&root, &[
            "log", &n, "--date=short", "--pretty=format:%h\x1f%an\x1f%ad\x1f%s",
        ])
        .unwrap_or_default();
        Ok(out
            .lines()
            .filter_map(|l| {
                let mut f = l.split('\x1f');
                Some(Commit {
                    sha: f.next()?.to_string(),
                    author: f.next()?.to_string(),
                    date: f.next()?.to_string(),
                    subject: f.next().unwrap_or_default().to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>) -> Result<Branches, String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let current = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_default()
            .trim()
            .to_string();
        let local = git(&root, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            .unwrap_or_default()
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Branches { current, local })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
pub struct CheckoutArgs {
    pub branch: String,
    /// Create the branch first. Fails loudly if it already exists rather than
    /// silently switching to someone else's branch of the same name.
    pub create: bool,
}

#[tauri::command]
pub async fn git_checkout(args: CheckoutArgs, state: State<'_, AppState>) -> Result<(), String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        if args.create {
            git(&root, &["checkout", "-b", &args.branch]).map(|_| ())
        } else {
            git(&root, &["checkout", &args.branch]).map(|_| ())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct BlameLine {
    pub line: u32,
    pub sha: String,
    pub author: String,
    pub date: String,
    pub summary: String,
}

/// Per-line authorship for a file, parsed from git's porcelain blame.
#[tauri::command]
pub async fn git_blame(file: String, state: State<'_, AppState>) -> Result<Vec<BlameLine>, String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let out = git(&root, &["blame", "--line-porcelain", "--", &file]).unwrap_or_default();
        let mut lines = vec![];
        let (mut sha, mut author, mut date, mut summary) =
            (String::new(), String::new(), String::new(), String::new());
        let mut lineno = 0u32;

        for l in out.lines() {
            if let Some(rest) = l.strip_prefix("author ") {
                author = rest.to_string();
            } else if let Some(rest) = l.strip_prefix("author-time ") {
                // Unix seconds -> date only; the clock time adds noise in a gutter.
                if let Ok(ts) = rest.parse::<i64>() {
                    date = chrono::DateTime::from_timestamp(ts, 0)
                        .map(|d| d.format("%Y-%m-%d").to_string())
                        .unwrap_or_default();
                }
            } else if let Some(rest) = l.strip_prefix("summary ") {
                summary = rest.to_string();
            } else if l.starts_with('\t') {
                // The tab-prefixed line is the source line itself and closes the entry.
                lines.push(BlameLine {
                    line: lineno,
                    sha: sha.clone(),
                    author: author.clone(),
                    date: date.clone(),
                    summary: summary.clone(),
                });
            } else {
                // Header: "<sha> <origLine> <finalLine> [<count>]"
                let mut it = l.split_whitespace();
                if let (Some(h), _, Some(fin)) = (it.next(), it.next(), it.next()) {
                    if h.len() >= 7 && h.chars().all(|c| c.is_ascii_hexdigit()) {
                        sha = h[..7].to_string();
                        lineno = fin.parse().unwrap_or(0);
                    }
                }
            }
        }
        Ok(lines)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unified diff for one file — staged or working tree.
#[tauri::command]
pub async fn git_file_diff_text(
    file: String,
    staged: bool,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = root_of(&state).await?;
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(&file);
        Ok(git(&root, &args).unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}
