//! Model rotation & failover (B4) + context re-establishment (B5).
//!
//! Every AI invocation goes through `invoke_with_failover`:
//!   1. Candidates = primary model + the user's ordered rotation list.
//!   2. Proactive skip when a provider is at its known free-tier cap.
//!   3. On any invocation error (429, connection, auth), the SAME request
//!      retries against the next candidate — a `model_rotated` event tells
//!      the frontend to toast.
//!   4. B5: when the serving candidate differs from the model that handled
//!      the previous request, the prompt gets a [MODEL HANDOFF] preamble.
//!      The enriched context itself is already rebuilt fresh per request
//!      by `enrich_prompt`, so the new model receives the complete
//!      [SYSTEM CONTEXT]/[REFERENCED FILES]/[TEAM CONTEXT] block.
//!
//! Free-tier caps are approximate by design and the rotation list is
//! user-editable config — free model IDs change without notice.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use chrono::{NaiveDate, Utc};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::model::ModelClient;
use crate::types::ModelConfig;

pub struct ProviderUsage {
    pub minute_start: Instant,
    pub minute_count: u32,
    pub day_start: NaiveDate,
    pub day_count: u32,
    pub last_used: Option<chrono::DateTime<Utc>>,
}

/// Known free-tier caps: (requests/minute, requests/day). Approximate.
pub fn caps_for(provider: &str) -> (Option<u32>, Option<u32>) {
    match provider {
        "groq" => (Some(30), None),
        "openrouter" => (Some(20), Some(200)),
        // Gemini's free tier is quota'd per DAY, not per minute - the reason it
        // survives a multi-step agent run where a per-minute cap does not.
        "google" => (None, Some(1500)),
        "cerebras" => (Some(30), None),
        // Local and paid endpoints have no free-tier cap worth guessing at.
        "ollama" | "ollama-cloud" | "anthropic" | "openai" => (None, None),
        _ => (None, None),
    }
}

async fn at_cap(usage: &Mutex<HashMap<String, ProviderUsage>>, provider: &str) -> bool {
    let (per_min, per_day) = caps_for(provider);
    if per_min.is_none() && per_day.is_none() {
        return false;
    }
    let map = usage.lock().await;
    let Some(u) = map.get(provider) else { return false };

    if let Some(cap) = per_min {
        if u.minute_start.elapsed().as_secs() < 60 && u.minute_count >= cap {
            return true;
        }
    }
    if let Some(cap) = per_day {
        if u.day_start == Utc::now().date_naive() && u.day_count >= cap {
            return true;
        }
    }
    false
}

async fn record(usage: &Mutex<HashMap<String, ProviderUsage>>, provider: &str) {
    let mut map = usage.lock().await;
    let now_date = Utc::now().date_naive();
    let u = map.entry(provider.to_string()).or_insert_with(|| ProviderUsage {
        minute_start: Instant::now(),
        minute_count: 0,
        day_start: now_date,
        day_count: 0,
        last_used: None,
    });
    if u.minute_start.elapsed().as_secs() >= 60 {
        u.minute_start = Instant::now();
        u.minute_count = 0;
    }
    if u.day_start != now_date {
        u.day_start = now_date;
        u.day_count = 0;
    }
    u.minute_count += 1;
    u.day_count += 1;
    u.last_used = Some(Utc::now());
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn with_handoff(prompt: &str, last_used: &Option<String>, candidate_label: &str) -> String {
    match last_used {
        Some(prev) if prev != candidate_label => format!(
            "[MODEL HANDOFF]\nYou are continuing a session previously handled by {}.\n\
             Below is the full current project and conversation context.\n\
             Do not assume you have seen this before — read it fresh.\n\n{}",
            prev, prompt
        ),
        _ => prompt.to_string(),
    }
}

/// Run one request against primary + rotation with proactive cap skips and
/// error failover. Returns (output, config that served it).
#[allow(clippy::too_many_arguments)]
pub async fn invoke_with_failover(
    client: Arc<ModelClient>,
    app: &AppHandle,
    primary: ModelConfig,
    rotation: Vec<ModelConfig>,
    usage: Arc<Mutex<HashMap<String, ProviderUsage>>>,
    last_used: Option<String>,
    prompt: String,
    image: Option<(String, String)>,
) -> Result<(String, ModelConfig), String> {
    let mut candidates: Vec<ModelConfig> = vec![primary];
    for r in rotation {
        if !candidates
            .iter()
            .any(|c| c.provider == r.provider && c.model_name == r.model_name)
        {
            candidates.push(r);
        }
    }

    let total = candidates.len();
    // Collect every candidate's failure. Reporting only the last one hides the
    // reason the PRIMARY failed, which is the thing the user actually needs.
    let mut failures: Vec<String> = Vec::new();
    let mut last_err = String::from("No model configured");

    for i in 0..total {
        let cand = candidates[i].clone();
        let next_label = candidates.get(i + 1).map(|c| c.label.clone());

        // Proactive: skip a capped provider when a backup exists
        if next_label.is_some() && at_cap(&usage, &cand.provider).await {
            let _ = app.emit(
                "model_rotated",
                json!({
                    "from": cand.label,
                    "to": next_label,
                    "reason": "free-tier rate cap reached (proactive skip)",
                }),
            );
            last_err = format!("{} is at its rate cap", cand.provider);
            failures.push(format!("{}: at its rate cap", cand.label));
            continue;
        }

        let effective_prompt = with_handoff(&prompt, &last_used, &cand.label);
        record(&usage, &cand.provider).await;

        let result = match &image {
            Some((b64, mime)) => {
                client
                    .invoke_with_image(&cand, &effective_prompt, b64, mime)
                    .await
            }
            None => client.invoke(&cand, &effective_prompt).await,
        };

        match result {
            Ok(output) => return Ok((output, cand)),
            Err(e) => {
                let msg = e.to_string();
                let reason = if msg.contains("429") || msg.to_lowercase().contains("rate limit") {
                    "rate limit reached".to_string()
                } else {
                    truncate(&msg, 120)
                };
                if let Some(to) = next_label {
                    let _ = app.emit(
                        "model_rotated",
                        json!({ "from": cand.label, "to": to, "reason": reason }),
                    );
                }
                failures.push(format!("{}: {}", cand.label, msg));
                last_err = msg;
            }
        }
    }

    Err(if failures.len() > 1 {
        // Every model in the chain failed - name each one and why, so the user
        // can tell a bad key from an exhausted quota at a glance.
        format!("All {} models failed. {}", failures.len(), failures.join(" | "))
    } else {
        last_err
    })
}

/// Streaming variant: failover only happens BEFORE the first chunk arrives —
/// once tokens have streamed to the UI, a mid-stream error is surfaced rather
/// than silently re-run (which would duplicate visible text).
#[allow(clippy::too_many_arguments)]
pub async fn invoke_with_failover_stream(
    client: Arc<ModelClient>,
    app: &AppHandle,
    primary: ModelConfig,
    rotation: Vec<ModelConfig>,
    usage: Arc<Mutex<HashMap<String, ProviderUsage>>>,
    last_used: Option<String>,
    prompt: String,
    image: Option<(String, String)>,
    on_chunk: &mut (dyn FnMut(&str) + Send),
) -> Result<(String, ModelConfig), String> {
    let mut candidates: Vec<ModelConfig> = vec![primary];
    for r in rotation {
        if !candidates
            .iter()
            .any(|c| c.provider == r.provider && c.model_name == r.model_name)
        {
            candidates.push(r);
        }
    }

    let total = candidates.len();
    // Collect every candidate's failure. Reporting only the last one hides the
    // reason the PRIMARY failed, which is the thing the user actually needs.
    let mut failures: Vec<String> = Vec::new();
    let mut last_err = String::from("No model configured");

    for i in 0..total {
        let cand = candidates[i].clone();
        let next_label = candidates.get(i + 1).map(|c| c.label.clone());

        if next_label.is_some() && at_cap(&usage, &cand.provider).await {
            let _ = app.emit(
                "model_rotated",
                json!({
                    "from": cand.label,
                    "to": next_label,
                    "reason": "free-tier rate cap reached (proactive skip)",
                }),
            );
            last_err = format!("{} is at its rate cap", cand.provider);
            failures.push(format!("{}: at its rate cap", cand.label));
            continue;
        }

        let effective_prompt = with_handoff(&prompt, &last_used, &cand.label);
        record(&usage, &cand.provider).await;

        let mut emitted = false;
        let result = {
            let mut tap = |d: &str| {
                emitted = true;
                on_chunk(d);
            };
            client
                .invoke_stream(
                    &cand,
                    &effective_prompt,
                    image.as_ref().map(|(b, _)| b.as_str()),
                    image.as_ref().map(|(_, m)| m.as_str()),
                    &mut tap,
                )
                .await
        };

        match result {
            Ok(output) => return Ok((output, cand)),
            Err(e) if !emitted => {
                let msg = e.to_string();
                let reason = if msg.contains("429") || msg.to_lowercase().contains("rate limit") {
                    "rate limit reached".to_string()
                } else {
                    truncate(&msg, 120)
                };
                if let Some(to) = next_label {
                    let _ = app.emit(
                        "model_rotated",
                        json!({ "from": cand.label, "to": to, "reason": reason }),
                    );
                }
                failures.push(format!("{}: {}", cand.label, msg));
                last_err = msg;
            }
            Err(e) => {
                return Err(format!("{} (stream interrupted mid-response)", e));
            }
        }
    }

    Err(if failures.len() > 1 {
        // Every model in the chain failed - name each one and why, so the user
        // can tell a bad key from an exhausted quota at a glance.
        format!("All {} models failed. {}", failures.len(), failures.join(" | "))
    } else {
        last_err
    })
}

/// Seed persisted day-counts (frontend localStorage survives restarts; the
/// in-memory map doesn't). Only today's counts are accepted.
pub async fn import_day_counts(
    usage: &Mutex<HashMap<String, ProviderUsage>>,
    seeds: Vec<(String, u32, String)>, // (provider, day_count, day_start ISO date)
) {
    let today = Utc::now().date_naive();
    let mut map = usage.lock().await;
    for (provider, count, day) in seeds {
        let Ok(date) = day.parse::<NaiveDate>() else { continue };
        if date != today {
            continue;
        }
        let u = map.entry(provider).or_insert_with(|| ProviderUsage {
            minute_start: Instant::now() - std::time::Duration::from_secs(120),
            minute_count: 0,
            day_start: today,
            day_count: 0,
            last_used: None,
        });
        u.day_start = today;
        u.day_count = u.day_count.max(count);
    }
}

/// Snapshot of per-provider usage for the model pill UI.
pub async fn usage_stats(
    usage: &Mutex<HashMap<String, ProviderUsage>>,
) -> Vec<serde_json::Value> {
    let map = usage.lock().await;
    map.iter()
        .map(|(provider, u)| {
            let (per_min, per_day) = caps_for(provider);
            let minute_count = if u.minute_start.elapsed().as_secs() < 60 {
                u.minute_count
            } else {
                0
            };
            let day_count = if u.day_start == Utc::now().date_naive() {
                u.day_count
            } else {
                0
            };
            json!({
                "provider": provider,
                "minute_count": minute_count,
                "minute_cap": per_min,
                "day_count": day_count,
                "day_cap": per_day,
                "last_used": u.last_used.map(|t| t.to_rfc3339()),
            })
        })
        .collect()
}
