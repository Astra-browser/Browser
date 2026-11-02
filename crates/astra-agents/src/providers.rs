/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Provider layer (P6-T02): model backends with streaming, tool-call
//! parsing, retries, and local-only usage accounting.
//!
//! A provider is one model backend: a hosted API (Anthropic, OpenAI,
//! Gemini, DeepSeek, OpenRouter) or a local endpoint (Ollama, LM Studio,
//! any OpenAI-compatible server). This module owns the shared interface —
//! [`ProviderKind`], chat shapes, the [`ModelProvider`] trait, the
//! [`KeyStore`] keychain seam, the [`HttpTransport`] seam, retry/backoff,
//! SSE assembly, and the local-only [`UsageLedger`] — while each backend's
//! wire format lives in its submodule (`src/providers/`).
//!
//! Trust rules (AGENTS_DESIGN.md §9): API keys live in the OS keychain via
//! [`OsKeychainStore`] (the [`KeyStore`] trait; [`MemoryKeyStore`] is for
//! tests only), never in logs, SQLite, evals, or step details. Every
//! provider config redacts its key in `Debug`. Local endpoints
//! (`ProviderKind::Local`) never send keys or usage off-device.

pub mod anthropic;
pub mod deepseek;
pub mod gemini;
pub mod lmstudio;
pub mod ollama;
pub mod openai;
pub mod openrouter;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, Read};
use std::time::Duration;
use thiserror::Error;

/// Which backend a provider talks to. `Local` covers Ollama, LM Studio,
/// and any OpenAI-compatible endpoint; `Custom` covers future backends
/// behind the same trait.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Anthropic,
    OpenAI,
    Gemini,
    DeepSeek,
    OpenRouter,
    Local,
    Custom(String),
}

impl ProviderKind {
    /// Short stable id used in config and accounting.
    pub fn id(&self) -> String {
        match self {
            Self::Anthropic => "anthropic".to_owned(),
            Self::OpenAI => "openai".to_owned(),
            Self::Gemini => "gemini".to_owned(),
            Self::DeepSeek => "deepseek".to_owned(),
            Self::OpenRouter => "openrouter".to_owned(),
            Self::Local => "local".to_owned(),
            Self::Custom(name) => format!("custom:{name}"),
        }
    }

    /// Local endpoints never leave the machine: no usage may be reported
    /// off-device, and no API key is required.
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }

    /// Advisory default model id (catalogue hint, not a pin).
    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-4-5",
            Self::OpenAI => "gpt-4o-mini",
            Self::Gemini => "gemini-2.0-flash",
            Self::DeepSeek => "deepseek-chat",
            Self::OpenRouter => "openrouter/auto",
            Self::Local => "llama3.1",
            Self::Custom(_) => "default",
        }
    }

    /// Default HTTPS/API endpoint (local kinds point at localhost).
    pub fn default_endpoint(&self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com/v1/messages",
            Self::OpenAI => "https://api.openai.com/v1/chat/completions",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Self::DeepSeek => "https://api.deepseek.com/chat/completions",
            Self::OpenRouter => "https://openrouter.ai/api/v1/chat/completions",
            Self::Local => "http://localhost:11434/api/chat",
            Self::Custom(_) => "",
        }
    }

    /// OS keychain service name for this backend's API key.
    /// Local kinds have none: they need no key.
    pub fn keychain_service(&self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("astra/provider/anthropic"),
            Self::OpenAI => Some("astra/provider/openai"),
            Self::Gemini => Some("astra/provider/gemini"),
            Self::DeepSeek => Some("astra/provider/deepseek"),
            Self::OpenRouter => Some("astra/provider/openrouter"),
            Self::Local | Self::Custom(_) => None,
        }
    }
}

/// One catalogue entry: which backend serves which model id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub provider: ProviderKind,
    pub model_id: String,
    pub supports_tools: bool,
}

/// Advisory model catalogue (BYO providers bring their own keys;
/// see INVENTORY agent-model-catalog). Ids are hints, not pins.
pub fn catalog() -> Vec<CatalogEntry> {
    vec![
        CatalogEntry {
            provider: ProviderKind::Anthropic,
            model_id: "claude-sonnet-4-5".to_owned(),
            supports_tools: true,
        },
        CatalogEntry {
            provider: ProviderKind::OpenAI,
            model_id: "gpt-4o-mini".to_owned(),
            supports_tools: true,
        },
        CatalogEntry {
            provider: ProviderKind::Gemini,
            model_id: "gemini-2.0-flash".to_owned(),
            supports_tools: true,
        },
        CatalogEntry {
            provider: ProviderKind::DeepSeek,
            model_id: "deepseek-chat".to_owned(),
            supports_tools: true,
        },
        CatalogEntry {
            provider: ProviderKind::OpenRouter,
            model_id: "openrouter/auto".to_owned(),
            supports_tools: true,
        },
        CatalogEntry {
            provider: ProviderKind::Local,
            model_id: "llama3.1".to_owned(),
            supports_tools: true,
        },
    ]
}

/// Token usage for one call, accounted locally only (the ledger stays
/// on-device; providers never receive another call's usage).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
}

impl Usage {
    /// Zero usage.
    pub fn zero() -> Self {
        Self::default()
    }

    /// Whether nothing was accounted.
    pub fn is_zero(&self) -> bool {
        self.input_tokens == 0 && self.output_tokens == 0 && self.cached_input_tokens == 0
    }

    /// Add one call's usage, saturating instead of wrapping.
    pub fn add(&mut self, other: Usage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
    }

    /// Total billable-adjacent tokens (input + output).
    pub fn total(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

/// Local-only usage ledger: per-provider totals kept on-device.
/// Nothing here is ever sent to any endpoint.
#[derive(Clone, Debug, Default)]
pub struct UsageLedger {
    totals: HashMap<String, Usage>,
}

impl UsageLedger {
    /// Empty ledger.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one call's usage under the provider id.
    pub fn record(&mut self, provider_id: &str, usage: Usage) {
        self.totals
            .entry(provider_id.to_owned())
            .or_default()
            .add(usage);
    }

    /// Total for one provider id, if any.
    pub fn get(&self, provider_id: &str) -> Option<Usage> {
        self.totals.get(provider_id).copied()
    }

    /// Sum over all providers.
    pub fn total(&self) -> Usage {
        let mut sum = Usage::zero();
        for usage in self.totals.values() {
            sum.add(*usage);
        }
        sum
    }
}

/// One chat message in a provider request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

impl ChatMessage {
    /// A user message.
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
        }
    }

    /// A system prompt.
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
            content: content.into(),
        }
    }
}

/// Message role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

/// One tool a request offers the model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments object.
    pub parameters: serde_json::Value,
}

impl ToolDefinition {
    /// New tool definition.
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            parameters,
        }
    }
}

/// One tool call the model requested.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// A provider request: model, messages, optional tools.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: u32,
}

impl ChatRequest {
    /// Single user turn, no tools.
    pub fn user(prompt: &str, model: &str) -> Self {
        Self {
            model: model.to_owned(),
            messages: vec![ChatMessage::user(prompt)],
            tools: Vec::new(),
            max_tokens: 1024,
        }
    }
}

/// A provider reply: assembled text, tool calls, usage.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub usage: Usage,
}

/// One streamed chunk of a model reply.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderChunk {
    Text(String),
    ToolCallDelta {
        index: u32,
        name: Option<String>,
        arguments_fragment: String,
    },
    Finished {
        usage: Usage,
    },
}

/// Transport errors and provider failures. API keys are never included
/// in any message (see the `Debug`-redaction tests).
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ProviderError {
    #[error("provider transport error: {0}")]
    Transport(String),
    #[error("provider API error (status {status}): {message}")]
    Api { status: u16, message: String },
    #[error("provider authentication failed; check the keychain entry")]
    Auth,
    #[error("provider rate limited")]
    RateLimited,
    #[error("provider response parse error: {0}")]
    Parse(String),
    #[error("missing API key for keychain service {service}")]
    MissingKey { service: String },
    #[error("keychain error: {0}")]
    Keychain(String),
}

impl ProviderError {
    /// Whether a failed request is worth retrying (transport faults,
    /// 429, and 5xx; never 4xx like auth or bad-request).
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) | Self::RateLimited => true,
            Self::Api { status, .. } => *status == 429 || *status >= 500,
            Self::Auth | Self::Parse(_) | Self::MissingKey { .. } | Self::Keychain(_) => false,
        }
    }
}

/// Retry policy: bounded attempts with exponential backoff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 200,
            max_delay_ms: 5_000,
        }
    }
}

impl RetryPolicy {
    /// Delay before retry number `attempt` (1-based): base * 2^(n-1),
    /// capped at `max_delay_ms`, saturating instead of overflowing.
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(16);
        let delay = self
            .base_delay_ms
            .saturating_mul(1 << shift)
            .min(self.max_delay_ms);
        Duration::from_millis(delay)
    }
}

/// Run `send` until it succeeds, fails non-retryably, or exhausts
/// `policy.max_retries` retries. `sleep` is a parameter (live code passes
/// `std::thread::sleep`) so tests assert backoff without waiting.
pub fn send_with_retry<T, E>(
    policy: RetryPolicy,
    sleep: &mut dyn FnMut(Duration),
    mut send: impl FnMut() -> Result<T, E>,
) -> Result<T, E>
where
    E: IsRetryable,
{
    let mut attempt: u32 = 0;
    loop {
        match send() {
            Ok(value) => return Ok(value),
            Err(err) => {
                if !err.is_retryable() || attempt >= policy.max_retries {
                    return Err(err);
                }
                attempt += 1;
                sleep(policy.delay_for_attempt(attempt));
            }
        }
    }
}

/// Anything [`send_with_retry`] may retry.
pub trait IsRetryable {
    /// Whether this failure is worth retrying.
    fn is_retryable(&self) -> bool;
}

impl IsRetryable for ProviderError {
    fn is_retryable(&self) -> bool {
        ProviderError::is_retryable(self)
    }
}

/// An API key handle. The secret is held in memory only for the call and
/// is never shown in `Debug`, `Display`, logs, or error messages.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Wrap a secret read from the keychain.
    pub fn new(secret: impl Into<String>) -> Self {
        Self(secret.into())
    }

    /// Borrow the secret to build exactly one request's auth header.
    /// Callers must not persist, log, or return it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(REDACTED)")
    }
}

/// Key storage seam. Production uses [`OsKeychainStore`] (OS keychain
/// only); tests use [`MemoryKeyStore`]. Keys never touch SQLite, logs,
/// evals, or step details.
pub trait KeyStore {
    /// Read the secret for (`service`, `account`), if stored.
    fn get(&self, service: &str, account: &str) -> Result<Option<ApiKey>, ProviderError>;
    /// Store (or replace) the secret.
    fn set(&self, service: &str, account: &str, key: &ApiKey) -> Result<(), ProviderError>;
    /// Delete the secret; missing entries are not an error.
    fn delete(&self, service: &str, account: &str) -> Result<(), ProviderError>;
}

/// In-memory key store for tests. Never use with real keys outside tests.
#[derive(Debug, Default)]
pub struct MemoryKeyStore {
    entries: std::sync::Mutex<HashMap<(String, String), String>>,
}

impl MemoryKeyStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryKeyStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<ApiKey>, ProviderError> {
        let entries = self
            .entries
            .lock()
            .map_err(|e| ProviderError::Keychain(e.to_string()))?;
        Ok(entries
            .get(&(service.to_owned(), account.to_owned()))
            .map(|secret| ApiKey::new(secret.clone())))
    }

    fn set(&self, service: &str, account: &str, key: &ApiKey) -> Result<(), ProviderError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|e| ProviderError::Keychain(e.to_string()))?;
        entries.insert(
            (service.to_owned(), account.to_owned()),
            key.expose().to_owned(),
        );
        Ok(())
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), ProviderError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|e| ProviderError::Keychain(e.to_string()))?;
        entries.remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

/// OS-keychain key store: secrets live in the platform credential store
/// (macOS Keychain, Windows Credential Manager, Linux Secret Service via
/// the `keyring` crate), never in files, SQLite, or process output.
#[derive(Clone, Debug, Default)]
pub struct OsKeychainStore;

impl OsKeychainStore {
    /// New handle (stateless; the OS owns the data).
    pub fn new() -> Self {
        Self
    }
}

fn keyring_error(err: keyring::Error) -> ProviderError {
    ProviderError::Keychain(err.to_string())
}

impl KeyStore for OsKeychainStore {
    fn get(&self, service: &str, account: &str) -> Result<Option<ApiKey>, ProviderError> {
        let entry = keyring::Entry::new(service, account).map_err(keyring_error)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(ApiKey::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(keyring_error(err)),
        }
    }

    fn set(&self, service: &str, account: &str, key: &ApiKey) -> Result<(), ProviderError> {
        let entry = keyring::Entry::new(service, account).map_err(keyring_error)?;
        entry.set_password(key.expose()).map_err(keyring_error)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), ProviderError> {
        let entry = keyring::Entry::new(service, account).map_err(keyring_error)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(keyring_error(err)),
        }
    }
}

/// One HTTP request to a provider endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpRequest {
    /// New POST with a JSON body.
    pub fn post_json(url: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
            body: body.into(),
        }
    }

    /// Add a header.
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Read one header value (first match, case-insensitive name).
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// One HTTP response from a provider endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpResponse {
    /// Successful response with a body.
    pub fn ok(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    /// Read one response header value (first match, case-insensitive).
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// Lift non-2xx statuses into typed errors. 401/403 become `Auth`
    /// (wrong key, never retried); 429 becomes `RateLimited`; other
    /// failures carry status + a truncated body (never a key — keys only
    /// travel in request headers, never in bodies).
    pub fn error_for_status(&self) -> Result<(), ProviderError> {
        if (200..300).contains(&self.status) {
            return Ok(());
        }
        match self.status {
            401 | 403 => Err(ProviderError::Auth),
            429 => Err(ProviderError::RateLimited),
            status => Err(ProviderError::Api {
                status,
                message: truncate(&self.body, 500),
            }),
        }
    }
}

/// Truncate a string to `max` chars (ASCII-safe boundary).
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// HTTP seam: live code uses [`UreqTransport`]; tests inject recorded
/// responses. Keeps provider logic network-free and deterministic.
pub trait HttpTransport {
    /// POST `req` and return the full response.
    fn post(&self, req: &HttpRequest) -> Result<HttpResponse, ProviderError>;

    /// POST `req` and feed the response body to `on_bytes` as it arrives.
    /// The default implementation replays one full body (correct, just not
    /// incremental); [`UreqTransport`] streams from the socket.
    fn post_stream(
        &self,
        req: &HttpRequest,
        on_bytes: &mut dyn FnMut(&str),
    ) -> Result<HttpResponse, ProviderError> {
        let response = self.post(req)?;
        on_bytes(&response.body);
        Ok(response)
    }
}

/// Live transport over blocking HTTPS (the `ureq` crate).
#[derive(Clone, Debug, Default)]
pub struct UreqTransport;

impl UreqTransport {
    /// New live transport.
    pub fn new() -> Self {
        Self
    }
}

impl HttpTransport for UreqTransport {
    fn post(&self, req: &HttpRequest) -> Result<HttpResponse, ProviderError> {
        let mut out = String::new();
        self.post_stream(req, &mut |bytes| out.push_str(bytes))?;
        Ok(HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: out,
        })
    }

    fn post_stream(
        &self,
        req: &HttpRequest,
        on_bytes: &mut dyn FnMut(&str),
    ) -> Result<HttpResponse, ProviderError> {
        // Non-2xx responses must come back as `Response` (not `Err`) so
        // `HttpResponse::error_for_status` can map 401/403/429 precisely.
        let config = ureq::config::Config::builder()
            .http_status_as_error(false)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut call = agent.post(req.url.as_str());
        for (name, value) in &req.headers {
            call = call.header(name, value);
        }
        let mut response = call
            .send(req.body.as_str())
            .map_err(|err| ProviderError::Transport(err.to_string()))?;
        let status = response.status().as_u16();
        let mut headers = Vec::new();
        for (name, value) in response.headers() {
            headers.push((name.to_string(), value.to_str().unwrap_or("").to_owned()));
        }
        let mut body = String::new();
        response
            .body_mut()
            .as_reader()
            .read_to_string(&mut body)
            .map_err(|err| ProviderError::Transport(err.to_string()))?;
        on_bytes(&body);
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

/// One Server-Sent Events event: `event:` name plus `data:` lines.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseEvent {
    pub name: String,
    pub data: Vec<String>,
}

impl SseEvent {
    /// Joined `data:` payload.
    pub fn payload(&self) -> String {
        self.data.join("\n")
    }

    /// Whether this is the stream terminator (`data: [DONE]`).
    pub fn is_done(&self) -> bool {
        self.data.iter().any(|line| line.trim() == "[DONE]")
    }
}

/// Incremental SSE assembler: feed arbitrary body pieces, receive whole
/// events. Handles `\n\n` (and `\r\n\r\n`) framing plus comment lines.
#[derive(Clone, Debug, Default)]
pub struct SseAssembler {
    buffer: String,
}

impl SseAssembler {
    /// Empty assembler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one body piece; returns the newly completed events.
    pub fn push(&mut self, piece: &str) -> Vec<SseEvent> {
        self.buffer.push_str(piece);
        let mut events = Vec::new();
        while let Some(end) = find_event_end(&self.buffer) {
            let raw: String = self.buffer.drain(..end).collect();
            // Drain the blank separator line(s) the framing left behind.
            if self.buffer.starts_with('\n') || self.buffer.starts_with('\r') {
                let next = self
                    .buffer
                    .find(|c| c != '\n' && c != '\r')
                    .unwrap_or(self.buffer.len());
                self.buffer.drain(..next);
            }
            if let Some(event) = parse_sse_block(&raw) {
                events.push(event);
            }
        }
        events
    }

    /// Flush any trailing buffered block (a body without a final blank line).
    pub fn finish(&mut self) -> Option<SseEvent> {
        if self.buffer.trim().is_empty() {
            return None;
        }
        let raw = std::mem::take(&mut self.buffer);
        parse_sse_block(&raw)
    }
}

fn find_event_end(buffer: &str) -> Option<usize> {
    let bytes = buffer.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\n' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b'\n' || bytes[j] == b'\r') {
                j += 1;
            }
            if j > i + 1 {
                return Some(j);
            }
            // A single newline only ends an event when the next line starts
            // a new event or the stream ends; SSE needs the blank line, so
            // keep scanning line by line instead.
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

fn parse_sse_block(raw: &str) -> Option<SseEvent> {
    let mut event = SseEvent::default();
    let mut seen = false;
    for line in raw.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if line.starts_with(':') {
            continue; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field.trim(), value.strip_prefix(' ').unwrap_or(value)),
            None => continue,
        };
        seen = true;
        match field {
            "event" => event.name = value.to_owned(),
            "data" => event.data.push(value.to_owned()),
            _ => {}
        }
    }
    if seen {
        Some(event)
    } else {
        None
    }
}

/// Parse a complete SSE body into events (convenience over [`SseAssembler`]).
pub fn parse_sse_text(body: &str) -> Vec<SseEvent> {
    let mut assembler = SseAssembler::new();
    let mut events = assembler.push(body);
    if let Some(last) = assembler.finish() {
        events.push(last);
    }
    events
}

/// Feed a `BufRead` body (live socket or fixture bytes) to `on_event` as
/// whole SSE events arrive — the incremental streaming path.
pub fn stream_sse_reader<R: BufRead>(
    reader: R,
    on_event: &mut dyn FnMut(SseEvent),
) -> Result<(), ProviderError> {
    let mut assembler = SseAssembler::new();
    for line in reader.lines() {
        let line = line.map_err(|err| ProviderError::Transport(err.to_string()))?;
        let piece = format!("{line}\n");
        for event in assembler.push(&piece) {
            on_event(event);
        }
    }
    // Flush a trailing block when the body lacks a final blank line.
    if let Some(last) = assembler.finish() {
        on_event(last);
    }
    Ok(())
}

/// Assemble streamed OpenAI-style `tool_calls` deltas (`index` + partial
/// `name`/`arguments`) into whole [`ToolCall`]s.
#[derive(Clone, Debug, Default)]
pub struct ToolCallAssembler {
    ids: HashMap<u32, String>,
    names: HashMap<u32, String>,
    arguments: HashMap<u32, String>,
}

impl ToolCallAssembler {
    /// Empty assembler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one delta in.
    pub fn push(&mut self, index: u32, id: Option<&str>, name: Option<&str>, arguments: &str) {
        if let Some(id) = id {
            if !id.is_empty() {
                self.ids.insert(index, id.to_owned());
            }
        }
        if let Some(name) = name {
            if !name.is_empty() {
                self.names
                    .entry(index)
                    .and_modify(|current| {
                        if current.is_empty() {
                            *current = name.to_owned();
                        }
                    })
                    .or_insert_with(|| name.to_owned());
            }
        }
        self.arguments.entry(index).or_default().push_str(arguments);
    }

    /// Whether any delta arrived.
    pub fn is_empty(&self) -> bool {
        self.arguments.is_empty() && self.names.is_empty()
    }

    /// Finish: parse each accumulated arguments string as JSON
    /// (falling back to a JSON string literal when the model emitted a
    /// fragment that never formed an object).
    pub fn finish(&self) -> Result<Vec<ToolCall>, ProviderError> {
        let mut indexes: Vec<u32> = self
            .arguments
            .keys()
            .chain(self.names.keys())
            .copied()
            .collect();
        indexes.sort_unstable();
        indexes.dedup();
        let mut calls = Vec::with_capacity(indexes.len());
        for index in indexes {
            let raw = self.arguments.get(&index).cloned().unwrap_or_default();
            let arguments = if raw.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(&raw)
                    .unwrap_or_else(|_| serde_json::Value::String(raw.clone()))
            };
            calls.push(ToolCall {
                id: self
                    .ids
                    .get(&index)
                    .cloned()
                    .unwrap_or_else(|| format!("call-{index}")),
                name: self.names.get(&index).cloned().unwrap_or_default(),
                arguments,
            });
        }
        Ok(calls)
    }
}

/// Provider interface. Implementors stream one reply for a request;
/// [`complete`] covers the loop's simple case, [`complete_stream`]
/// drives chunk callbacks for the canvas (P6-T06).
///
/// [`complete`]: ModelProvider::complete
/// [`complete_stream`]: ModelProvider::complete_stream
pub trait ModelProvider {
    /// Backend this provider talks to.
    fn kind(&self) -> ProviderKind;

    /// Model id to request (catalogue hints in [`catalog`]).
    fn model_id(&self) -> &str;

    /// Send one request over `transport` (tests inject recorded bodies).
    fn complete_request(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
    ) -> Result<ChatResponse, ProviderError>;

    /// Stream one request over `transport`, calling `on_chunk` per
    /// [`ProviderChunk`]. The default implementation synthesizes
    /// text + finished chunks from the full response; backends with
    /// true event streams override it.
    fn complete_stream(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<ChatResponse, ProviderError> {
        let response = self.complete_request(req, transport)?;
        if !response.text.is_empty() {
            on_chunk(ProviderChunk::Text(response.text.clone()));
        }
        for call in &response.tool_calls {
            on_chunk(ProviderChunk::ToolCallDelta {
                index: 0,
                name: Some(call.name.clone()),
                arguments_fragment: call.arguments.to_string(),
            });
        }
        on_chunk(ProviderChunk::Finished {
            usage: response.usage,
        });
        Ok(response)
    }

    /// Stream one reply for `prompt` over the live transport.
    fn complete(&self, prompt: &str) -> Result<(String, Usage), ProviderError> {
        let transport = UreqTransport::new();
        let req = ChatRequest::user(prompt, self.model_id());
        let response = self.complete_request(&req, &transport)?;
        Ok((response.text, response.usage))
    }
}

/// In-memory fake provider for loop tests: echoes the prompt.
#[derive(Clone, Debug)]
pub struct EchoProvider {
    kind: ProviderKind,
    model_id: String,
}

impl EchoProvider {
    /// New fake provider.
    pub fn new(kind: ProviderKind, model_id: impl Into<String>) -> Self {
        Self {
            kind,
            model_id: model_id.into(),
        }
    }
}

impl ModelProvider for EchoProvider {
    fn kind(&self) -> ProviderKind {
        self.kind.clone()
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn complete_request(
        &self,
        req: &ChatRequest,
        _transport: &dyn HttpTransport,
    ) -> Result<ChatResponse, ProviderError> {
        let text = req
            .messages
            .last()
            .map(|message| format!("echo: {}", message.content))
            .unwrap_or_default();
        Ok(ChatResponse {
            text,
            tool_calls: Vec::new(),
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
            },
        })
    }
}

/// POST `req` with retries (transport faults, 429, 5xx) and lift
/// non-2xx statuses into [`ProviderError`]. `sleep` is injected so
/// tests assert backoff without waiting.
pub fn post_with_retry(
    transport: &dyn HttpTransport,
    req: &HttpRequest,
    policy: RetryPolicy,
    sleep: &mut dyn FnMut(Duration),
) -> Result<HttpResponse, ProviderError> {
    send_with_retry(policy, sleep, || {
        let response = transport.post(req)?;
        response.error_for_status().map(|()| response)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_kind_ids_are_stable() {
        assert_eq!(ProviderKind::Anthropic.id(), "anthropic");
        assert_eq!(ProviderKind::Local.id(), "local");
        assert_eq!(ProviderKind::Custom("x".to_owned()).id(), "custom:x");
        assert!(ProviderKind::Local.is_local());
        assert!(!ProviderKind::OpenAI.is_local());
    }

    #[test]
    fn usage_add_saturates_and_totals() {
        let mut usage = Usage::zero();
        usage.add(Usage {
            input_tokens: 10,
            output_tokens: 5,
            cached_input_tokens: 2,
        });
        assert_eq!(usage.total(), 15);
        usage.add(Usage {
            input_tokens: u64::MAX,
            output_tokens: 0,
            cached_input_tokens: 0,
        });
        assert_eq!(usage.input_tokens, u64::MAX);
    }

    #[test]
    fn echo_provider_completes() {
        let provider = EchoProvider::new(ProviderKind::Local, "test-model");
        assert_eq!(provider.kind(), ProviderKind::Local);
        assert_eq!(provider.model_id(), "test-model");
        let transport = crate::providers::recording::RecordingTransport::ok("{}");
        let (text, usage) = provider
            .complete_request(&ChatRequest::user("hi", "test-model"), &transport)
            .map(|response| (response.text, response.usage))
            .unwrap();
        assert_eq!(text, "echo: hi");
        assert_eq!(usage.total(), 2);
    }

    #[test]
    fn retry_policy_backs_off_exponentially() {
        let policy = RetryPolicy {
            max_retries: 4,
            base_delay_ms: 100,
            max_delay_ms: 1_000,
        };
        assert_eq!(policy.delay_for_attempt(1), Duration::from_millis(100));
        assert_eq!(policy.delay_for_attempt(2), Duration::from_millis(200));
        assert_eq!(policy.delay_for_attempt(3), Duration::from_millis(400));
        assert_eq!(policy.delay_for_attempt(4), Duration::from_millis(800));
        assert_eq!(policy.delay_for_attempt(40), Duration::from_millis(1_000));
    }

    #[test]
    fn sse_assembler_frames_events_across_pieces() {
        let mut assembler = SseAssembler::new();
        let mut events = assembler.push("event: message\ndata: {\"a\":");
        assert!(events.is_empty());
        events.extend(assembler.push("1}\n\n: keep-alive\n\ndata: [DONE]\n\n"));
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].payload(), "{\"a\":1}");
        assert!(events[1].is_done());
    }
}

/// Fixture-replay transport (no network): queue canned responses or
/// faults, record every request for header/body assertions. Backs the
/// recorded conformance suite in `tests/providers_conformance.rs`.
pub mod recording {
    use super::*;
    use std::cell::RefCell;

    /// Scripted responses plus the requests seen so far.
    #[derive(Debug, Default)]
    pub struct RecordingTransport {
        script: RefCell<Vec<Result<HttpResponse, ProviderError>>>,
        seen: RefCell<Vec<HttpRequest>>,
    }

    impl RecordingTransport {
        /// Respond 200 with `body` to every request.
        pub fn ok(body: impl Into<String>) -> Self {
            Self::scripted(vec![HttpResponse::ok(body)])
        }

        /// Serve responses in order (extra requests repeat the last).
        pub fn scripted(responses: Vec<HttpResponse>) -> Self {
            Self::scripted_results(responses.into_iter().map(Ok).collect())
        }

        /// Serve results in order: `Err` entries inject transport faults.
        /// Extra requests repeat the last entry.
        pub fn scripted_results(script: Vec<Result<HttpResponse, ProviderError>>) -> Self {
            Self {
                script: RefCell::new(script),
                seen: RefCell::new(Vec::new()),
            }
        }

        /// Requests received so far.
        pub fn requests(&self) -> Vec<HttpRequest> {
            self.seen.borrow().clone()
        }
    }

    impl HttpTransport for RecordingTransport {
        fn post(&self, req: &HttpRequest) -> Result<HttpResponse, ProviderError> {
            self.seen.borrow_mut().push(req.clone());
            let mut script = self.script.borrow_mut();
            if script.len() > 1 {
                script.remove(0)
            } else {
                script
                    .first()
                    .cloned()
                    .ok_or_else(|| ProviderError::Transport("empty script".to_owned()))?
            }
        }
    }
}
