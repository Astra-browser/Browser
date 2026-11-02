/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! DeepSeek provider: OpenAI-compatible chat completions at
//! `api.deepseek.com`, reusing the shared parser in [`super::openai`].

use super::openai::{chat_request_body, parse_chat_response, stream_chat, KEYCHAIN_ACCOUNT};
use super::HttpRequest;
use super::{
    post_with_retry, ApiKey, ChatRequest, ChatResponse, HttpTransport, KeyStore, ModelProvider,
    ProviderChunk, ProviderError, ProviderKind, RetryPolicy,
};
use std::fmt;
use std::time::Duration;

/// Default endpoint for the hosted DeepSeek API.
pub const DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";

/// DeepSeek provider (hosted OpenAI-compatible API).
pub struct DeepSeekProvider {
    model_id: String,
    endpoint: String,
    api_key: ApiKey,
    retry: RetryPolicy,
}

impl DeepSeekProvider {
    /// New provider with an explicit key.
    pub fn new(api_key: ApiKey, model: impl Into<String>) -> Self {
        Self {
            model_id: model.into(),
            endpoint: DEEPSEEK_ENDPOINT.to_owned(),
            api_key,
            retry: RetryPolicy::default(),
        }
    }

    /// Load the key from `store`, failing with `MissingKey` when absent.
    pub fn from_keystore(
        store: &dyn KeyStore,
        model: impl Into<String>,
    ) -> Result<Self, ProviderError> {
        let service = ProviderKind::DeepSeek
            .keychain_service()
            .unwrap_or("astra/provider/deepseek");
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
        Ok(HttpRequest::post_json(
            self.endpoint.clone(),
            chat_request_body(&req.model, req, stream),
        )
        .header("Authorization", format!("Bearer {}", self.api_key.expose())))
    }
}

impl fmt::Debug for DeepSeekProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeepSeekProvider")
            .field("model_id", &self.model_id)
            .field("endpoint", &self.endpoint)
            .field("api_key", &"REDACTED")
            .field("retry", &self.retry)
            .finish()
    }
}

impl ModelProvider for DeepSeekProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::DeepSeek
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
