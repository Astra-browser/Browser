/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Anthropic messages provider.
//!
//! Request: `POST /v1/messages` with `{model, max_tokens, system?,
//! messages, tools?, stream?}` and headers `x-api-key`, `anthropic-version`.
//! Reply: `content[]` blocks (`text` / `tool_use`), `usage =
//! {input_tokens, output_tokens}`. Stream: SSE events `message_start`,
//! `content_block_start`, `content_block_delta` (`text_delta` /
//! `input_json_delta`), `message_delta`, `message_stop`.

use super::openai::KEYCHAIN_ACCOUNT;
use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, ChatRole, HttpRequest, HttpTransport,
    KeyStore, ModelProvider, ProviderChunk, ProviderError, ProviderKind, RetryPolicy, SseAssembler,
    SseEvent, ToolCall, Usage,
};
use std::fmt;
use std::time::Duration;

/// Anthropic API version header (pinned per API contract).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Default endpoint for the hosted Anthropic API.
pub const ANTHROPIC_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";

/// Anthropic provider (hosted messages API).
pub struct AnthropicProvider {
    model_id: String,
    endpoint: String,
    api_key: ApiKey,
    retry: RetryPolicy,
}

impl AnthropicProvider {
    /// New provider with an explicit key.
    pub fn new(api_key: ApiKey, model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: ANTHROPIC_ENDPOINT.to_owned(),
            api_key,
            retry: RetryPolicy::default(),
        }
    }

    /// Load the key from `store`, failing with `MissingKey` when absent.
    pub fn from_keystore(
        store: &dyn KeyStore,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let service = ProviderKind::Anthropic
            .keychain_service()
            .unwrap_or("astra/provider/anthropic");
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

    fn http_request(&self, req: &ChatRequest, stream: bool) -> Result<HttpRequest, ProviderError> {
        Ok(
            HttpRequest::post_json(self.endpoint.clone(), request_body(&req.model, req, stream))
                .header("x-api-key", self.api_key.expose())
                .header("anthropic-version", ANTHROPIC_VERSION),
        )
    }
}

impl fmt::Debug for AnthropicProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnthropicProvider")
            .field("model_id", &self.model_id)
            .field("endpoint", &self.endpoint)
            .field("api_key", &"REDACTED")
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for AnthropicProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
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
        let assembled = state.finish()?;
        on_chunk(ProviderChunk::Finished {
            usage: assembled.usage,
        });
        Ok(assembled)
    }
}

/// Build a messages body. System-role messages fold into the top-level
/// `system` parameter (Anthropic has no system role in `messages`).
pub(crate) fn request_body(model_override: &str, req: &ChatRequest, stream: bool) -> String {
    let model = if req.model.is_empty() {
        model_override
    } else {
        req.model.as_str()
    };
    let mut system = String::new();
    let mut messages = Vec::new();
    for message in &req.messages {
        match message.role {
            ChatRole::System => {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(&message.content);
            }
            ChatRole::User => {
                messages.push(serde_json::json!({"role": "user", "content": message.content}));
            }
            ChatRole::Assistant | ChatRole::Tool => {
                messages.push(serde_json::json!({"role": "assistant", "content": message.content}));
            }
        }
    }
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": req.max_tokens,
        "messages": messages,
        "stream": stream,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if !req.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(
            req.tools
                .iter()
                .map(|tool| {
                    serde_json::json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    })
                })
                .collect(),
        );
    }
    body.to_string()
}

/// Parse one messages (non-streaming) body.
pub(crate) fn parse_response(body: &str) -> Result<ChatResponse, ProviderError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| ProviderError::Parse(err.to_string()))?;
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = value.get("content").and_then(serde_json::Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(serde_json::Value::as_str) {
                Some("text") => {
                    if let Some(part) = block.get("text").and_then(serde_json::Value::as_str) {
                        text.push_str(part);
                    }
                }
                Some("tool_use") => {
                    tool_calls.push(ToolCall {
                        id: block
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        name: block
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        arguments: block
                            .get("input")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    });
                }
                _ => {}
            }
        }
    }
    Ok(ChatResponse {
        text,
        tool_calls,
        usage: Usage {
            input_tokens: value
                .pointer("/usage/input_tokens")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            output_tokens: value
                .pointer("/usage/output_tokens")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            cached_input_tokens: 0,
        },
    })
}

/// Incremental Anthropic-SSE fold.
#[derive(Debug, Default)]
struct StreamState {
    text: String,
    calls: Vec<ToolCall>,
    current_id: Option<String>,
    current_name: Option<String>,
    current_json: String,
    usage: Usage,
}

impl StreamState {
    fn new() -> Self {
        Self::default()
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
        let value: serde_json::Value =
            serde_json::from_str(&payload).map_err(|err| ProviderError::Parse(err.to_string()))?;
        match event.name.as_str() {
            "message_start" => {
                if let Some(input) = value
                    .pointer("/message/usage/input_tokens")
                    .and_then(serde_json::Value::as_u64)
                {
                    self.usage.input_tokens = input;
                }
            }
            "content_block_start" => {
                let block = value
                    .get("content_block")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                if block.get("type").and_then(serde_json::Value::as_str) == Some("tool_use") {
                    self.current_id = block
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned);
                    self.current_name = block
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned);
                    self.current_json.clear();
                }
            }
            "content_block_delta" => {
                let delta = value
                    .get("delta")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                match delta.get("type").and_then(serde_json::Value::as_str) {
                    Some("text_delta") => {
                        if let Some(part) = delta.get("text").and_then(serde_json::Value::as_str) {
                            self.text.push_str(part);
                            on_chunk(ProviderChunk::Text(part.to_owned()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(part) = delta
                            .get("partial_json")
                            .and_then(serde_json::Value::as_str)
                        {
                            self.current_json.push_str(part);
                            on_chunk(ProviderChunk::ToolCallDelta {
                                index: self.calls.len() as u32,
                                name: self.current_name.clone(),
                                arguments_fragment: part.to_owned(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(name) = self.current_name.take() {
                    let id = self
                        .current_id
                        .take()
                        .unwrap_or_else(|| format!("call-{}", self.calls.len()));
                    let raw = std::mem::take(&mut self.current_json);
                    let arguments = if raw.trim().is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::from_str(&raw)
                            .unwrap_or_else(|_| serde_json::Value::String(raw.clone()))
                    };
                    self.calls.push(ToolCall {
                        id,
                        name,
                        arguments,
                    });
                }
            }
            "message_delta" => {
                if let Some(output) = value
                    .pointer("/usage/output_tokens")
                    .and_then(serde_json::Value::as_u64)
                {
                    self.usage.output_tokens = output;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn finish(self) -> Result<ChatResponse, ProviderError> {
        Ok(ChatResponse {
            text: self.text,
            tool_calls: self.calls,
            usage: self.usage,
        })
    }
}
