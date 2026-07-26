//! Model client — OpenAI-compatible API interface for BYOM support
//! Supports: OpenAI, Anthropic Claude, Google Gemini, Ollama (local), Custom endpoints

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::types::ModelConfig;

pub struct ModelClient {
    http: Client,
}

// ─── OpenAI-compatible format ──────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct OllamaOptions {
    num_ctx: u32,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: MessageContent,
}

/// Either a plain string (text-only) or array of content parts (multimodal)
#[derive(Serialize, Deserialize, Clone)]
#[serde(untagged)]
enum MessageContent {
    Text(String),
    Parts(Vec<ContentPart>),
}

#[derive(Serialize, Deserialize, Clone)]
struct ContentPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ImageUrl {
    url: String, // data:image/png;base64,<base64data>
}

#[derive(Deserialize)]
struct ResponseMessage {
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: ResponseMessage,
}

// ─── Ollama native format (/api/chat) ─────────────────────────────────────────

#[derive(Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<OllamaOptions>,
}

#[derive(Deserialize)]
struct OllamaChatResponse {
    message: ResponseMessage,
}

// ─── Anthropic Messages API format ──────────────────────────────────────────

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Serialize)]
struct AnthropicMessage {
    role: String,
    content: AnthropicMessageContent,
}

#[derive(Serialize)]
#[serde(untagged)]
enum AnthropicMessageContent {
    Text(String),
    Parts(Vec<AnthropicContentPart>),
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum AnthropicContentPart {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { source: AnthropicImageSource },
}

#[derive(Serialize)]
struct AnthropicImageSource {
    #[serde(rename = "type")]
    source_type: String,
    media_type: String,
    data: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicResponseBlock>,
}

#[derive(Deserialize)]
struct AnthropicResponseBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: Option<String>,
}

const SYSTEM_PROMPT: &str = "You are Antigravity, an elite, highly precise AI software engineer in collaborative workspace 0G.\n\
Your goal is to provide clean, robust, production-ready code that works perfectly on the first try.\n\
\n\
OPERATING RULES:\n\
1. High Fidelity & Accuracy: Write correct, secure, and typed code. Anticipate edge cases and handle errors/inputs safely in your code.\n\
2. Crisp & Concise: Keep your text explanations exceptionally brief (1-2 sentences) to save time and tokens, unless the user explicitly asks for a detailed or step-by-step explanation.\n\
3. Format: Wrap all code changes inside standard markdown code blocks with the correct language tag.\n\
\n\
FEW-SHOT EDIT EXAMPLE:\n\
User: \"add a check to see if target file exists before opening it\"\n\
Assistant:\n\
I will add a robust path existence check using Rust's `Path::exists` to safely prevent IO panic errors.\n\
\n\
```rust\n\
use std::path::Path;\n\
use anyhow::{anyhow, Result};\n\
\n\
pub async fn safely_open_file(path_str: &str) -> Result<String> {\n\
    let path = Path::new(path_str);\n\
    if !path.exists() {\n\
        return Err(anyhow!(\"File does not exist: {}\", path_str));\n\
    }\n\
    let content = tokio::fs::read_to_string(path).await?;\n\
    Ok(content)\n\
}\n\
```";

impl ModelClient {
    pub fn new() -> Self {
        // Timeouts are what stop a wedged provider from hanging the whole app
        // forever. We deliberately do NOT set a total-request timeout — that
        // would kill a legitimately long generation. Instead:
        //   connect_timeout: never hang establishing a socket to a dead host.
        //   read_timeout:    resets on every received byte, so a healthy stream
        //                    (tokens arriving continuously) never trips it, but
        //                    a provider that stalls with no data for the window
        //                    errors out — which makes the failover chain in
        //                    rotation.rs actually fire (a hang is never an Err).
        let http = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .read_timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self { http }
    }

    /// Streaming invocation — `on_chunk` receives each text delta as it
    /// arrives; the accumulated full output is returned at the end.
    /// Image requests fall back to non-streaming (one final chunk).
    pub async fn invoke_stream(
        &self,
        config: &ModelConfig,
        prompt: &str,
        image_base64: Option<&str>,
        image_mime_type: Option<&str>,
        on_chunk: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        if let (Some(b64), Some(mime)) = (image_base64, image_mime_type) {
            if !b64.is_empty() {
                let full = self.invoke_with_image(config, prompt, b64, mime).await?;
                on_chunk(&full);
                return Ok(full);
            }
        }

        match config.provider.as_str() {
            "anthropic" => self.stream_anthropic(config, prompt, on_chunk).await,
            "ollama" => {
                let base = config
                    .base_url
                    .as_deref()
                    .unwrap_or("http://localhost:11434")
                    .trim_end_matches('/')
                    .to_string();
                match self
                    .stream_openai_compat(config, prompt, &format!("{}/v1", base), on_chunk)
                    .await
                {
                    Err(e) if e.to_string().contains("404") => {
                        self.stream_ollama_native(config, prompt, &base, on_chunk).await
                    }
                    r => r,
                }
            }
            "google" => {
                self.stream_openai_compat(
                    config,
                    prompt,
                    "https://generativelanguage.googleapis.com/v1beta/openai",
                    on_chunk,
                )
                .await
            }
            "openai" => {
                self.stream_openai_compat(config, prompt, "https://api.openai.com/v1", on_chunk)
                    .await
            }
            "groq" => {
                self.stream_openai_compat(config, prompt, "https://api.groq.com/openai/v1", on_chunk)
                    .await
            }
            "openrouter" => {
                self.stream_openai_compat(config, prompt, "https://openrouter.ai/api/v1", on_chunk)
                    .await
            }
            _ => {
                let base = config
                    .base_url
                    .as_deref()
                    .ok_or_else(|| anyhow!("Custom provider requires a base_url"))?
                    .to_string();
                self.stream_openai_compat(config, prompt, &base, on_chunk).await
            }
        }
    }

    /// OpenAI-compatible SSE stream (`data: {...}` lines with delta.content).
    async fn stream_openai_compat(
        &self,
        config: &ModelConfig,
        prompt: &str,
        base_url: &str,
        on_chunk: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        use futures_util::StreamExt;

        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
        let is_ollama = config.provider == "ollama";
        let body = ChatRequest {
            model: config.model_name.clone(),
            messages: vec![
                ChatMessage { role: "system".into(), content: MessageContent::Text(SYSTEM_PROMPT.into()) },
                ChatMessage { role: "user".into(), content: MessageContent::Text(prompt.into()) },
            ],
            stream: true,
            max_tokens: if is_ollama { None } else { Some(4096) },
            options: if is_ollama { Some(OllamaOptions { num_ctx: 8192 }) } else { None },
        };

        let mut req = self.http.post(&endpoint).json(&body);
        if let Some(key) = &config.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }
        let res = req.send().await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(anyhow!("API error {}: {}", status, text));
        }

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| anyhow!("Stream error: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim_end_matches('\r').trim().to_string();
                buf.drain(..=pos);
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                full.push_str(delta);
                                on_chunk(delta);
                            }
                        }
                    }
                }
            }
        }
        if full.is_empty() {
            return Err(anyhow!("Stream ended without content"));
        }
        Ok(full)
    }

    /// Anthropic Messages API SSE stream (content_block_delta events).
    async fn stream_anthropic(
        &self,
        config: &ModelConfig,
        prompt: &str,
        on_chunk: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        use futures_util::StreamExt;

        let body = AnthropicRequest {
            model: config.model_name.clone(),
            max_tokens: 4096,
            system: Some(SYSTEM_PROMPT.into()),
            messages: vec![AnthropicMessage {
                role: "user".into(),
                content: AnthropicMessageContent::Text(prompt.into()),
            }],
            stream: Some(true),
        };
        let key = config
            .api_key
            .as_deref()
            .ok_or_else(|| anyhow!("Anthropic requires an API key"))?;

        let res = self
            .http
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Anthropic API error {}: {}", status, text));
        }

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| anyhow!("Stream error: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim_end_matches('\r').trim().to_string();
                buf.drain(..=pos);
                if let Some(data) = line.strip_prefix("data:") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                        if v["type"] == "content_block_delta" {
                            if let Some(t) = v["delta"]["text"].as_str() {
                                if !t.is_empty() {
                                    full.push_str(t);
                                    on_chunk(t);
                                }
                            }
                        }
                    }
                }
            }
        }
        if full.is_empty() {
            return Err(anyhow!("Stream ended without content"));
        }
        Ok(full)
    }

    /// Ollama native /api/chat NDJSON stream (pre-0.1.24 fallback).
    async fn stream_ollama_native(
        &self,
        config: &ModelConfig,
        prompt: &str,
        base: &str,
        on_chunk: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        use futures_util::StreamExt;

        let body = OllamaChatRequest {
            model: config.model_name.clone(),
            messages: vec![
                ChatMessage { role: "system".into(), content: MessageContent::Text(SYSTEM_PROMPT.into()) },
                ChatMessage { role: "user".into(), content: MessageContent::Text(prompt.into()) },
            ],
            stream: true,
            options: Some(OllamaOptions { num_ctx: 8192 }),
        };

        let res = self
            .http
            .post(format!("{}/api/chat", base))
            .json(&body)
            .send()
            .await?;
        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Ollama error {}: {}", status, text));
        }

        let mut stream = res.bytes_stream();
        let mut buf = String::new();
        let mut full = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| anyhow!("Stream error: {}", e))?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim().to_string();
                buf.drain(..=pos);
                if line.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(t) = v["message"]["content"].as_str() {
                        if !t.is_empty() {
                            full.push_str(t);
                            on_chunk(t);
                        }
                    }
                }
            }
        }
        if full.is_empty() {
            return Err(anyhow!("Stream ended without content"));
        }
        Ok(full)
    }

    /// Call the configured model with a text prompt, and optionally an image
    pub async fn invoke(&self, config: &ModelConfig, prompt: &str) -> Result<String> {
        self.invoke_inner(config, prompt, None, None).await
    }

    /// Call with an attached image (base64 encoded, no data: prefix)
    pub async fn invoke_with_image(
        &self,
        config: &ModelConfig,
        prompt: &str,
        image_base64: &str,
        image_mime_type: &str,
    ) -> Result<String> {
        self.invoke_inner(config, prompt, Some(image_base64), Some(image_mime_type))
            .await
    }

    async fn invoke_inner(
        &self,
        config: &ModelConfig,
        prompt: &str,
        image_base64: Option<&str>,
        image_mime_type: Option<&str>,
    ) -> Result<String> {
        // Build user content — multimodal if image present
        let user_content: MessageContent =
            if let (Some(b64), Some(mime)) = (image_base64, image_mime_type) {
                // Only cloud providers support vision; Ollama gets text-only
                if config.provider == "ollama" {
                    MessageContent::Text(format!(
                    "{}\n\n[Note: An image was attached but this model does not support vision.]",
                    prompt
                ))
                } else {
                    MessageContent::Parts(vec![
                        ContentPart {
                            part_type: "text".into(),
                            text: Some(prompt.into()),
                            image_url: None,
                        },
                        ContentPart {
                            part_type: "image_url".into(),
                            text: None,
                            image_url: Some(ImageUrl {
                                url: format!("data:{};base64,{}", mime, b64),
                            }),
                        },
                    ])
                }
            } else {
                MessageContent::Text(prompt.into())
            };

        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: MessageContent::Text(SYSTEM_PROMPT.into()),
            },
            ChatMessage {
                role: "user".into(),
                content: user_content,
            },
        ];

        match config.provider.as_str() {
            "ollama" => self.invoke_ollama(config, messages).await,
            "anthropic" => self.invoke_anthropic(config, messages).await,
            "google" => {
                self.invoke_openai_compat(
                    config,
                    messages,
                    "https://generativelanguage.googleapis.com/v1beta/openai",
                )
                .await
            }
            "openai" => {
                self.invoke_openai_compat(config, messages, "https://api.openai.com/v1")
                    .await
            }
            "groq" => {
                self.invoke_openai_compat(config, messages, "https://api.groq.com/openai/v1")
                    .await
            }
            "openrouter" => {
                self.invoke_openai_compat(config, messages, "https://openrouter.ai/api/v1")
                    .await
            }
            _ => {
                let base = config
                    .base_url
                    .as_deref()
                    .ok_or_else(|| anyhow!("Custom provider requires a base_url"))?;
                self.invoke_openai_compat(config, messages, base).await
            }
        }
    }

    /// OpenAI-compatible /v1/chat/completions call
    async fn invoke_openai_compat(
        &self,
        config: &ModelConfig,
        messages: Vec<ChatMessage>,
        base_url: &str,
    ) -> Result<String> {
        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let body = ChatRequest {
            model: config.model_name.clone(),
            messages,
            stream: false,
            max_tokens: Some(4096),
            options: None,
        };

        let mut req = self.http.post(&endpoint).json(&body);

        if let Some(key) = &config.api_key {
            req = req.header("Authorization", format!("Bearer {}", key));
        }

        let res = req.send().await?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(anyhow!("API error {}: {}", status, body));
        }

        let chat: ChatResponse = res
            .json()
            .await
            .map_err(|e| anyhow!("Failed to parse API response: {}", e))?;

        Ok(chat
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .unwrap_or_default())
    }

    /// Anthropic Messages API — native /v1/messages with vision support
    async fn invoke_anthropic(
        &self,
        config: &ModelConfig,
        messages: Vec<ChatMessage>,
    ) -> Result<String> {
        let endpoint = "https://api.anthropic.com/v1/messages";

        let system_text: Option<String> = messages
            .iter()
            .find(|m| m.role == "system")
            .map(|m| match &m.content {
                MessageContent::Text(t) => t.clone(),
                MessageContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|p| p.text.as_ref())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n"),
            });

        let api_messages: Vec<AnthropicMessage> = messages
            .into_iter()
            .filter(|m| m.role != "system")
            .map(|m| {
                let content = match m.content {
                    MessageContent::Text(t) => AnthropicMessageContent::Text(t),
                    MessageContent::Parts(parts) => {
                        let converted: Vec<AnthropicContentPart> = parts
                            .into_iter()
                            .map(|p| {
                                if p.part_type == "image_url" {
                                    if let Some(img) = p.image_url {
                                        let segments: Vec<&str> =
                                            img.url.splitn(2, ',').collect();
                                        let meta = segments.first().copied().unwrap_or("");
                                        let data =
                                            segments.get(1).copied().unwrap_or("").to_string();
                                        let media_type = meta
                                            .strip_prefix("data:")
                                            .and_then(|s| s.strip_suffix(";base64"))
                                            .unwrap_or("image/png")
                                            .to_string();
                                        AnthropicContentPart::Image {
                                            source: AnthropicImageSource {
                                                source_type: "base64".into(),
                                                media_type,
                                                data,
                                            },
                                        }
                                    } else {
                                        AnthropicContentPart::Text {
                                            text: "[image]".into(),
                                        }
                                    }
                                } else {
                                    AnthropicContentPart::Text {
                                        text: p.text.unwrap_or_default(),
                                    }
                                }
                            })
                            .collect();
                        AnthropicMessageContent::Parts(converted)
                    }
                };
                AnthropicMessage {
                    role: m.role,
                    content,
                }
            })
            .collect();

        let body = AnthropicRequest {
            model: config.model_name.clone(),
            max_tokens: 4096,
            system: system_text,
            messages: api_messages,
            stream: None,
        };

        let key = config
            .api_key
            .as_deref()
            .ok_or_else(|| anyhow!("Anthropic requires an API key"))?;

        let res = self
            .http
            .post(endpoint)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !res.status().is_success() {
            let status = res.status();
            let body_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Anthropic API error {}: {}", status, body_text));
        }

        let resp: AnthropicResponse = res
            .json()
            .await
            .map_err(|e| anyhow!("Failed to parse Anthropic response: {}", e))?;

        Ok(resp
            .content
            .into_iter()
            .filter_map(|b| if b.block_type == "text" { b.text } else { None })
            .collect::<Vec<_>>()
            .join(""))
    }

    /// Ollama-specific: tries /v1/chat/completions first (Ollama >= 0.1.24),
    /// falls back to native /api/chat for older versions
    async fn invoke_ollama(
        &self,
        config: &ModelConfig,
        messages: Vec<ChatMessage>,
    ) -> Result<String> {
        let base = config
            .base_url
            .as_deref()
            .unwrap_or("http://localhost:11434");

        // Try OpenAI-compatible endpoint first (modern Ollama)
        let openai_url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
        let body = ChatRequest {
            model: config.model_name.clone(),
            messages: messages.clone(),
            stream: false,
            max_tokens: None, // Ollama ignores max_tokens
            options: Some(OllamaOptions { num_ctx: 8192 }),
        };

        let res = self.http.post(&openai_url).json(&body).send().await;

        match res {
            Ok(r) if r.status().is_success() => {
                let chat: ChatResponse = r
                    .json()
                    .await
                    .map_err(|e| anyhow!("Ollama response parse error: {}", e))?;
                return Ok(chat
                    .choices
                    .into_iter()
                    .next()
                    .map(|c| c.message.content)
                    .unwrap_or_default());
            }
            // 404 = old Ollama, fall through to native API
            Ok(r) if r.status().as_u16() == 404 => {}
            Ok(r) => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                return Err(anyhow!("Ollama error {}: {}", status, body));
            }
            // Connection refused = Ollama not running
            Err(e) if e.is_connect() => {
                return Err(anyhow!(
                    "Ollama is not running. Start it with: ollama serve\nThen pull a model: ollama pull {}",
                    config.model_name
                ));
            }
            Err(e) => return Err(anyhow!("Ollama request failed: {}", e)),
        }

        // Fallback: native Ollama /api/chat (pre-0.1.24)
        let native_url = format!("{}/api/chat", base.trim_end_matches('/'));
        let native_body = OllamaChatRequest {
            model: config.model_name.clone(),
            messages,
            stream: false,
            options: Some(OllamaOptions { num_ctx: 8192 }),
        };

        let res = self
            .http
            .post(&native_url)
            .json(&native_body)
            .send()
            .await
            .map_err(|e| anyhow!("Ollama native API request failed: {}", e))?;

        if !res.status().is_success() {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Ollama /api/chat error {}: {}\nMake sure the model is pulled: ollama pull {}",
                status,
                text,
                config.model_name
            ));
        }

        let resp: OllamaChatResponse = res
            .json()
            .await
            .map_err(|e| anyhow!("Ollama native response parse error: {}", e))?;

        Ok(resp.message.content)
    }
}
