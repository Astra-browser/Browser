/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Provider layer stubs (full conformance in P6-T02).
//!
//! A provider is one model backend: a hosted API (Anthropic, OpenAI,
//! Gemini, DeepSeek, OpenRouter) or a local endpoint (Ollama, LM Studio,
//! any OpenAI-compatible server). This module owns the interface the loop
//! will stream against — [`ProviderKind`], local-only [`Usage`]
//! accounting, and the [`ModelProvider`] trait — without any network code.
//! API keys always live in the OS keychain, never in `astra-store` (see
//! `docs/astra/AGENTS_DESIGN.md`).

use serde::{Deserialize, Serialize};

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
    /// off-device, and keys stay in the keychain regardless.
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }
}

/// Token usage for one call, accounted locally only (P6-T02 keeps the
/// ledger on-device; providers never receive another call's usage).
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

/// One streamed chunk of a model reply. The full streaming protocol,
/// tool-call deltas, and retries arrive in P6-T02; the stub keeps the
/// two shapes the loop needs: text and completion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderChunk {
    Text(String),
    Finished { usage: Usage },
}

/// Provider interface stub. Implementors stream a reply for a prompt;
/// errors are plain strings until P6-T02 defines the transport error type.
pub trait ModelProvider {
    /// Backend this provider talks to.
    fn kind(&self) -> ProviderKind;

    /// Model id to request (catalogue entries arrive in P6-T02).
    fn model_id(&self) -> &str;

    /// Stream one reply for `prompt`. The stub collects chunks into the
    /// full text plus usage; real streaming stays on the P6-T02 side.
    fn complete(&self, prompt: &str) -> Result<(String, Usage), String>;
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

    fn complete(&self, prompt: &str) -> Result<(String, Usage), String> {
        Ok((
            format!("echo: {prompt}"),
            Usage {
                input_tokens: 1,
                output_tokens: 1,
                cached_input_tokens: 0,
            },
        ))
    }
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
        let (text, usage) = provider.complete("hi").unwrap();
        assert_eq!(text, "echo: hi");
        assert_eq!(usage.total(), 2);
    }
}
