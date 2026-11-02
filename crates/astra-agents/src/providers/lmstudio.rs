/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! LM Studio / generic OpenAI-compatible provider: chat completions at a
//! configurable local base URL (default
//! `http://localhost:1234/v1/chat/completions`), reusing the shared
//! parser in [`super::openai`].
//!
//! Local endpoints need no API key and never report usage off-device. An
//! explicit key may still be supplied for gateways that demand one; it is
//! redacted from `Debug` like every other provider key.

use super::openai::{chat_request_body, parse_chat_response, stream_chat};
use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, HttpRequest, HttpTransport, ModelProvider,
    ProviderChunk, ProviderError, ProviderKind, RetryPolicy,
};
use std::fmt;
use std::time::Duration;

/// Default local LM Studio endpoint (OpenAI-compatible).
pub const LMSTUDIO_ENDPOINT: &str = "http://localhost:1234/v1/chat/completions";

/// LM Studio / OpenAI-compatible provider (local by default).
pub struct LmStudioProvider {
    model_id: String,
    endpoint: String,
    api_key: Option<ApiKey>,
    retry: RetryPolicy,
}

impl LmStudioProvider {
    /// New provider for a local model (no key required, none sent).
    pub fn local(model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: LMSTUDIO_ENDPOINT.to_owned(),
            api_key: None,
            retry: RetryPolicy::default(),
        }
    }

    /// Point at any OpenAI-compatible endpoint, with an optional key for
    /// gateways that demand one.
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

    /// Override the retry policy.
    pub fn with_retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }

    fn http_request(&self, req: &ChatRequest, stream: bool) -> HttpRequest {
        let mut http = HttpRequest::post_json(
            self.endpoint.clone(),
            chat_request_body(&req.model, req, stream),
        );
        if let Some(key) = &self.api_key {
            http = http.header("Authorization", format!("Bearer {}", key.expose()));
        }
        http
    }
}

impl fmt::Debug for LmStudioProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LmStudioProvider")
            .field("model_id", &self.model_id)
            .field("endpoint", &self.endpoint)
            .field("api_key", &self.api_key.as_ref().map(|_| "REDACTED"))
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for LmStudioProvider {
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
        parse_chat_response(&response.body)
    }

    fn complete_stream(
        &self,
        req: &ChatRequest,
        transport: &dyn HttpTransport,
        on_chunk: &mut dyn FnMut(ProviderChunk),
    ) -> Result<ChatResponse, ProviderError> {
        stream_chat(transport, &self.http_request(req, true), on_chunk)
    }
}
