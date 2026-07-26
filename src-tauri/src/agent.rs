//! agent.rs — the primitive the agent loop is built on.
//!
//! `invoke_ai` is the chat path: it enriches the prompt with project summary,
//! graph context, and changelog, then streams. An agent step needs the opposite —
//! the caller has already assembled an exact prompt (system contract + tool
//! results so far) and must get back precisely what the model said, with nothing
//! added and nothing streamed.
//!
//! Keeping this separate is what lets the loop control its own context window.
//! Re-enriching on every step would grow the prompt without bound and re-send
//! the whole project on each of a dozen iterations.

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::commands::AppState;

#[derive(Serialize)]
pub struct RawResponse {
    pub text: String,
    /// The model that actually answered — may differ from the configured one
    /// after a failover, and the UI attributes the work to it.
    pub model: String,
}

#[tauri::command]
pub async fn ai_raw(
    prompt: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<RawResponse, String> {
    let config = state
        .model_config
        .lock()
        .await
        .clone()
        .ok_or("No model configured")?;

    let client = Arc::clone(&state.model_client);
    let rotation = state.rotation.lock().await.clone();
    let usage = Arc::clone(&state.usage);
    let last = state.last_model_used.lock().await.clone();

    let (text, used) = crate::rotation::invoke_with_failover(
        client, &app, config, rotation, usage, last, prompt, None,
    )
    .await?;

    Ok(RawResponse { text, model: used.label })
}
