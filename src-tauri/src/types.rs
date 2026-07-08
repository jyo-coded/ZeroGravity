use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EntryStatus {
    Committed,
    Pending,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangelogEntry {
    pub id: String,
    pub file: String,
    pub changed_by: String,
    pub model: String,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
    pub affected_lines: Vec<u32>,
    pub affected_functions: Vec<String>,
    pub previous_content: Option<String>,
    pub status: EntryStatus,
    pub conflict_flag: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub provider: String,
    pub model_name: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserIdentity {
    pub username: String,
    pub avatar_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub invite_code: String,
    pub root_path: String,
    pub created_at: DateTime<Utc>,
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
    pub last_edited_by: Option<String>,
    pub last_edited_at: Option<DateTime<Utc>>,
    pub last_editor_color: Option<String>,
}

/// Payload from Tauri command for committing a write
#[derive(Debug, Deserialize)]
pub struct CommitWritePayload {
    pub file: String,
    pub content: String,
    pub summary: String,
    pub affected_lines: Vec<u32>,
    pub affected_functions: Vec<String>,
}

/// Payload from Tauri command for AI invocation
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct InvokeAiPayload {
    pub file: String,
    pub prompt: String,
    pub current_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Owner,
    Alter,
    Read,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub username: String,
    pub permission: Permission,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectManifest {
    pub members: Vec<Member>,
}
