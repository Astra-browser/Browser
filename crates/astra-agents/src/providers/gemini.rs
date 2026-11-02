/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Gemini provider (`generativelanguage.googleapis.com/v1beta`).
//!
//! Request: `POST /models/{model}:generateContent` with
//! `{systemInstruction?, contents[{role, parts[{text}|{functionCall}]}], tools?[{functionDeclarations}]}`.
//! The API key travels as the `?key=` query parameter (read once from the
//! OS keychain, never logged). Reply: `candidates[0].content.parts[]`
//! (`text` / `functionCall{name, args}`), `usageMetadata =
//! {promptTokenCount, candidatesTokenCount}`. Stream:
//! `:streamGenerateContent?alt=sse` emits one response JSON per SSE event.

use super::openai::KEYCHAIN_ACCOUNT;
use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, ChatRole, HttpRequest, HttpTransport,
    KeyStore, ModelProvider, ProviderChunk, ProviderError, ProviderKind, RetryPolicy, SseAssembler,
    SseEvent, ToolCall, Usage,
};
use std::fmt;
use std::time::Duration;

/// Host root for the hosted Gemini API.
pub const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Gemini provider (hosted `generateContent` API).
pub struct GeminiProvider {
    model_id: String,
    base_url: String,
    api_key: ApiKey,
    retry: RetryPolicy,
}

impl GeminiProvider {
    /// New provider with an explicit key.
    pub fn new(api_key: ApiKey, model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            base_url: GEMINI_BASE.to_owned(),
            api_key,
            retry: RetryPolicy::default(),
        }
    }

    /// Load the key from `store`, failing with `MissingKey` when absent.
    pub fn from_keystore(
        store: &dyn KeyStore,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let service = ProviderKind::Gemini
            .keychain_service()
            .unwrap_or("astra/provider/gemini");
        match store.get(service, KEYCHAIN_ACCOUNT)? {
            Some(api_key) => Ok(Self::new(api_key, model)),
            None => Err(ProviderError::MissingKey {
                service: service.to_owned(),
            }),
        }
    }

    /// Override the retry policy.
    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    fn url(&self, stream: bool) -> String {
        let verb = if stream {
            "streamGenerateContent?alt=sse"
        } else {
            "generateContent"
        };
        // The key travels in the query string (Gemini contract); it is
        // read straight from the keychain handle and never logged.
        format!(
            "{}/models/{}:{verb}?key={}",
            self.base_url.trim_end_matches('/'),
            self.model_id,
            self.api_key.expose()
        )
    }

    fn http_request(&self, req: &ChatRequest, stream: bool) -> Result<HttpRequest, ProviderError> {
        Ok(HttpRequest::post_json(self.url(stream), request_body(req)))
    }
}

impl fmt::Debug for GeminiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GeminiProvider")
            .field("model_id", &self.model_id)
            .field("base_url", &self.base_url)
            .field("api_key", &"REDACTED")
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for GeminiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Gemini
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn complete_request(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
    ) -> Result<ChatResponse, ProviderError> {
        let http = self.http_request(req, false)?;
        let response = post_with_retry(transport, &http, self.retry, &mut |delay: Duration| {
            std::thread::sleep(delay)
        })?;
        response.error_for_status()?;
        parse_response(&response.body)
    }

    fn complete_stream(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<ChatResponse, ProviderError> {
        let mut assembler = SseAssembler::new();
        let mut state = StreamState::new();
        let mut feed_error: Option<ProviderError> = None;
        let http = self.http_request(req, true)?;
        let response = transport.post_stream(&http, &mut |bytes| {
            for event in assembler.push(bytes) {
                if feed_error.is_some() {
                    continue;
                }
                if let Err(err) = state.feed(&event, on_chunk) {
                    feed_error = Some(err);
                }
            }
        })?;
        response.error_for_status()?;
        if feed_error.is_none() {
            if let Some(last) = assembler.finish() {
                if let Err(err) = state.feed(&last, on_chunk) {
                    feed_error = Some(err);
                }
            }
        }
        if let Some(err) = feed_error {
            return Err(err);
        }
        let assembled = state.finish();
        on_chunk(ProviderChunk::Finished {
            usage: assembled.usage,
        });
        Ok(assembled)
    }
}

/// Build a `generateContent` body. System messages fold into
/// `systemInstruction` (Gemini has no system role in `contents`).
pub(crate) fn request_body(req: &ChatRequest) -> String {
    let mut system = String::new();
    let mut contents = Vec::new();
    for message in &req.messages {
        match message.role {
            ChatRole::System => {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(&message.content);
            }
            ChatRole::User => {
                contents.push(
                    serde_json::json!({"role": "user", "parts": [{"text": message.content}]}),
                );
            }
            ChatRole::Assistant | ChatRole::Tool => {
                contents.push(
                    serde_json::json!({"role": "model", "parts": [{"text": message.content}]}),
                );
            }
        }
    }
    let mut body = serde_json::json!({ "contents": contents });
    if !system.is_empty() {
        body["systemInstruction"] = serde_json::json!({"parts": [{"text": system}]});
    }
    if !req.tools.is_empty() {
        body["tools"] = serde_json::json!([{
            "functionDeclarations": req.tools.iter().map(|tool| {
                serde_json::json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                })
            }).collect::<Vec<_>>(),
        }]);
    }
    body.to_string()
}

/// Parse one `generateContent` body.
pub(crate) fn parse_response(body: &str) -> Result<ChatResponse, ProviderError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| ProviderError::Parse(err.to_string()))?;
    let mut state = StreamState::new();
    state.fold_response(&value);
    Ok(state.finish())
}

fn parse_usage(value: &serde_json::Value) -> Usage {
    Usage {
        input_tokens: value
            .get("promptTokenCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("candidatesTokenCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        cached_input_tokens: value
            .get("cachedContentTokenCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    }
}

/// Incremental Gemini-SSE fold (one response JSON per event).
#[derive(Debug, Default)]
struct StreamState {
    text: String,
    calls: Vec<ToolCall>,
    usage: Usage,
}

impl StreamState {
    fn new() -> Self {
        Self::default()
    }

    fn fold_response(&mut self, value: &serde_json::Value) {
        if let Some(parts) = value
            .pointer("/candidates/0/content/parts")
            .and_then(serde_json::Value::as_array)
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(serde_json::Value::as_str) {
                    self.text.push_str(text);
                }
                if let Some(call) = part.get("functionCall") {
                    self.calls.push(ToolCall {
                        id: format!("call-{}", self.calls.len()),
                        name: call
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        arguments: call.get("args").cloned().unwrap_or(serde_json::Value::Null),
                    });
                }
            }
        }
        if let Some(meta) = value.get("usageMetadata") {
            let usage = parse_usage(meta);
            if !usage.is_zero() {
                self.usage = usage;
            }
        }
    }

    fn feed(
        &mut self,
        event: &SseEvent,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<(), ProviderError> {
        if event.is_done() {
            return Ok(());
        }
        let payload = event.payload();
        if payload.trim().is_empty() {
            return Ok(());
        }
        let before_text = self.text.len();
        let before_calls = self.calls.len();
        let value: serde_json::Value =
            serde_json::from_str(&payload).map_err(|err| ProviderError::Parse(err.to_string()))?;
        self.fold_response(&value);
        let new_text = self.text[before_text..].to_owned();
        if !new_text.is_empty() {
            on_chunk(ProviderChunk::Text(new_text));
        }
        for call in self.calls.iter().skip(before_calls) {
            on_chunk(ProviderChunk::ToolCallDelta {
                index: 0,
                name: Some(call.name.clone()),
                arguments_fragment: call.arguments.to_string(),
            });
        }
        Ok(())
    }

    fn finish(self) -> ChatResponse {
        ChatResponse {
            text: self.text,
            tool_calls: self.calls,
            usage: self.usage,
        }
    }
}
