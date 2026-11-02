/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Recorded provider conformance (P6-T02): no network in tests.
//!
//! Every backend parses its recorded fixture (unary + streaming), retries
//! 429/5xx and transport faults with backoff, never retries auth
//! failures, redacts keys from `Debug`, keeps keys out of request bodies,
//! and keeps local endpoints keyless. The live smokes at the bottom are
//! opt-in (`ASTRA_LIVE_SMOKE=1`) and SKIP when unset.

use astra_agents::providers::anthropic::AnthropicProvider;
use astra_agents::providers::deepseek::DeepSeekProvider;
use astra_agents::providers::gemini::GeminiProvider;
use astra_agents::providers::lmstudio::LmStudioProvider;
use astra_agents::providers::ollama::OllamaProvider;
use astra_agents::providers::openai::OpenAiProvider;
use astra_agents::providers::openrouter::OpenRouterProvider;
use astra_agents::providers::recording::RecordingTransport;
use astra_agents::providers::{
    stream_sse_reader, ApiKey, ChatRequest, HttpResponse, KeyStore, MemoryKeyStore, ModelProvider,
    OsKeychainStore, ProviderChunk, ProviderError, ProviderKind, RetryPolicy, Usage, UsageLedger,
};
use std::time::Duration;

const TEST_KEY: &str = "test-key-do-not-use-live-0001";

fn tool_request(model: &str) -> ChatRequest {
    ChatRequest {
        model: model.to_owned(),
        messages: vec![astra_agents::providers::ChatMessage::user(
            "What is on my calendar tomorrow?",
        )],
        tools: vec![astra_agents::providers::ToolDefinition::new(
            "get_events",
            "Read calendar events for a date",
            serde_json::json!({
                "type": "object",
                "properties": {"date": {"type": "string"}},
                "required": ["date"],
            }),
        )],
        max_tokens: 256,
    }
}

fn collect_stream(
    provider: &dyn ModelProvider,
    req: &ChatRequest,
    transport: &RecordingTransport,
) -> (Vec<ProviderChunk>, astra_agents::providers::ChatResponse) {
    let mut chunks = Vec::new();
    let response = provider
        .complete_stream(req, transport, &mut |chunk| chunks.push(chunk))
        .expect("recorded stream must parse");
    (chunks, response)
}

fn is_text(chunk: &ProviderChunk) -> bool {
    matches!(chunk, ProviderChunk::Text(_))
}

// --- Anthropic ---

#[test]
fn anthropic_unary_conformance() {
    let fixture = include_str!("fixtures/anthropic_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = AnthropicProvider::new(ApiKey::new(TEST_KEY), "claude-sonnet-4-5");
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "I checked the calendar for you.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].name, "get_events");
    assert_eq!(response.tool_calls[0].id, "toolu_01");
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    assert_eq!(response.usage.input_tokens, 128);
    assert_eq!(response.usage.output_tokens, 42);
    // Auth travels in headers, never in the JSON body.
    let seen = transport.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header_value("x-api-key"), Some(TEST_KEY));
    assert_eq!(
        seen[0].header_value("anthropic-version"),
        Some("2023-06-01")
    );
    assert!(!seen[0].body.contains(TEST_KEY));
}

#[test]
fn anthropic_stream_conformance() {
    let fixture = include_str!("fixtures/anthropic_stream.txt");
    let transport = RecordingTransport::ok(fixture);
    let provider = AnthropicProvider::new(ApiKey::new(TEST_KEY), "claude-sonnet-4-5");
    let (chunks, response) =
        collect_stream(&provider, &tool_request("claude-sonnet-4-5"), &transport);
    assert!(chunks
        .iter()
        .any(|chunk| *chunk == ProviderChunk::Text("I checked ".to_owned())));
    assert!(matches!(
        chunks.last(),
        Some(ProviderChunk::Finished { .. })
    ));
    assert_eq!(response.text, "I checked the calendar.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    assert_eq!(response.usage.output_tokens, 42);
    let text_chunks = chunks.iter().filter(|chunk| is_text(chunk)).count();
    assert_eq!(text_chunks, 2);
}

// --- OpenAI ---

#[test]
fn openai_unary_conformance() {
    let fixture = include_str!("fixtures/openai_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = OpenAiProvider::new(ApiKey::new(TEST_KEY), "gpt-4o-mini");
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "Here are your events.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].name, "get_events");
    assert_eq!(response.tool_calls[0].id, "call_01");
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    assert_eq!(response.usage.input_tokens, 96);
    assert_eq!(response.usage.output_tokens, 18);
    let seen = transport.requests();
    assert_eq!(
        seen[0].header_value("Authorization"),
        Some(format!("Bearer {TEST_KEY}").as_str())
    );
    assert!(!seen[0].body.contains(TEST_KEY));
    assert!(seen[0].body.contains("\"stream\":false"));
}

#[test]
fn openai_stream_conformance() {
    let fixture = include_str!("fixtures/openai_stream.txt");
    let transport = RecordingTransport::ok(fixture);
    let provider = OpenAiProvider::new(ApiKey::new(TEST_KEY), "gpt-4o-mini");
    let req = tool_request("gpt-4o-mini");
    let (chunks, response) = collect_stream(&provider, &req, &transport);
    // Stream request flips to SSE mode, still keyless body.
    assert!(transport.requests()[0].body.contains("\"stream\":true"));
    assert_eq!(response.text, "Here are your events.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    assert_eq!(
        response.usage,
        Usage {
            input_tokens: 96,
            output_tokens: 18,
            cached_input_tokens: 0,
        }
    );
    assert!(matches!(
        chunks.last(),
        Some(ProviderChunk::Finished { usage }) if *usage == response.usage
    ));
    let delta_count = chunks
        .iter()
        .filter(|chunk| matches!(chunk, ProviderChunk::ToolCallDelta { .. }))
        .count();
    assert_eq!(delta_count, 3);
}

// --- Gemini ---

#[test]
fn gemini_unary_conformance() {
    let fixture = include_str!("fixtures/gemini_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = GeminiProvider::new(ApiKey::new(TEST_KEY), "gemini-2.0-flash");
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "Here are your events.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].name, "get_events");
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    assert_eq!(response.usage.input_tokens, 110);
    assert_eq!(response.usage.output_tokens, 22);
    // Gemini carries the key in the query string (API contract), never the body.
    // The model travels in the URL path (`/models/{model}:generateContent`).
    let seen = transport.requests();
    assert!(seen[0]
        .url
        .contains("models/gemini-2.0-flash:generateContent?key="));
    assert!(!seen[0].body.contains(TEST_KEY));
    // Provider roles translate to Gemini's `user`/`model` vocabulary.
    assert!(seen[0].body.contains("\"contents\""));
    assert!(seen[0].body.contains("\"functionDeclarations\""));
}

#[test]
fn gemini_stream_conformance() {
    let fixture = include_str!("fixtures/gemini_stream.txt");
    let transport = RecordingTransport::ok(fixture);
    let provider = GeminiProvider::new(ApiKey::new(TEST_KEY), "gemini-2.0-flash");
    let (chunks, response) =
        collect_stream(&provider, &tool_request("gemini-2.0-flash"), &transport);
    assert!(transport.requests()[0]
        .url
        .contains("streamGenerateContent"));
    assert_eq!(response.text, "Here are your events.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.usage.output_tokens, 22);
    assert!(chunks.iter().filter(|chunk| is_text(chunk)).count() >= 1);
    assert!(matches!(
        chunks.last(),
        Some(ProviderChunk::Finished { .. })
    ));
}

// --- DeepSeek / OpenRouter (OpenAI-compatible) ---

#[test]
fn deepseek_unary_conformance() {
    let fixture = include_str!("fixtures/deepseek_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = DeepSeekProvider::new(ApiKey::new(TEST_KEY), "deepseek-chat");
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "Done.");
    assert_eq!(response.tool_calls[0].name, "read_page");
    assert_eq!(response.usage.input_tokens, 64);
    let seen = transport.requests();
    assert!(seen[0].url.starts_with("https://api.deepseek.com/"));
    assert!(!seen[0].body.contains(TEST_KEY));
}

#[test]
fn openrouter_unary_conformance() {
    let fixture = include_str!("fixtures/openrouter_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = OpenRouterProvider::new(ApiKey::new(TEST_KEY), "openrouter/auto");
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "On it.");
    assert_eq!(response.tool_calls[0].name, "summarize");
    assert_eq!(response.usage.output_tokens, 12);
    let seen = transport.requests();
    assert_eq!(
        seen[0].header_value("HTTP-Referer"),
        Some("https://astra.local")
    );
    assert_eq!(seen[0].header_value("X-Title"), Some("Astra"));
    assert!(!seen[0].body.contains(TEST_KEY));
}

// --- Ollama / LM Studio (local) ---

#[test]
fn ollama_unary_conformance() {
    let fixture = include_str!("fixtures/ollama_reply.json");
    let transport = RecordingTransport::ok(fixture);
    let provider = OllamaProvider::local("llama3.1");
    assert_eq!(provider.kind(), ProviderKind::Local);
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "Here you go.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].name, "get_events");
    assert_eq!(
        response.tool_calls[0].arguments,
        serde_json::json!({"date": "2026-11-03"})
    );
    // Local: no auth header, no key anywhere, zero (on-device) usage.
    let seen = transport.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header_value("Authorization"), None);
    assert!(!seen[0].url.contains("key="));
    assert!(response.usage.is_zero());
}

#[test]
fn ollama_stream_conformance() {
    let fixture = include_str!("fixtures/ollama_stream.txt");
    let transport = RecordingTransport::ok(fixture);
    let provider = OllamaProvider::local("llama3.1");
    let (chunks, response) = collect_stream(&provider, &tool_request("llama3.1"), &transport);
    assert_eq!(response.text, "Here you go.");
    assert_eq!(response.tool_calls.len(), 1);
    assert_eq!(response.tool_calls[0].name, "get_events");
    assert_eq!(chunks.iter().filter(|chunk| is_text(chunk)).count(), 2);
    assert!(matches!(
        chunks.last(),
        Some(ProviderChunk::Finished { .. })
    ));
}

#[test]
fn lmstudio_unary_and_stream_conformance() {
    let provider = LmStudioProvider::local("local-model");
    assert_eq!(provider.kind(), ProviderKind::Local);
    let transport = RecordingTransport::ok(include_str!("fixtures/lmstudio_reply.json"));
    let response = provider
        .complete_request(&tool_request(provider.model_id()), &transport)
        .unwrap();
    assert_eq!(response.text, "Local reply.");
    assert!(response.tool_calls.is_empty());
    assert_eq!(transport.requests()[0].header_value("Authorization"), None);

    let transport = RecordingTransport::ok(include_str!("fixtures/lmstudio_stream.txt"));
    let (chunks, streamed) = collect_stream(&provider, &tool_request("local-model"), &transport);
    assert_eq!(streamed.text, "Local reply.");
    assert_eq!(streamed.usage.output_tokens, 4);
    assert!(matches!(
        chunks.last(),
        Some(ProviderChunk::Finished { .. })
    ));
}

// --- Retries ---

fn retry_policy_for_tests() -> RetryPolicy {
    RetryPolicy {
        max_retries: 3,
        base_delay_ms: 5,
        max_delay_ms: 20,
    }
}

fn rate_limited() -> HttpResponse {
    HttpResponse {
        status: 429,
        headers: Vec::new(),
        body: "slow down".to_owned(),
    }
}

#[test]
fn every_provider_retries_429_then_succeeds() {
    let cases: Vec<(&str, Box<dyn ModelProvider>, &str)> = vec![
        (
            "anthropic",
            Box::new(
                AnthropicProvider::new(ApiKey::new(TEST_KEY), "m")
                    .with_retry(retry_policy_for_tests()),
            ),
            include_str!("fixtures/anthropic_reply.json"),
        ),
        (
            "openai",
            Box::new(
                OpenAiProvider::new(ApiKey::new(TEST_KEY), "m")
                    .with_retry(retry_policy_for_tests()),
            ),
            include_str!("fixtures/openai_reply.json"),
        ),
        (
            "gemini",
            Box::new(
                GeminiProvider::new(ApiKey::new(TEST_KEY), "m")
                    .with_retry(retry_policy_for_tests()),
            ),
            include_str!("fixtures/gemini_reply.json"),
        ),
        (
            "deepseek",
            Box::new(
                DeepSeekProvider::new(ApiKey::new(TEST_KEY), "m")
                    .with_retry(retry_policy_for_tests()),
            ),
            include_str!("fixtures/deepseek_reply.json"),
        ),
        (
            "openrouter",
            Box::new(
                OpenRouterProvider::new(ApiKey::new(TEST_KEY), "m")
                    .with_retry(retry_policy_for_tests()),
            ),
            include_str!("fixtures/openrouter_reply.json"),
        ),
        (
            "ollama",
            Box::new(OllamaProvider::local("m").with_retry(retry_policy_for_tests())),
            include_str!("fixtures/ollama_reply.json"),
        ),
        (
            "lmstudio",
            Box::new(LmStudioProvider::local("m").with_retry(retry_policy_for_tests())),
            include_str!("fixtures/lmstudio_reply.json"),
        ),
    ];
    for (name, provider, fixture) in cases {
        let transport = RecordingTransport::scripted(vec![
            rate_limited(),
            HttpResponse::ok(fixture.to_owned()),
        ]);
        let response = provider
            .complete_request(&ChatRequest::user("hi", "m"), &transport)
            .unwrap_or_else(|err| panic!("{name} must recover after 429: {err}"));
        assert!(!response.text.is_empty(), "{name} returns text after retry");
        assert_eq!(
            transport.requests().len(),
            2,
            "{name} sends exactly two attempts"
        );
    }
}

#[test]
fn transport_fault_is_retried_with_backoff() {
    // Backoff is injectable: record sleeps instead of waiting.
    let policy = retry_policy_for_tests();
    let mut delays = Vec::new();
    let result =
        astra_agents::providers::send_with_retry(policy, &mut |delay| delays.push(delay), {
            let mut calls = 0;
            move || -> Result<&str, ProviderError> {
                calls += 1;
                if calls < 3 {
                    return Err(ProviderError::Transport("connection reset".to_owned()));
                }
                Ok("ok")
            }
        });
    assert_eq!(result, Ok("ok"));
    assert_eq!(
        delays,
        vec![Duration::from_millis(5), Duration::from_millis(10)]
    );
}

#[test]
fn auth_failure_is_not_retried() {
    // Force a 401 by scripting the status directly.
    let transport = RecordingTransport::scripted(vec![HttpResponse {
        status: 401,
        headers: Vec::new(),
        body: "invalid key".to_owned(),
    }]);
    let _ = transport.requests(); // silence helper; real assertion below
    let provider = OpenAiProvider::new(ApiKey::new("wrong-key"), "gpt-4o-mini")
        .with_retry(retry_policy_for_tests());
    let err = provider
        .complete_request(&ChatRequest::user("hi", "gpt-4o-mini"), &transport)
        .expect_err("401 must fail");
    assert_eq!(err, ProviderError::Auth);
    assert_eq!(transport.requests().len(), 1, "auth failures send once");
    assert!(!err.is_retryable());
}

#[test]
fn server_error_message_never_carries_the_key() {
    let secret = "sk-live-abcdef-0002";
    let transport = RecordingTransport::scripted(vec![HttpResponse {
        status: 500,
        headers: Vec::new(),
        body: "internal error".to_owned(),
    }]);
    let provider =
        OpenAiProvider::new(ApiKey::new(secret), "gpt-4o-mini").with_retry(RetryPolicy {
            max_retries: 0,
            base_delay_ms: 1,
            max_delay_ms: 1,
        });
    let err = provider
        .complete_request(&ChatRequest::user("hi", "gpt-4o-mini"), &transport)
        .expect_err("500 must fail");
    assert!(!format!("{err:?}").contains(secret));
    assert!(err.is_retryable());
}

// --- Keys: keychain only, redacted everywhere ---

#[test]
fn missing_keys_fail_loudly_per_backend() {
    let empty = MemoryKeyStore::new();
    for kind in [
        ProviderKind::Anthropic,
        ProviderKind::OpenAI,
        ProviderKind::Gemini,
        ProviderKind::DeepSeek,
        ProviderKind::OpenRouter,
    ] {
        let result = match kind {
            ProviderKind::Anthropic => AnthropicProvider::from_keystore(&empty, "m").map(|_| ()),
            ProviderKind::OpenAI => OpenAiProvider::from_keystore(&empty, "m").map(|_| ()),
            ProviderKind::Gemini => GeminiProvider::from_keystore(&empty, "m").map(|_| ()),
            ProviderKind::DeepSeek => DeepSeekProvider::from_keystore(&empty, "m").map(|_| ()),
            ProviderKind::OpenRouter => OpenRouterProvider::from_keystore(&empty, "m").map(|_| ()),
            _ => unreachable!(),
        };
        assert!(
            matches!(result, Err(ProviderError::MissingKey { .. })),
            "{kind:?} reports its missing keychain entry"
        );
    }
}

#[test]
fn keystore_round_trip_never_exposes_secrets_in_debug() {
    let store = MemoryKeyStore::new();
    let service = ProviderKind::OpenAI.keychain_service().unwrap();
    store
        .set(service, "default", &ApiKey::new(TEST_KEY))
        .unwrap();
    let loaded = store.get(service, "default").unwrap().expect("stored key");
    assert_eq!(loaded.expose(), TEST_KEY);
    // `Debug` on the handle, the provider, and the store hides the secret.
    assert!(!format!("{loaded:?}").contains(TEST_KEY));
    store.delete(service, "default").unwrap();
    assert!(store.get(service, "default").unwrap().is_none());
    assert!(!format!("{store:?}").contains(TEST_KEY));
}

#[test]
fn debug_impls_redact_every_hosted_key() {
    let providers: Vec<Box<dyn std::fmt::Debug>> = vec![
        Box::new(AnthropicProvider::new(ApiKey::new(TEST_KEY), "m")),
        Box::new(OpenAiProvider::new(ApiKey::new(TEST_KEY), "m")),
        Box::new(GeminiProvider::new(ApiKey::new(TEST_KEY), "m")),
        Box::new(DeepSeekProvider::new(ApiKey::new(TEST_KEY), "m")),
        Box::new(OpenRouterProvider::new(ApiKey::new(TEST_KEY), "m")),
        Box::new(LmStudioProvider::with_endpoint(
            Some(ApiKey::new(TEST_KEY)),
            "m",
            "https://gateway.example/v1",
        )),
    ];
    for provider in providers {
        let rendered = format!("{provider:?}");
        assert!(
            rendered.contains("REDACTED"),
            "redaction marker present: {rendered}"
        );
        assert!(!rendered.contains(TEST_KEY), "no raw key in Debug");
    }
    // Local providers hold no key at all.
    let local = format!("{:?}", OllamaProvider::local("m"));
    assert!(!local.contains(TEST_KEY));
}

// --- Local-only accounting ---

#[test]
fn usage_ledger_stays_on_device() {
    let mut ledger = UsageLedger::new();
    ledger.record(
        "anthropic",
        Usage {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 5,
        },
    );
    ledger.record(
        "local",
        Usage {
            input_tokens: 10,
            output_tokens: 5,
            cached_input_tokens: 0,
        },
    );
    assert_eq!(ledger.get("anthropic").unwrap().total(), 120);
    assert_eq!(ledger.total().total(), 135);
    assert!(ledger.get("openai").is_none());
}

// --- Streaming primitives ---

#[test]
fn sse_reader_streams_events_incrementally() {
    use std::io::Cursor;
    let body = include_str!("fixtures/openai_stream.txt");
    // Feed through a generic BufRead exactly like a live socket would.
    let reader = Cursor::new(body.as_bytes().to_vec());
    let mut names = 0;
    let mut done = false;
    stream_sse_reader(reader, &mut |event| {
        if event.is_done() {
            done = true;
        } else {
            names += 1;
        }
    })
    .unwrap();
    assert!(done);
    assert_eq!(names, 6);
}

// --- Opt-in live smokes (SKIP unless ASTRA_LIVE_SMOKE=1) ---

fn live_enabled() -> bool {
    std::env::var("ASTRA_LIVE_SMOKE")
        .map(|value| value == "1")
        .unwrap_or(false)
}

fn live_request() -> ChatRequest {
    ChatRequest {
        model: String::new(), // providers substitute their own model id
        messages: vec![astra_agents::providers::ChatMessage::user(
            "Reply with only: ok",
        )],
        tools: Vec::new(),
        max_tokens: 16,
    }
}

fn live_hosted(
    name: &str,
    kind: ProviderKind,
    build: impl FnOnce(ApiKey) -> Box<dyn ModelProvider>,
) {
    if !live_enabled() {
        eprintln!("SKIP live {name} smoke (set ASTRA_LIVE_SMOKE=1 to run)");
        return;
    }
    let store = OsKeychainStore::new();
    let service = kind.keychain_service().expect("hosted kind has a service");
    let key = match store.get(service, "default") {
        Ok(Some(key)) => key,
        Ok(None) => {
            eprintln!("SKIP live {name} smoke (no keychain entry {service})");
            return;
        }
        Err(err) => panic!("live {name} smoke: keychain read failed: {err}"),
    };
    let provider = build(key);
    let mut req = live_request();
    req.model = provider.model_id().to_owned();
    match provider.complete_request(&req, &astra_agents::providers::UreqTransport::new()) {
        Ok(response) => assert!(!response.text.is_empty(), "live {name} replies"),
        Err(err) => panic!("live {name} smoke failed: {err}"),
    }
}

fn live_local(name: &str, provider: Box<dyn ModelProvider>) {
    if !live_enabled() {
        eprintln!("SKIP live {name} smoke (set ASTRA_LIVE_SMOKE=1 to run)");
        return;
    }
    let mut req = live_request();
    req.model = provider.model_id().to_owned();
    match provider.complete_request(&req, &astra_agents::providers::UreqTransport::new()) {
        Ok(response) => assert!(!response.text.is_empty(), "live {name} replies"),
        Err(ProviderError::Transport(_)) => {
            eprintln!("SKIP live {name} smoke (no local daemon listening)");
        }
        Err(err) => panic!("live {name} smoke failed: {err}"),
    }
}

#[test]
fn live_smoke_anthropic() {
    live_hosted("anthropic", ProviderKind::Anthropic, |key| {
        Box::new(AnthropicProvider::new(
            key,
            ProviderKind::Anthropic.default_model(),
        ))
    });
}

#[test]
fn live_smoke_openai() {
    live_hosted("openai", ProviderKind::OpenAI, |key| {
        Box::new(OpenAiProvider::new(
            key,
            ProviderKind::OpenAI.default_model(),
        ))
    });
}

#[test]
fn live_smoke_gemini() {
    live_hosted("gemini", ProviderKind::Gemini, |key| {
        Box::new(GeminiProvider::new(
            key,
            ProviderKind::Gemini.default_model(),
        ))
    });
}

#[test]
fn live_smoke_deepseek() {
    live_hosted("deepseek", ProviderKind::DeepSeek, |key| {
        Box::new(DeepSeekProvider::new(
            key,
            ProviderKind::DeepSeek.default_model(),
        ))
    });
}

#[test]
fn live_smoke_openrouter() {
    live_hosted("openrouter", ProviderKind::OpenRouter, |key| {
        Box::new(OpenRouterProvider::new(
            key,
            ProviderKind::OpenRouter.default_model(),
        ))
    });
}

#[test]
fn live_smoke_ollama() {
    live_local(
        "ollama",
        Box::new(OllamaProvider::local(ProviderKind::Local.default_model())),
    );
}

#[test]
fn live_smoke_lmstudio() {
    live_local("lmstudio", Box::new(LmStudioProvider::local("local-model")));
}
