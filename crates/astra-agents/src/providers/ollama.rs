/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Ollama provider: local chat at `http://localhost:11434/api/chat`.
//!
//! Local endpoints need no API key and never report usage off-device.
//! Non-streaming reply: `{message: {content, tool_calls?}}`.
//! Streaming reply: NDJSON — one JSON object per line, `{message:
//! {content}, done: false}` fragments ending with `{done: true}`.

use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, ChatRole, HttpRequest, HttpTransport,
    ModelProvider, ProviderChunk, ProviderError, ProviderKind, RetryPolicy, ToolCall, Usage,
};
use std::fmt;
use std::time::Duration;

/// Default local Ollama endpoint.
pub const OLLAMA_ENDPOINT: &str = "http://localhost:11434/api/chat";

/// Ollama provider (local, keyless).
pub struct OllamaProvider {
    model_id: String,
    endpoint: String,
    retry: RetryPolicy,
}

impl OllamaProvider {
    /// New provider for a local model (no key required, none sent).
    pub fn local(model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: OLLAMA_ENDPOINT.to_owned(),
            retry: RetryPolicy::default(),
        }
    }

    /// Point at a custom Ollama host (still local-only accounting).
    pub fn with_endpoint(model: impl Into<String>, endpoint: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: endpoint.into(),
            retry: RetryPolicy::default(),
        }
    }

    /// Override the retry policy.
    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    fn http_request(&self, req: &ChatRequest, stream: bool) -> HttpRequest {
        HttpRequest::post_json(self.endpoint.clone(), request_body(&req.model, req, stream))
    }
}

impl fmt::Debug for OllamaProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OllamaProvider")
            .field("model_id", &self.model_id)
            .field("endpoint", &self.endpoint)
            .field("api_key", &None::<ApiKey>)
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for OllamaProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Local
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn complete_request(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
    ) -> Result<ChatResponse, ProviderError> {
        let http = self.http_request(req, false);
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
        let http = self.http_request(req, true);
        let mut text = String::new();
        let mut calls: Vec<ToolCall> = Vec::new();
        let mut feed_error: Option<ProviderError> = None;
        let response = transport.post_stream(&http, &mut |bytes| {
            for line in bytes.lines() {
                if feed_error.is_some() {
                    continue;
                }
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match parse_ndjson_line(line) {
                    Ok((fragment, line_calls)) => {
                        if !fragment.is_empty() {
                            text.push_str(&fragment);
                            on_chunk(ProviderChunk::Text(fragment));
                        }
                        for call in line_calls {
                            on_chunk(ProviderChunk::ToolCallDelta {
                                index: calls.len() as u32,
                                name: Some(call.name.clone()),
                                arguments_fragment: call.arguments.to_string(),
                            });
                            calls.push(call);
                        }
                    }
                    Err(err) => feed_error = Some(err),
                }
            }
        })?;
        response.error_for_status()?;
        if let Some(err) = feed_error {
            return Err(err);
        }
        let assembled = ChatResponse {
            text,
            tool_calls: calls,
            usage: Usage::zero(),
        };
        on_chunk(ProviderChunk::Finished {
            usage: assembled.usage,
        });
        Ok(assembled)
    }
}

/// Build an Ollama `/api/chat` body.
pub(crate) fn request_body(model_override: &str, req: &ChatRequest, stream: bool) -> String {
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
    body.to_string()
}

/// Parse one non-streaming Ollama body.
pub(crate) fn parse_response(body: &str) -> Result<ChatResponse, ProviderError> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| ProviderError::Parse(err.to_string()))?;
    let message = value
        .get("message")
        .ok_or_else(|| ProviderError::Parse("missing message".to_owned()))?;
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
            tool_calls.push(ToolCall {
                // Ollama tool calls carry no stable id; synthesize one.
                id: format!("call-{}", tool_calls.len()),
                name: function
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                arguments: function
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            });
        }
    }
    Ok(ChatResponse {
        text,
        tool_calls,
        // Local models report no token counts; usage stays on-device zero.
        usage: Usage::zero(),
    })
}

/// Parse one NDJSON stream line into a content fragment plus whole tool calls.
fn parse_ndjson_line(line: &str) -> Result<(String, Vec<ToolCall>), ProviderError> {
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|err| ProviderError::Parse(err.to_string()))?;
    let message = value
        .get("message")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let fragment = message
        .get("content")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut calls = Vec::new();
    if let Some(raw) = message
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
    {
        for call in raw {
            let function = call
                .get("function")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            calls.push(ToolCall {
                id: format!("call-{}", calls.len()),
                name: function
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                arguments: function
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            });
        }
    }
    Ok((fragment, calls))
}
