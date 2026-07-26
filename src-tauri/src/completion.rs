//! completion.rs — inline (ghost-text) code completion.
//!
//! Separate from the chat path on purpose. Chat is a long, context-heavy,
//! streaming conversation; completion is a short, latency-critical, fire-and-
//! forget request that happens on almost every keystroke. Routing it through the
//! chat pipeline would drag the whole project summary and changelog into a call
//! that must return in a few hundred milliseconds.
//!
//! The prompt is fill-in-the-middle shaped: the model receives the code before
//! and after the cursor and returns only the text that belongs between them.

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::commands::AppState;

/// Characters of context on each side of the cursor. Enough for the model to see
/// the enclosing function and nearby types without paying for a whole file.
const PREFIX_BUDGET: usize = 3000;
const SUFFIX_BUDGET: usize = 1000;

#[derive(Serialize)]
pub struct Completion {
    pub text: String,
    pub model: String,
}

/// Take at most `budget` bytes from the end of `s`, on a char boundary.
fn tail(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    let mut start = s.len() - budget;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Take at most `budget` bytes from the start of `s`, on a char boundary.
fn head(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    let mut end = budget;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Strip the wrappers models add even when told not to: code fences, a repeat of
/// the prefix, or a chatty preamble. Whatever survives is inserted verbatim at
/// the cursor, so anything decorative here becomes corrupt code.
fn clean(raw: &str, prefix: &str) -> String {
    let mut t = raw.to_string();

    if let Some(i) = t.find("```") {
        // Drop everything before the fence, then the language tag line.
        let after = &t[i + 3..];
        let after = after.split_once('\n').map(|(_, rest)| rest).unwrap_or(after);
        t = after.split("```").next().unwrap_or(after).to_string();
    }

    // Models sometimes echo the trailing line of the prefix before continuing.
    if let Some(last_line) = prefix.lines().last() {
        let lt = last_line.trim_start();
        if !lt.is_empty() && t.trim_start().starts_with(lt) {
            let cut = t.trim_start().len() - t.trim_start()[lt.len()..].len();
            let idx = t.len() - t.trim_start().len() + cut;
            t = t[idx..].to_string();
        }
    }

    // A single trailing newline is normal; more is the model padding.
    while t.ends_with("\n\n") {
        t.pop();
    }
    t
}

#[tauri::command]
pub async fn ai_complete(
    prefix: String,
    suffix: String,
    language: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Completion, String> {
    let config = state
        .model_config
        .lock()
        .await
        .clone()
        .ok_or("No model configured")?;

    let pre = tail(&prefix, PREFIX_BUDGET);
    let suf = head(&suffix, SUFFIX_BUDGET);

    let prompt = format!(
        "You are a code completion engine. Continue the code at <CURSOR>.\n\
         Output ONLY the code that belongs at the cursor — no explanation, no markdown fences, \
         no repetition of the code before the cursor.\n\
         Complete at most a few lines. If nothing should be inserted, output nothing.\n\n\
         Language: {language}\n\n\
         <CODE_BEFORE>\n{pre}\n</CODE_BEFORE>\n\
         <CURSOR>\n\
         <CODE_AFTER>\n{suf}\n</CODE_AFTER>\n\n\
         Completion:"
    );

    let client = Arc::clone(&state.model_client);
    let rotation = state.rotation.lock().await.clone();
    let usage = Arc::clone(&state.usage);
    let last = state.last_model_used.lock().await.clone();

    let (raw, used) = crate::rotation::invoke_with_failover(
        client, &app, config, rotation, usage, last, prompt, None,
    )
    .await?;

    Ok(Completion { text: clean(&raw, &prefix), model: used.label })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_code_fences() {
        let out = clean("```rust\nlet x = 1;\n```", "");
        assert_eq!(out.trim(), "let x = 1;");
    }

    #[test]
    fn strips_echoed_prefix_line() {
        // The model repeated "let x =" before continuing.
        let out = clean("let x = 42;", "fn main() {\n    let x =");
        assert!(out.starts_with(" 42;") || out.trim_start().starts_with("42;"), "got {out:?}");
    }

    #[test]
    fn passes_plain_text_through() {
        assert_eq!(clean("    return 1;", ""), "    return 1;");
    }

    #[test]
    fn char_boundary_safe() {
        // Multi-byte characters must not panic the budget slicers.
        let s = "日本語のコード".repeat(400);
        let _ = tail(&s, 100);
        let _ = head(&s, 100);
    }
}

/// Send a one-token probe to a specific model configuration.
///
/// Exists so a user can verify a key BEFORE relying on it. Without this the only
/// way to learn a key is wrong is to watch the rotation silently fall through to
/// a backup mid-task — which is how a bad key survives all the way to a demo.
///
/// Deliberately takes an explicit config rather than reading the stored one, so
/// an unsaved key can be tested before it is committed to.
#[tauri::command]
pub async fn test_model(
    config: crate::types::ModelConfig,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let client = Arc::clone(&state.model_client);
    match client
        .invoke(&config, "Reply with the single word: ok")
        .await
    {
        Ok(text) => Ok(text.trim().chars().take(60).collect()),
        Err(e) => Err(e.to_string()),
    }
}
