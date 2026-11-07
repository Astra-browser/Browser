/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra_blocker_engine`: the native heart of Astra's ad/tracker blocker.
//!
//!
//! `Engine` is not `Sync` under the unified gkrust `single-thread` feature, so
//! it lives in a main-thread-guarded `Mutex<Slot>`; every entry point checks
//! `NS_IsMainThread()` and fails open otherwise. Fail-open is a hard rule: no
//! rules, a bad request, a poisoned lock, a compile error or an off-thread
//! caller all answer "allow" and never take the browser down.

use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_uchar, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Mutex, OnceLock};

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::resources::Resource;
use adblock::{Engine, FilterSet};
use cstr::cstr;
use nserror::{nsresult, NS_ERROR_INVALID_ARG, NS_OK};
use serde::Serialize;
use xpcom::interfaces::nsIEffectiveTLDService;

pub const ADBLOCK_VERSION: &str = "0.12.1";

static ETLD_SERVICE: Mutex<Option<xpcom::RefPtr<nsIEffectiveTLDService>>> = Mutex::new(None);

struct SchemelessSiteResolver {}

impl adblock::url_parser::ResolvesDomain for SchemelessSiteResolver {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        let guard = match ETLD_SERVICE.lock() {
            Ok(g) => g,
            Err(_) => return (0, host.len()),
        };
        let etld_service = match guard.as_ref() {
            Some(s) => s,
            None => return (0, host.len()),
        };

        let mut host_cstring = nsstring::nsCString::new();
        host_cstring.assign(host);

        let mut base_domain = nsstring::nsCString::new();
        unsafe {
            if etld_service
                .GetBaseDomainFromHost(&*host_cstring, 0, &mut *base_domain)
                .succeeded()
            {
                let base_domain_len = base_domain.len();
                if base_domain_len > 0 && base_domain_len <= host.len() {
                    return (host.len() - base_domain_len, host.len());
                }
            }
        }
        (0, host.len())
    }
}

fn ensure_domain_resolver() {
    if let Some(etld_service) = xpcom::get_service::<nsIEffectiveTLDService>(cstr!(
        "@mozilla.org/network/effective-tld-service;1"
    )) {
        if let Ok(mut guard) = ETLD_SERVICE.lock() {
            guard.replace(etld_service);
        }
    }
    // Always install a resolver. adblock's parser `expect`s one on the first
    // Request::new; without it a missing eTLD service would unwind across the
    // C ABI and abort the browser. The fallback treats every host as its own
    // registrable domain, which is conservative for third-party matching.
    let _ = adblock::url_parser::set_domain_resolver(Box::new(SchemelessSiteResolver {}));
}

/// Per-site shielding policy. `enabled == false` pauses every filter for the
/// site; `aggressive` opts the site into the strict list extras; `scripts`
/// blocks every script request for the site (Brave's "Block scripts").
#[derive(Clone, Copy)]
struct SitePolicy {
    enabled: bool,
    aggressive: bool,
    scripts: bool,
}

impl Default for SitePolicy {
    fn default() -> Self {
        SitePolicy {
            enabled: true,
            aggressive: false,
            scripts: false,
        }
    }
}

static SITE_POLICIES: OnceLock<Mutex<HashMap<String, SitePolicy>>> = OnceLock::new();

fn policies_slot() -> &'static Mutex<HashMap<String, SitePolicy>> {
    SITE_POLICIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hosts whose DNS canonical name resolves into a tracker domain. The Host
/// module fills this through `AstraBlocker.addCloakedHost` after an async
/// CNAME lookup; the channel hook then cancels every later request to the
/// cloaked first-party host.
static CLOAKED_HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cloaked_slot() -> &'static Mutex<HashSet<String>> {
    CLOAKED_HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_lowercase()
}

fn site_policy(host: &str) -> SitePolicy {
    let key = normalize_host(host);
    policies_slot()
        .lock()
        .ok()
        .and_then(|map| map.get(&key).copied())
        .unwrap_or_default()
}

/// Request-side switches pushed by C++ from the profile prefs.
const FLAG_REMOVEPARAM: u32 = 1 << 0;
const FLAG_BOUNCE: u32 = 1 << 1;
const FLAG_BLOCK_SCRIPTS: u32 = 1 << 2;
const FLAG_REDIRECTS: u32 = 1 << 3;

/// Third-party hosts that only exist to embed a social widget on another site.
/// Blocked when the page's per-site shield is Aggressive.
const AGGRESSIVE_HOSTS: &[&str] = &[
    "connect.facebook.net",
    "facebook.com",
    "facebook.net",
    "platform.twitter.com",
    "syndication.twitter.com",
    "platform.linkedin.com",
    "assets.pinterest.com",
    "embed.reddit.com",
    "instagram.com",
    "tiktok.com",
    "www.tiktok.com",
    "widgets.pinterest.com",
    "apis.google.com",
    "accounts.google.com",
];

/// The native decision for one request. `redirect` is a complete data: URI
/// produced by adblock-rust from a `$redirect` resource; `rewrite` is either
/// the `$removeparam` cleaned URL or an unwrapped bounce target.
#[derive(Default)]
struct Verdict {
    block: bool,
    redirect: String,
    rewrite: String,
}

fn host_of_url(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("");
    normalize_host(authority.split(':').next().unwrap_or(""))
}

const STAT_DAYS: usize = 8;

#[derive(Default)]
struct Stats {
    blocks: u64,
    decisions: u64,
    cosmetic_pages: u64,
    days: [u64; STAT_DAYS],
    day: u64,
}

static STATS: Mutex<Stats> = Mutex::new(Stats {
    blocks: 0,
    decisions: 0,
    cosmetic_pages: 0,
    days: [0; STAT_DAYS],
    day: 0,
});

fn unix_day() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

fn record_block() {
    let now = unix_day();
    if let Ok(mut stats) = STATS.lock() {
        if now > stats.day {
            let shift = (now - stats.day).min(STAT_DAYS as u64) as usize;
            if shift >= STAT_DAYS {
                stats.days = [0; STAT_DAYS];
            } else {
                let mut next = [0u64; STAT_DAYS];
                for i in 0..STAT_DAYS - shift {
                    next[i] = stats.days[i + shift];
                }
                stats.days = next;
            }
            stats.day = now;
        }
        stats.blocks = stats.blocks.saturating_add(1);
        stats.days[STAT_DAYS - 1] = stats.days[STAT_DAYS - 1].saturating_add(1);
    }
}

fn record_decision() {
    if let Ok(mut stats) = STATS.lock() {
        stats.decisions = stats.decisions.saturating_add(1);
    }
}

#[derive(Serialize)]
struct StatsView {
    blocks: u64,
    decisions: u64,
    cosmetic_pages: u64,
    today: u64,
    last_7_days: u64,
    days: Vec<u64>,
}

fn stats_view() -> StatsView {
    let now = unix_day();
    let stats = STATS.lock().ok();
    let mut days = [0u64; STAT_DAYS];
    let (blocks, decisions, cosmetic_pages) = match stats.as_ref() {
        Some(s) => (s.blocks, s.decisions, s.cosmetic_pages),
        None => (0, 0, 0),
    };
    if let Some(s) = stats.as_ref() {
        days = s.days;
    }
    // A stale ring (browser left running across midnight) still answers the
    // last recorded day; the next block rotates it.
    let today = if stats.as_ref().map(|s| s.day).unwrap_or(0) == now {
        days[STAT_DAYS - 1]
    } else {
        0
    };
    let last_7_days = days[1..].iter().sum();
    StatsView {
        blocks,
        decisions,
        cosmetic_pages,
        today,
        last_7_days,
        days: days.to_vec(),
    }
}

#[derive(Default, Clone)]
struct CosmeticCache {
    url: String,
    hide: Vec<String>,
    exceptions: Vec<String>,
    generichide: bool,
    script: String,
    procedural: Vec<String>,
}

struct Slot {
    engine: Option<Box<Engine>>,
    rule_count: usize,
    resources: Option<Vec<Resource>>,
    resource_count: usize,
    cosmetic: Option<CosmeticCache>,
}

/// Safety: every access is guarded by `moz_task::is_main_thread()` and the
/// slot mutex. `Engine` is `!Send` under `single-thread`, but the value is
/// created, used and dropped only on Gecko's main thread.
unsafe impl Send for Slot {}

static SLOT: Mutex<Slot> = Mutex::new(Slot {
    engine: None,
    rule_count: 0,
    resources: None,
    resource_count: 0,
    cosmetic: None,
});

extern "C" {
    // Exported by libxul (xpcom/threads/nsThreadUtils.h). Kept as a direct
    // declaration so this crate does not pull the mozbuild build script.
    fn NS_IsMainThread() -> bool;
}

fn is_main_thread() -> bool {
    unsafe { NS_IsMainThread() }
}

fn with_slot<R>(f: impl FnOnce(&mut Slot) -> R) -> Option<R> {
    if !is_main_thread() {
        return None;
    }
    let mut slot = SLOT.lock().ok()?;
    Some(f(&mut slot))
}

pub fn is_installed() -> bool {
    with_slot(|slot| slot.engine.is_some()).unwrap_or(false)
}

pub fn rule_count() -> u64 {
    with_slot(|slot| slot.rule_count as u64).unwrap_or(0)
}

fn count_rules(text: &str) -> usize {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('!') && !line.starts_with('['))
        .count()
}

#[derive(Serialize)]
struct InstallReport {
    ok: bool,
    failure: String,
    rules: usize,
    resources: usize,
    adblock: &'static str,
}

fn install_rules(rules: &str) -> InstallReport {
    ensure_domain_resolver();
    let report = |ok: bool, failure: &str, slot: &Slot| InstallReport {
        ok,
        failure: failure.to_string(),
        rules: slot.rule_count,
        resources: slot.resource_count,
        adblock: ADBLOCK_VERSION,
    };

    if rules.trim().is_empty() {
        return with_slot(|slot| report(false, "empty_rules", slot))
            .unwrap_or_else(|| InstallReport {
                ok: false,
                failure: "main_thread_required".into(),
                rules: 0,
                resources: 0,
                adblock: ADBLOCK_VERSION,
            });
    }

    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let mut set = FilterSet::new(false);
        set.add_filter_list(rules, ParseOptions::default());
        Engine::from_filter_set(set, true)
    }));

    match outcome {
        Ok(mut engine) => with_slot(|slot| {
            if let Some(resources) = slot.resources.as_ref() {
                engine.use_resources(resources.clone());
            }
            let rules = count_rules(rules);
            slot.engine = Some(Box::new(engine));
            slot.rule_count = rules;
            slot.cosmetic = None;
            report(true, "", slot)
        })
        .unwrap_or_else(|| InstallReport {
            ok: false,
            failure: "main_thread_required".into(),
            rules: 0,
            resources: 0,
            adblock: ADBLOCK_VERSION,
        }),
        Err(_) => with_slot(|slot| report(false, "compile_panic", slot))
            .unwrap_or_else(|| InstallReport {
                ok: false,
                failure: "compile_panic".into(),
                rules: 0,
                resources: 0,
                adblock: ADBLOCK_VERSION,
            }),
    }
}

#[derive(Serialize)]
struct ResourceReport {
    ok: bool,
    failure: String,
    resources: usize,
}

fn install_resources(json: &str) -> ResourceReport {
    let parsed: Result<Vec<Resource>, _> = serde_json::from_str(json);
    match parsed {
        Ok(resources) => with_slot(|slot| {
            if let Some(engine) = slot.engine.as_mut() {
                engine.use_resources(resources.clone());
                slot.cosmetic = None;
            }
            slot.resource_count = resources.len();
            slot.resources = Some(resources);
            ResourceReport {
                ok: true,
                failure: String::new(),
                resources: slot.resource_count,
            }
        })
        .unwrap_or(ResourceReport {
            ok: false,
            failure: "main_thread_required".into(),
            resources: 0,
        }),
        Err(error) => ResourceReport {
            ok: false,
            failure: format!("invalid_resources: {error}"),
            resources: 0,
        },
    }
}

fn clear() {
    with_slot(|slot| {
        slot.engine = None;
        slot.rule_count = 0;
        slot.cosmetic = None;
        slot.resources = None;
        slot.resource_count = 0;
    });
}

/// The single native decision point used by both the channel hook and the
/// management service (classifyHost/classifyBounce). Always fail-open.
fn decide(
    url: &str,
    source_url: &str,
    request_type: &str,
    flags: u32,
    record: bool,
) -> Verdict {
    if record {
        record_decision();
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        decide_inner(url, source_url, request_type, flags)
    }));
    let verdict = result.unwrap_or_default();
    if record && (verdict.block || !verdict.redirect.is_empty()) {
        record_block();
    }
    verdict
}

fn decide_inner(url: &str, source_url: &str, request_type: &str, flags: u32) -> Verdict {
    let dest_host = host_of_url(url);
    let source_host = host_of_url(source_url);
    // A pause applies to the page that initiated the request; a top-level
    // document has no loading principal host, so its own host is the site.
    let policy_host = if source_host.is_empty() {
        dest_host.clone()
    } else {
        source_host.clone()
    };
    let policy = site_policy(&policy_host);
    if !policy.enabled {
        return Verdict::default();
    }
    let effective_flags = if policy.aggressive {
        flags | FLAG_REMOVEPARAM | FLAG_BOUNCE
    } else {
        flags
    };

    // Aggressive per-site shield: drop third-party social embeds even when the
    // site is not in the global aggressive list set.
    if policy.aggressive
        && !source_host.is_empty()
        && !dest_host.is_empty()
        && dest_host != source_host
        && AGGRESSIVE_HOSTS.iter().any(|candidate| {
            dest_host == *candidate || dest_host.ends_with(&format!(".{}", candidate))
        })
    {
        return Verdict {
            block: true,
            ..Verdict::default()
        };
    }

    // CNAME uncloaking: the Host resolved this first-party host to a tracker
    // canonical name, so every later request to it is blocked.
    if !dest_host.is_empty()
        && cloaked_slot()
            .lock()
            .map(|hosts| hosts.contains(&dest_host))
            .unwrap_or(false)
    {
        return Verdict {
            block: true,
            ..Verdict::default()
        };
    }

    // Block Scripts: the global switch or the per-site switch.
    if request_type == "script" && (effective_flags & FLAG_BLOCK_SCRIPTS != 0 || policy.scripts) {
        return Verdict {
            block: true,
            ..Verdict::default()
        };
    }

    let engine_result = with_slot(|slot| {
        let Some(engine) = slot.engine.as_ref() else {
            return None;
        };
        let effective_source = if source_url.is_empty() {
            "https://astra.invalid/"
        } else {
            source_url
        };
        let Ok(request) = Request::new(url, effective_source, request_type) else {
            return None;
        };
        // adblock 0.12.1 has no should_block() helper: matched with no
        // exception means block (same rule the content classifier applies).
        Some(engine.check_network_request(&request))
    })
    .flatten();

    let Some(result) = engine_result else {
        return Verdict::default();
    };

    // A redirect resource replaces the body rather than just cancelling.
    // `result.matched` distinguishes `$redirect` (also a blocking rule) from
    // `$redirect-rule`, which applies only when another filter already matched.
    if result.matched && result.exception.is_none() {
        if let Some(redirect) = result.redirect {
            if !redirect.is_empty() {
                if effective_flags & FLAG_REDIRECTS != 0 {
                    return Verdict {
                        redirect,
                        ..Verdict::default()
                    };
                }
                return Verdict {
                    block: true,
                    ..Verdict::default()
                };
            }
        }
    }

    if result.matched && result.exception.is_none() {
        return Verdict {
            block: true,
            ..Verdict::default()
        };
    }

    // `$removeparam` rewrites the URL instead of blocking it.
    if effective_flags & FLAG_REMOVEPARAM != 0 {
        if let Some(rewritten) = result.rewritten_url {
            if !rewritten.is_empty() && rewritten != url {
                return Verdict {
                    rewrite: rewritten,
                    ..Verdict::default()
                };
            }
        }
    }

    // Debounce: unwrap a known redirector/bounce URL to its destination.
    if effective_flags & FLAG_BOUNCE != 0
        && (request_type == "document" || request_type == "subdocument")
    {
        if let Some(target) = bounce_target(url) {
            return Verdict {
                rewrite: target,
                ..Verdict::default()
            };
        }
    }

    Verdict::default()
}

/// Domains that exist only to bounce a navigation through a tracking hop.
/// Keep this list short and navigation-only: unwrapping is stateless, so the
/// destination is opened directly with no referrer parameter.
/// Hosts that exist to bounce a navigation through a tracking hop. Each entry
/// carries the only path and query parameters that may be unwrapped; a search
/// engine's ordinary result page (`/?q=...`) is never rewritten.
const BOUNCE_RULES: &[(&str, &str, &[&str])] = &[
    ("l.facebook.com", "/l.php", &["u"]),
    ("lm.facebook.com", "/l.php", &["u"]),
    ("l.instagram.com", "/", &["u"]),
    ("l.messenger.com", "/l.php", &["u"]),
    ("out.reddit.com", "/", &["url"]),
    ("redirect.reddit.com", "/", &["url"]),
    ("google.com", "/url", &["q", "url", "continue"]),
    ("google.co.uk", "/url", &["q", "url", "continue"]),
    ("google.ca", "/url", &["q", "url", "continue"]),
    ("google.de", "/url", &["q", "url", "continue"]),
    ("google.fr", "/url", &["q", "url", "continue"]),
    ("google.co.in", "/url", &["q", "url", "continue"]),
    ("google.com.au", "/url", &["q", "url", "continue"]),
    ("youtube.com", "/redirect", &["q", "v"]),
    ("linkedin.com", "/redir/", &["url"]),
    ("pinterest.com", "/url", &["url"]),
    ("away.vk.com", "/", &["to", "u"]),
    ("steamcommunity.com", "/linkfilter/", &["url"]),
    ("tumblr.com", "/redirect", &["u"]),
    // Shorteners carry the target in the query string on some platforms and
    // in the path on most; only a query target can be unwrapped here.
    ("t.co", "/", &["url"]),
    ("bit.ly", "/", &["url"]),
    ("tinyurl.com", "/", &["url"]),
    ("ow.ly", "/", &["url"]),
    ("buff.ly", "/", &["url"]),
    ("is.gd", "/", &["url"]),
    ("v.gd", "/", &["url"]),
    ("rebrand.ly", "/", &["url"]),
    ("t.ly", "/", &["url"]),
    ("shorturl.at", "/", &["url"]),
    ("goo.gl", "/", &["url"]),
    ("tiny.cc", "/", &["url"]),
    ("soo.gd", "/", &["url"]),
    ("clck.ru", "/", &["url"]),
];

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = |byte: u8| match byte {
                    b'0'..=b'9' => Some(byte - b'0'),
                    b'a'..=b'f' => Some(byte - b'a' + 10),
                    b'A'..=b'F' => Some(byte - b'A' + 10),
                    _ => None,
                };
                match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                        continue;
                    }
                    _ => out.push(bytes[index]),
                }
            }
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_url(url: &str) -> Option<(String, String, String, String)> {
    let scheme_end = url.find("://")?;
    let scheme = url[..scheme_end].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let (authority, path_query) = match rest.find(['/', '?']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    let host = normalize_host(authority.split('@').next_back().unwrap_or(""));
    let host = host.split(':').next().unwrap_or("").to_string();
    let query = match path_query.find('?') {
        Some(index) => &path_query[index + 1..],
        None => "",
    };
    let path = match path_query.find('?') {
        Some(index) => &path_query[..index],
        None => path_query,
    };
    Some((scheme, host, path.to_string(), query.to_string()))
}

fn bounce_target(url: &str) -> Option<String> {
    let (_scheme, host, path, query) = split_url(url)?;
    if host.is_empty() || query.is_empty() {
        return None;
    }
    let rule = BOUNCE_RULES.iter().find(|(candidate, _, _)| {
        host == *candidate || host.ends_with(&format!(".{}", candidate))
    })?;
    let (prefix, params) = (rule.1, rule.2);
    let path_matches = if prefix == "/" {
        path.starts_with('/')
    } else {
        path == prefix || path.starts_with(&format!("{}/", prefix.trim_end_matches('/')))
    };
    if !path_matches {
        return None;
    }

    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        if !params.iter().any(|candidate| key == *candidate) {
            continue;
        }
        let decoded = percent_decode(value);
        let (target_scheme, target_host, _target_path, _target_query) = split_url(&decoded)?;
        if target_host.is_empty() || target_host == host {
            return None;
        }
        if target_scheme != "http" && target_scheme != "https" {
            return None;
        }
        if decoded.len() > 4096 {
            return None;
        }
        return Some(decoded);
    }
    None
}

#[derive(Serialize)]
struct ClassifyView {
    tracker: bool,
    host: String,
}

fn classify_host(host: &str) -> ClassifyView {
    let key = normalize_host(host);
    if key.is_empty() {
        return ClassifyView {
            tracker: false,
            host: key,
        };
    }
    let url = format!("https://{}/", key);
    let verdict = decide_inner(&url, "https://astra.invalid/", "other", 0);
    ClassifyView {
        tracker: verdict.block,
        host: key,
    }
}

// --- CNAME uncloaking DNS fallback -----------------------------------------
// Gecko's getaddrinfo-backed resolver does not return a canonical name on
// every platform (systemd-resolved commonly returns an empty one). Query the
// system resolver for the CNAME RR directly so the first-party host can still
// be classified. Called once per first-party host by the Host module and
// cached there for six hours.

// libresolv is not on libxul's link line on every build configuration, so the
// CNAME fallback resolves `res_query` at runtime from the system library. The
// handle is opened once and kept for the process lifetime.
type ResQueryFn =
    unsafe extern "C" fn(*const c_char, c_int, c_int, *mut c_uchar, c_int) -> c_int;

static RES_QUERY: OnceLock<Option<ResQueryFn>> = OnceLock::new();

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

fn res_query_fn() -> Option<ResQueryFn> {
    *RES_QUERY.get_or_init(|| unsafe {
        let name = CString::new("libresolv.so.2").ok()?;
        let handle = dlopen(name.as_ptr(), 2 /* RTLD_NOW */);
        if handle.is_null() {
            return None;
        }
        let symbol = dlsym(handle, c"res_query".as_ptr());
        if symbol.is_null() {
            return None;
        }
        Some(std::mem::transmute::<*mut c_void, ResQueryFn>(symbol))
    })
}

const DNS_C_IN: c_int = 1;
const DNS_T_CNAME: c_int = 5;

fn dns_read_name(buf: &[u8], start: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut offset = start;
    let mut next = start;
    let mut jumps = 0;
    loop {
        if offset >= buf.len() {
            return None;
        }
        let length = buf[offset] as usize;
        if length == 0 {
            offset += 1;
            if next == start {
                next = offset;
            }
            break;
        }
        if length & 0xC0 == 0xC0 {
            if offset + 1 >= buf.len() {
                return None;
            }
            let pointer = (((length & 0x3F) as usize) << 8) | buf[offset + 1] as usize;
            if next == start {
                next = offset + 2;
            }
            offset = pointer;
            jumps += 1;
            if jumps > 16 {
                return None;
            }
            continue;
        }
        if offset + 1 + length > buf.len() {
            return None;
        }
        let label = String::from_utf8_lossy(&buf[offset + 1..offset + 1 + length]).into_owned();
        labels.push(label);
        offset += 1 + length;
    }
    Some((labels.join("."), next))
}

/// Every CNAME target in a DNS answer, in response order.
fn cname_targets(host: &str) -> Vec<String> {
    let key = normalize_host(host);
    if key.is_empty() {
        return vec![];
    }
    let Ok(name) = CString::new(key.clone()) else {
        return vec![];
    };
    let mut answer = [0u8; 4096];
    let Some(query) = res_query_fn() else {
        return vec![];
    };
    let length = unsafe {
        query(
            name.as_ptr(),
            DNS_C_IN,
            DNS_T_CNAME,
            answer.as_mut_ptr(),
            answer.len() as c_int,
        )
    };
    if length <= 12 {
        return vec![];
    }
    let length = (length as usize).min(answer.len());
    let buf = &answer[..length];
    let qd = u16::from_be_bytes([buf[4], buf[5]]) as usize;
    let an = u16::from_be_bytes([buf[6], buf[7]]) as usize;
    let mut offset = 12;
    for _ in 0..qd {
        let (_, next) = match dns_read_name(buf, offset) {
            Some(value) => value,
            None => return vec![],
        };
        offset = next + 4;
    }
    let mut targets = Vec::new();
    for _ in 0..an {
        let (_, next) = match dns_read_name(buf, offset) {
            Some(value) => value,
            None => break,
        };
        offset = next;
        if offset + 10 > buf.len() {
            break;
        }
        let ty = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let rdlength = u16::from_be_bytes([buf[offset + 8], buf[offset + 9]]) as usize;
        let rdata = offset + 10;
        if ty as c_int == DNS_T_CNAME && rdata + rdlength <= buf.len() {
            if let Some((target, _)) = dns_read_name(buf, rdata) {
                let target = normalize_host(&target);
                if !target.is_empty() && target != key {
                    targets.push(target);
                }
            }
        }
        offset = rdata + rdlength;
    }
    targets.sort();
    targets.dedup();
    targets
}

#[derive(Serialize)]
struct CnameView {
    host: String,
    chain: Vec<String>,
}

fn cname_view(host: &str) -> CnameView {
    CnameView {
        host: normalize_host(host),
        chain: cname_targets(host),
    }
}


#[derive(Serialize)]
struct CosmeticView {
    url: String,
    selectors: Vec<String>,
    script: String,
    procedural: Vec<String>,
    generichide: bool,
    exceptions: Vec<String>,
}

fn empty_cosmetic(url: &str) -> CosmeticView {
    CosmeticView {
        url: url.to_string(),
        selectors: vec![],
        script: String::new(),
        procedural: vec![],
        generichide: false,
        exceptions: vec![],
    }
}

fn cosmetic_for(url: &str, classes: &[String], ids: &[String]) -> CosmeticView {
    let result = catch_unwind(AssertUnwindSafe(|| cosmetic_for_inner(url, classes, ids)));
    result.unwrap_or_else(|_| empty_cosmetic(url))
}

fn cosmetic_for_inner(url: &str, classes: &[String], ids: &[String]) -> CosmeticView {
    let Some(view) = with_slot(|slot| {
        let Some(engine) = slot.engine.as_ref() else {
            return empty_cosmetic(url);
        };
        let base = match slot.cosmetic.as_ref().filter(|cache| cache.url == url) {
            Some(cache) => cache.clone(),
            None => {
                let resources = engine.url_cosmetic_resources(url);
                let cache = CosmeticCache {
                    url: url.to_string(),
                    hide: resources.hide_selectors.into_iter().collect(),
                    exceptions: resources.exceptions.into_iter().collect(),
                    generichide: resources.generichide,
                    script: resources.injected_script,
                    procedural: resources.procedural_actions.into_iter().collect(),
                };
                slot.cosmetic = Some(cache.clone());
                cache
            }
        };

        let exceptions: HashSet<String> = base.exceptions.iter().cloned().collect();
        let mut selectors: Vec<String> = base
            .hide
            .iter()
            .filter(|selector| !exceptions.contains(*selector))
            .cloned()
            .collect();
        if !base.generichide && (!classes.is_empty() || !ids.is_empty()) {
            selectors.extend(engine.hidden_class_id_selectors(
                classes.iter().map(String::as_str),
                ids.iter().map(String::as_str),
                &exceptions,
            ));
        }
        selectors.sort();
        selectors.dedup();
        let mut procedural = base.procedural.clone();
        procedural.sort();
        procedural.dedup();
        let mut exceptions = base.exceptions.clone();
        exceptions.sort();
        CosmeticView {
            url: url.to_string(),
            selectors,
            script: base.script,
            procedural,
            generichide: base.generichide,
            exceptions,
        }
    }) else {
        return empty_cosmetic(url);
    };
    view
}

#[derive(Serialize)]
struct VersionView {
    engine: &'static str,
    version: &'static str,
    crate_version: &'static str,
    rules: u64,
    resources: usize,
}

fn version_view() -> VersionView {
    VersionView {
        engine: "adblock-rust",
        version: ADBLOCK_VERSION,
        crate_version: env!("CARGO_PKG_VERSION"),
        rules: rule_count(),
        resources: with_slot(|slot| slot.resource_count).unwrap_or(0),
    }
}

fn to_c_string(value: String) -> *mut c_char {
    match CString::new(value) {
        Ok(text) => text.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

fn json_ptr<T: Serialize>(value: &T) -> *mut c_char {
    match serde_json::to_string(value) {
        Ok(text) => to_c_string(text),
        Err(_) => ptr::null_mut(),
    }
}

fn read_str(ptr: *const c_char, len: usize) -> String {
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// Compiles newline-separated filter text. Returns a JSON report, or null on
/// an internal error. The active engine is only replaced on success.
#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_install(
    rules: *const c_char,
    rules_len: usize,
) -> *mut c_char {
    let text = read_str(rules, rules_len);
    json_ptr(&install_rules(&text))
}

#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_set_resources(
    json: *const c_char,
    json_len: usize,
) -> *mut c_char {
    let text = read_str(json, json_len);
    json_ptr(&install_resources(&text))
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_is_installed() -> bool {
    is_installed()
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_rule_count() -> u64 {
    rule_count()
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_clear() {
    clear();
}

/// Backwards-compatible pause/resume helper (mode `0` = paused).
#[no_mangle]
pub extern "C" fn astra_blocker_set_site_enabled(
    host: *const c_char,
    host_len: usize,
    enabled: bool,
) -> nsresult {
    let key = normalize_host(&read_str(host, host_len));
    if key.is_empty() {
        return NS_ERROR_INVALID_ARG;
    }
    match policies_slot().lock() {
        Ok(mut map) => {
            if enabled {
                map.remove(&key);
            } else {
                map.insert(
                    key,
                    SitePolicy {
                        enabled: false,
                        ..SitePolicy::default()
                    },
                );
            }
            NS_OK
        }
        Err(_) => NS_ERROR_INVALID_ARG,
    }
}

#[no_mangle]
pub extern "C" fn astra_blocker_is_site_enabled(
    host: *const c_char,
    host_len: usize,
) -> bool {
    site_policy(&read_str(host, host_len)).enabled
}

/// Full per-site policy: enabled (shields on), aggressive mode, block scripts.
#[no_mangle]
pub extern "C" fn astra_blocker_set_site_policy(
    host: *const c_char,
    host_len: usize,
    enabled: bool,
    aggressive: bool,
    scripts: bool,
) -> nsresult {
    let key = normalize_host(&read_str(host, host_len));
    if key.is_empty() {
        return NS_ERROR_INVALID_ARG;
    }
    match policies_slot().lock() {
        Ok(mut map) => {
            if enabled && !aggressive && !scripts {
                map.remove(&key);
            } else {
                map.insert(
                    key,
                    SitePolicy {
                        enabled,
                        aggressive,
                        scripts,
                    },
                );
            }
            NS_OK
        }
        Err(_) => NS_ERROR_INVALID_ARG,
    }
}

#[no_mangle]
pub extern "C" fn astra_blocker_site_policy_json(host: *const c_char, host_len: usize) -> *mut c_char {
    let key = normalize_host(&read_str(host, host_len));
    let policy = site_policy(&key);
    #[derive(Serialize)]
    struct PolicyView {
        host: String,
        enabled: bool,
        aggressive: bool,
        scripts: bool,
    }
    json_ptr(&PolicyView {
        host: key,
        enabled: policy.enabled,
        aggressive: policy.aggressive,
        scripts: policy.scripts,
    })
}

#[no_mangle]
pub extern "C" fn astra_blocker_site_exceptions_json() -> *mut c_char {
    let mut hosts: Vec<String> = policies_slot()
        .lock()
        .map(|map| {
            map.iter()
                .filter(|(_host, policy)| !policy.enabled)
                .map(|(host, _policy)| host.clone())
                .collect()
        })
        .unwrap_or_default();
    hosts.sort();
    json_ptr(&hosts)
}

/// DNS CNAME uncloaking hand-off: the Host module resolves a first-party host
/// and tells the engine when its canonical name is a tracker.
#[no_mangle]
pub extern "C" fn astra_blocker_set_cloaked_host(
    host: *const c_char,
    host_len: usize,
    blocked: bool,
) -> nsresult {
    let key = normalize_host(&read_str(host, host_len));
    if key.is_empty() {
        return NS_ERROR_INVALID_ARG;
    }
    match cloaked_slot().lock() {
        Ok(mut hosts) => {
            if blocked {
                // A long-lived session must not grow this set without bound.
                if hosts.len() >= 4096 && !hosts.contains(&key) {
                    hosts.clear();
                }
                hosts.insert(key);
            } else {
                hosts.remove(&key);
            }
            NS_OK
        }
        Err(_) => NS_ERROR_INVALID_ARG,
    }
}

#[no_mangle]
pub extern "C" fn astra_blocker_is_cloaked(host: *const c_char, host_len: usize) -> bool {
    let key = normalize_host(&read_str(host, host_len));
    cloaked_slot()
        .lock()
        .map(|hosts| hosts.contains(&key))
        .unwrap_or(false)
}

#[no_mangle]
pub extern "C" fn astra_blocker_cloaked_hosts_json() -> *mut c_char {
    let mut hosts: Vec<String> = cloaked_slot()
        .lock()
        .map(|hosts| hosts.iter().cloned().collect())
        .unwrap_or_default();
    hosts.sort();
    json_ptr(&hosts)
}

#[no_mangle]
pub extern "C" fn astra_blocker_classify_host_json(
    host: *const c_char,
    host_len: usize,
) -> *mut c_char {
    json_ptr(&classify_host(&read_str(host, host_len)))
}

#[no_mangle]
pub extern "C" fn astra_blocker_classify_bounce_json(
    url: *const c_char,
    url_len: usize,
) -> *mut c_char {
    #[derive(Serialize)]
    struct BounceView {
        target: String,
    }
    let target = bounce_target(&read_str(url, url_len)).unwrap_or_default();
    json_ptr(&BounceView { target })
}

#[no_mangle]
pub extern "C" fn astra_blocker_cname_json(
    host: *const c_char,
    host_len: usize,
) -> *mut c_char {
    json_ptr(&cname_view(&read_str(host, host_len)))
}

/// Diagnostic/test seam: the full decision for one request, including the
/// redirect data URI and the rewritten URL. The UI never calls this; the live
/// probes use it to prove each action deterministically.
#[derive(Serialize)]
struct CheckView {
    block: bool,
    redirect: String,
    rewrite: String,
}

#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_check_json(
    url: *const c_char,
    url_len: usize,
    source_url: *const c_char,
    source_url_len: usize,
    request_type: *const c_char,
    request_type_len: usize,
    flags: u32,
) -> *mut c_char {
    let verdict = decide(
        &read_str(url, url_len),
        &read_str(source_url, source_url_len),
        &read_str(request_type, request_type_len),
        flags,
        false,
    );
    json_ptr(&CheckView {
        block: verdict.block,
        redirect: verdict.redirect,
        rewrite: verdict.rewrite,
    })
}

/// The full verdict: block, redirect resource (data: URI) or a rewritten URL.
#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_decide(
    url: *const c_char,
    url_len: usize,
    source_url: *const c_char,
    source_url_len: usize,
    request_type: *const c_char,
    request_type_len: usize,
    flags: u32,
    record: bool,
    out_block: *mut bool,
    out_redirect: *mut *mut c_char,
    out_rewrite: *mut *mut c_char,
) -> nsresult {
    if out_block.is_null() {
        return NS_ERROR_INVALID_ARG;
    }
    *out_block = false;
    if !out_redirect.is_null() {
        *out_redirect = ptr::null_mut();
    }
    if !out_rewrite.is_null() {
        *out_rewrite = ptr::null_mut();
    }
    let verdict = decide(
        &read_str(url, url_len),
        &read_str(source_url, source_url_len),
        &read_str(request_type, request_type_len),
        flags,
        record,
    );
    *out_block = verdict.block;
    if !out_redirect.is_null() && !verdict.redirect.is_empty() {
        *out_redirect = to_c_string(verdict.redirect);
    }
    if !out_rewrite.is_null() && !verdict.rewrite.is_empty() {
        *out_rewrite = to_c_string(verdict.rewrite);
    }
    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_should_block(
    url: *const c_char,
    url_len: usize,
    source_url: *const c_char,
    source_url_len: usize,
    request_type: *const c_char,
    request_type_len: usize,
    record: bool,
    out_block: *mut bool,
) -> nsresult {
    astra_blocker_engine_decide(
        url,
        url_len,
        source_url,
        source_url_len,
        request_type,
        request_type_len,
        0,
        record,
        out_block,
        ptr::null_mut(),
        ptr::null_mut(),
    )
}

#[no_mangle]
pub unsafe extern "C" fn astra_blocker_engine_cosmetic(
    url: *const c_char,
    url_len: usize,
    classes_json: *const c_char,
    classes_len: usize,
    ids_json: *const c_char,
    ids_len: usize,
) -> *mut c_char {
    let classes: Vec<String> =
        serde_json::from_str(&read_str(classes_json, classes_len)).unwrap_or_default();
    let ids: Vec<String> = serde_json::from_str(&read_str(ids_json, ids_len)).unwrap_or_default();
    json_ptr(&cosmetic_for(&read_str(url, url_len), &classes, &ids))
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_stats_json() -> *mut c_char {
    json_ptr(&stats_view())
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_reset_stats() {
    if let Ok(mut stats) = STATS.lock() {
        *stats = Stats::default();
    }
}

#[no_mangle]
pub extern "C" fn astra_blocker_engine_version_json() -> *mut c_char {
    json_ptr(&version_view())
}

#[no_mangle]
pub unsafe extern "C" fn astra_blocker_string_free(value: *mut c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}
