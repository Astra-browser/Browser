/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! OpenAI chat-completions provider plus the shared OpenAI-compatible
//! wire format (reused by DeepSeek, OpenRouter, and LM Studio).
//!
//! Request: `POST {endpoint}` with `{model, messages, tools?, stream?}`.
//! Reply: `choices[0].message = {content, tool_calls?}`, `usage =
//! {prompt_tokens, completion_tokens}`. Stream: SSE `data:` JSON chunks
//! with `choices[0].delta = {content, tool_calls?}` terminated by
//! `data: [DONE]`; `stream_options.include_usage` puts `usage` on the
//! final chunk.

use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, ChatRole, HttpRequest, HttpTransport,
    KeyStore, ModelProvider, ProviderChunk, ProviderError, ProviderKind, RetryPolicy, SseAssembler,
    SseEvent, ToolCall, ToolCallAssembler, Usage,
};
use std::fmt;
use std::time::Duration;

/// Default endpoint for the hosted OpenAI API.
pub const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";

/// Keychain account name for stored API keys.
pub const KEYCHAIN_ACCOUNT: &str = "default";

/// OpenAI provider (hosted chat-completions API).
pub struct OpenAiProvider {
    model_id: String,
    endpoint: String,
    api_key: Option<ApiKey>,
    retry: RetryPolicy,
}

impl OpenAiProvider {
    /// New provider with an explicit key.
    pub fn new(api_key: ApiKey, model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: OPENAI_ENDPOINT.to_owned(),
            api_key: Some(api_key),
            retry: RetryPolicy::default(),
        }
    }

    /// New provider against a custom endpoint (BYO gateway).
    pub fn with_endpoint(
        api_key: Option<ApiKey>,
        model: impl Into<String>,
        endpoint: impl Into<String>,
    ) -> Self {
        Self {
            model_id: model.into(),
            endpoint: endpoint.into(),
            api_key,
            retry: RetryPolicy::default(),
        }
    }

    /// Load the key from `store`, failing with `MissingKey` when absent.
    pub fn from_keystore(
        store: &dyn KeyStore,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let service = ProviderKind::OpenAI
            .keychain_service()
            .unwrap_or("astra/provider/openai");
        let key = store.get(service, KEYCHAIN_ACCOUNT)?;
        match key {
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

    fn auth_header(&self) -> Result<String, ProviderError> {
        match &self.api_key {
            Some(key) => Ok(format!("Bearer {}", key.expose())),
            None => Err(ProviderError::MissingKey {
                service: ProviderKind::OpenAI
                    .keychain_service()
                    .unwrap_or("astra/provider/openai")
                    .to_owned(),
            }),
        }
    }

    fn http_request(&self, req: &ChatRequest, stream: bool) -> Result<HttpRequest, ProviderError> {
        Ok(HttpRequest::post_json(
            self.endpoint.clone(),
            chat_request_body(&req.model, req, stream),
        )
        .header("Authorization", self.auth_header()?))
    }
}

impl fmt::Debug for OpenAiProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiProvider")
            .field("model_id", &self.model_id)
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "REDACTED"))
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for OpenAiProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAI
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
        parse_chat_response(&response.body)
    }

    fn complete_stream(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<ChatResponse, ProviderError> {
        stream_chat(transport, &self.http_request(req, true)?, on_chunk)
    }
}

/// Build a chat-completions body. `model_override` lets gateways pin the
/// model per request; pass `req.model` normally.
pub(crate) fn chat_request_body(model_override: &str, req: &ChatRequest, stream: bool) -> String {
    let model = if req.model.is_empty() {
        model_override
    } else {
        req.model.as_str()
    };
    let messages: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|message| {
            let role = match message.role {
                ChatRole::System => "system",
                ChatRole::User => "user",
                ChatRole::Assistant => "assistant",
                ChatRole::Tool => "tool",
            };
            serde_json::json!({"role": role, "content": message.content})
        })
        .collect();
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": req.max_tokens,
        "stream": stream,
    });
    if !req.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(
            req.tools
                .iter()
                .map(|tool| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    })
                })
                .collect(),
        );
    }
    if stream {
        body["stream_options"] = serde_json::json!({"include_usage": true});
    }
    body.to_string()
}

/// Parse one chat-completions (non-streaming) body.
pub(crate) fn parse_chat_response(body: &str) -> Result<ChatResponse, ProviderError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| ProviderError::Parse(err.to_string()))?;
    let message = value
        .pointer("/choices/0/message")
        .ok_or_else(|| ProviderError::Parse("missing choices[0].message".to_owned()))?;
    let text = message
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut tool_calls = Vec::new();
    if let Some(calls) = message
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
    {
        for call in calls {
            let function = call
                .get("function")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let name = function
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let raw_arguments = function
                .get("arguments")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let arguments = if raw_arguments.trim().is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_str(raw_arguments)
                    .unwrap_or_else(|_| serde_json::Value::String(raw_arguments.to_owned()))
            };
            tool_calls.push(ToolCall {
                id: call
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name,
                arguments,
            });
        }
    }
    Ok(ChatResponse {
        text,
        tool_calls,
        usage: parse_chat_usage(&value),
    })
}

pub(crate) fn parse_chat_usage(value: &serde_json::Value) -> Usage {
    let input = value
        .pointer("/usage/prompt_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let output = value
        .pointer("/usage/completion_tokens")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    Usage {
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: 0,
    }
}

/// Incremental OpenAI-SSE fold shared by every OpenAI-compatible backend.
#[derive(Debug, Default)]
pub(crate) struct ChatStreamState {
    text: String,
    tools: ToolCallAssembler,
    usage: Usage,
}

impl ChatStreamState {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Fold one event; returns true on the `[DONE]` terminator.
    pub(crate) fn feed(
        &mut self,
        event: &SseEvent,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<bool, ProviderError> {
        if event.is_done() {
            return Ok(true);
        }
        let payload = event.payload();
        if payload.trim().is_empty() {
            return Ok(false);
        }
        let value: serde_json::Value =
            serde_json::from_str(&payload).map_err(|err| ProviderError::Parse(err.to_string()))?;
        if let Some(usage_value) = value.get("usage") {
            self.usage = parse_chat_usage(&serde_json::json!({"usage": usage_value}));
        }
        let delta = match value.pointer("/choices/0/delta") {
            Some(delta) => delta,
            None => return Ok(false),
        };
        if let Some(content) = delta.get("content").and_then(serde_json::Value::as_str) {
            if !content.is_empty() {
                self.text.push_str(content);
                on_chunk(ProviderChunk::Text(content.to_owned()));
            }
        }
        if let Some(calls) = delta
            .get("tool_calls")
            .and_then(serde_json::Value::as_array)
        {
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as u32;
                let id = call.get("id").and_then(serde_json::Value::as_str);
                let function = call
                    .get("function")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let name = function.get("name").and_then(serde_json::Value::as_str);
                let arguments = function
                    .get("arguments")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                self.tools.push(index, id, name, arguments);
                on_chunk(ProviderChunk::ToolCallDelta {
                    index,
                    name: name.map(str::to_owned),
                    arguments_fragment: arguments.to_owned(),
                });
            }
        }
        Ok(false)
    }

    pub(crate) fn finish(self) -> Result<ChatResponse, ProviderError> {
        Ok(ChatResponse {
            text: self.text,
            tool_calls: self.tools.finish()?,
            usage: self.usage,
        })
    }
}

/// Stream one chat-completions request: POST with `stream: true`, fold
/// SSE events as they arrive, emit chunks, return the assembled reply.
pub(crate) fn stream_chat(
    transport: &dyn HttpTransport,
    req: &HttpRequest,
    on_chunk: &mut dyn FnMut(ProviderChunk),
) -> Result<ChatResponse, ProviderError> {
    let mut assembler = SseAssembler::new();
    let mut state = ChatStreamState::new();
    let mut finished = false;
    let mut feed_error: Option<ProviderError> = None;
    let response = transport.post_stream(req, &mut |bytes| {
        for event in assembler.push(bytes) {
            if finished || feed_error.is_some() {
                continue;
            }
            match state.feed(&event, on_chunk) {
                Ok(done) => finished = done,
                Err(err) => feed_error = Some(err),
            }
        }
    })?;
    response.error_for_status()?;
    if feed_error.is_none() {
        if let Some(last) = assembler.finish() {
            if !finished {
                if let Err(err) = state.feed(&last, on_chunk) {
                    feed_error = Some(err);
                }
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
