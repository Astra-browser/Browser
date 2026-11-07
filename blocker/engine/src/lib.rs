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

use std::collections::HashSet;
use std::ffi::CString;
use std::os::raw::c_char;
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

static DISABLED_HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn hosts_slot() -> &'static Mutex<HashSet<String>> {
    DISABLED_HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_lowercase()
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

fn should_block(url: &str, source_url: &str, request_type: &str, record: bool) -> bool {
    if record {
        record_decision();
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        should_block_inner(url, source_url, request_type)
    }));
    let blocked = result.unwrap_or(false);
    if blocked && record {
        record_block();
    }
    blocked
}

fn should_block_inner(url: &str, source_url: &str, request_type: &str) -> bool {
    let disabled = match hosts_slot().lock() {
        Ok(hosts) => hosts.contains(&host_of_url(source_url)),
        Err(_) => return false,
    };
    if disabled {
        return false;
    }
    with_slot(|slot| {
        let Some(engine) = slot.engine.as_ref() else {
            return false;
        };
        let Ok(request) = Request::new(url, source_url, request_type) else {
            return false;
        };
        // adblock 0.12.1 has no should_block() helper: matched with no
        // exception means block (same rule the content classifier applies).
        let result = engine.check_network_request(&request);
        result.matched && result.exception.is_none()
    })
    .unwrap_or(false)
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

/// Pauses (`false`) or resumes (`true`) protection for one site (host).
#[no_mangle]
pub extern "C" fn astra_blocker_set_site_enabled(
    host: *const c_char,
    host_len: usize,
    enabled: bool,
) -> nsresult {
    let key = normalize_host(&read_str(host, host_len));
    match hosts_slot().lock() {
        Ok(mut hosts) => {
            if enabled {
                hosts.remove(&key);
            } else if !key.is_empty() {
                hosts.insert(key);
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
    let key = normalize_host(&read_str(host, host_len));
    hosts_slot()
        .lock()
        .map(|hosts| !hosts.contains(&key))
        .unwrap_or(true)
}

#[no_mangle]
pub extern "C" fn astra_blocker_site_exceptions_json() -> *mut c_char {
    let mut hosts: Vec<String> = hosts_slot()
        .lock()
        .map(|hosts| hosts.iter().cloned().collect())
        .unwrap_or_default();
    hosts.sort();
    json_ptr(&hosts)
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
    if out_block.is_null() {
        return NS_ERROR_INVALID_ARG;
    }
    *out_block = should_block(
        &read_str(url, url_len),
        &read_str(source_url, source_url_len),
        &read_str(request_type, request_type_len),
        record,
    );
    NS_OK
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
