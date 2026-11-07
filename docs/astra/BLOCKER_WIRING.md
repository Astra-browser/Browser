> **Superseded by [`BLOCKER.md`](BLOCKER.md) (D-42, 2026-11-07).** The
> management seam this document called "future" now exists
> (`nsIAstraBlockerService`), the engine sources live in `blocker/engine/`, and
> the build checklist in §5 is closed. Keep this file for the patch-series
> background and the in-tree feasibility argument; use `BLOCKER.md` for the
> live contract, settings, update pipeline and verification.
>
# P4-T02 — In-tree network-hook wiring (blocker)

> Owner: worker-vendor · Branch: `agent/P4-T02-network` · Status: wired, build-pending
> Decision: **IN-TREE** (fallback local-proxy documented only as contingency, §7).
> Verified against pinned ESR **153.6.0** (`upstream.toml`), engine read-only at `engine/`.

## 1. What was built

Three patches (§6.3 headers, `forge lint`-shaped) plus this doc plus
`tools/blocker-wiring-check.sh`:

| Patch | Tier | Upstream touch | Purpose |
|---|---|---|---|
| `patches/ASTRA-0003-astra-blocker-gkrust.patch` | P2 | `toolkit/library/rust/shared/Cargo.toml` +1, `shared/lib.rs` +1 | link `astra_blocker_engine` into libxul via gkrust |
| `patches/ASTRA-0004-astra-blocker-engine.patch` | P2 | `toolkit/components/moz.build` +1 DIRS; 6 new files under `toolkit/components/astra_blocker_engine/` | Rust engine (adblock-rust FFI) + C++ bridge |
| `patches/ASTRA-0005-astra-blocker-hook.patch` | P2 | `netwerk/url-classifier/AsyncUrlChannelClassifier.cpp` +10, `netwerk/url-classifier/moz.build` +1 | query the verdict pre-connect; cancel on Block |

Upstream footprint of this task: **14 modified lines** in 5 files
(budget: ≤ 1,500). Patch count 2 → 5 (budget ≤ 60). No P3.

## 2. Why in-tree is feasible (the precedent that de-risks it)

The pinned engine already ships a crate that is *exactly* the F-08 pattern
for this task (all paths verified in `engine/` at 153.6.0):

- `toolkit/components/content-classifier/content_classifier_engine/`
  (`Cargo.toml`, `moz.build`, `cbindgen.toml`, `src/lib.rs`,
  `ContentClassifierEngine.{h,cpp}`) — Rust `adblock 0.12.1` engine with a
  cbindgen C ABI and a C++ wrapper.
- gkrust link: `toolkit/library/rust/shared/Cargo.toml:125`
  (`content_classifier_engine = { path = ... }`) +
  `shared/lib.rs:159` (`extern crate content_classifier_engine;`).
- Build registration: `toolkit/components/moz.build:33-34` lists both
  `content-classifier` and `content-classifier/content_classifier_engine`.
- Network enforcement:
  `netwerk/url-classifier/AsyncUrlChannelClassifier.cpp:1076`
  (`MaybeCancelChannel` on the main-thread return runnable, after off-thread
  classification) cancels channels before the fetch is issued.
- Research: [Including Rust Code in Firefox](
  https://firefox-source-docs.mozilla.org/build/buildsystem/rust.html)
  (link into libxul via `shared/Cargo.toml` + `extern crate`, `cargo update
  -p gkrust-shared`, `mach vendor rust`, `cargo vet`) and [XPCOM components
  in Rust](
  https://firefox-source-docs.mozilla.org/writing-rust-code/xpcom.html)
  (`xpcom` crate + `#[xpcom]` macro, `components.conf`).

ASTRA-0003…0005 mirror that shape file-for-file, so every symbol and build
knob in the patches already exists in the pinned tree.

## 3. Design

```
nsHttpChannel::AsyncOpen
  └─ AsyncUrlChannelClassifier::CheckChannelHelper          (ASTRA-0005 hook)
       ├─ NEW: AstraBlocker::ShouldBlockChannel(aChannel)    (ASTRA-0004 bridge)
       │    ├─ pref astra.blocker.enabled (default false) + rules installed?
       │    ├─ skip system-principal / principal-less loads (never block chrome)
       │    └─ astra_blocker_should_block(url, source, type) (Rust FFI, adblock 0.12.1)
       │         └─ Block ⟹ aChannel->Cancel(NS_ERROR_ABORT)  (before fetch)
       └─ existing classifier cancel/annotate (unchanged)
```

Semantics (match `astra-blocker` P4-T01 exactly):

- **First- AND third-party** loads are classified. Deliberate difference from
  the content classifier, which early-returns allow for first-party loads
  (`ContentClassifierEngine::CheckNetworkRequest`, webcompat exemption) — a
  full adblocker must catch same-host ad delivery.
- Fail-open everywhere: no rules installed, unparseable request, lock
  poisoning, disabled pref → allow. Rules arrive from the Host API `Net`
  module (rule text + `InstallRules`, toggles via `SetEnabled` /
  `SetSiteEnabled`); before the first install every verdict is allow.
- Request-type mapping (`ExtContentPolicyType` → adblock types) is copied
  verbatim from `ContentClassifierEngine.cpp` so both engines agree.
- The hook is gated on `aPerformBlocking`: `CheckChannelBeforeProcessResponse`
  calls `CheckChannelHelper(..., annotate=true, blocking=false)` and must
  never cancel — without the gate we would kill in-flight responses.

## 4. Supply chain: zero new vendor surface

- The new crate pins `adblock = "=0.12.1"` with
  `default-features = false` + `["full-regex-handling", "single-thread"]`
  — the exact revision already vendored in `third_party/rust/adblock` and
  audited `safe-to-deploy` in `supply-chain/audits.toml:664` (bvandersloot).
  The feature set deliberately equals the content classifier's: the unified
  gkrust build compiles a single adblock instance, so any divergence would
  leak into upstream code (see ownership note below). Consequences, verified:
  - `cargo vet` needs **no new entries for our crates** (repo has no `tools/vet-config`
    of its own; the engine audit already covers adblock 0.12.1; our added closure
    is only `addr` + `psl`/`psl-types`);
  - `mach vendor rust` is **NOT** a no-op (correction 2026-11-02, orchestrator):
    `addr`/`psl`/`psl-types` were missing from `third_party/rust` (cbindgen
    metadata failed with "no matching package named `addr`"), so vendoring
    runs and lands them;
  - `mach vendor rust` currently **also** reports `cargo vet` failures on
    Mozilla's own crates (`cssparser*` audit-as-crates-io policy,
    `nss-rs` git-vs-published) — pre-existing registry drift in the ESR 153
    tree, unrelated to this task (our crates are not named). Workaround:
    `vendor rust --ignore-modified --force`; do NOT "fix" by touching
    supply-chain/audits.toml without understanding the drift. Flag for
    upstream-watch: ESR point bumps may need the same treatment;
  - Ownership model mirrors the classifier exactly: engines are
    Box-leaked instances owned by the C++ hook (`AstraBlockerEngine*` +
    `Mutex`, `from_rules`/`destroy`/`should_block` FFI), never in a Rust
    static. Rationale, verified the hard way (P4-T02 rework): the unified
    gkrust build compiles one adblock instance with the UNION of both
    crates' features. Our original `static Mutex<Option<Engine>>` +
    `embedded-domain-resolver` design broke both sides at once — the
    embedded resolver removes `set_domain_resolver` (which the classifier
    calls), and the classifier's `single-thread` makes `Engine` non-`Sync`
    (which our static required). Requesting exactly the classifier's set
    (`full-regex-handling` + `single-thread`, no `embedded-domain-resolver`)
    keeps the unified build identical to stock; domain resolution goes
    through the eTLD service via `set_domain_resolver` (same call as the
    classifier's init). Per-site toggles stay in a static
    `Mutex<HashSet<String>>` (always `Sync`, feature-independent).
- Version split (documented, not hidden): sidecar `astra-blocker` uses
  adblock **0.13.5**; in-tree uses **0.12.1**. Verdict parity is pinned by
  running the same fixture corpus against both (§5): block/allow/exception/
  `$important`/third-party/`$domain`/resource-type semantics agree; the only
  API deltas are `Request::new` arity and the missing `should_block()`
  helper in 0.12.1 (verdict = `matched && exception.is_none()`, the same rule
  the content classifier applies).

## 5. Verification (no full build — per task constraints)

`mach`-level builds were explicitly out of scope (too slow for this lane).
What was proven instead, all reproducible via
`tools/blocker-wiring-check.sh`:

1. **Patch integrity**: `git apply --check` of all three patches against the
   pinned engine files — clean (checked 2026-11-02).
2. **Anchor fidelity**: every modified-file hunk context exists verbatim in
   ESR 153.6.0 (Cargo.toml:124-125, lib.rs:158-159, moz.build DIRS:33-34,
   url-classifier moz.build LOCAL_INCLUDES:71-76, AsyncUrlChannelClassifier
   includes:7 + call site:970-978).
3. **Cross-consistency**: crate name in `Cargo.toml` == `extern crate` in
   ASTRA-0003 == cbindgen inputs dir == `moz.build` UNIFIED_SOURCES/EXPORTS
   == C++ `#include`s; adblock pin == `third_party/rust/adblock` version ==
   `supply-chain/audits.toml` entry.
4. **Rust type-check**: the shipped `src/lib.rs` (minus the path dep on
   `xpcom/rust/nserror`, stubbed with an identical-shape `nsresult`) passes
   `cargo check` against the real vendored adblock 0.12.1.
5. **Functional verdicts**: the crate's `#[cfg(test)]` module (shipped in
   ASTRA-0004) passes — fixture block/allow/exception/`$important` parity
   plus host-helper equivalence with `astra-blocker` — run in the scratch
   harness against vendored 0.12.1: **2 passed, 0 failed**.
6. **Sidecar parity**: `cargo test -p astra-blocker` fixture corpus green
   (P4-T01 suite, run by the wiring script).
7. **Footprint**: 14 modified lines / 0 P3 — inside the §6.7 budgets.

### Follow-up build must prove (blocking for merge to a bootable engine)

- [ ] `cargo update -p gkrust-shared` accepts the new dep; `mach vendor rust`
      reports no changes; `mach cargo vet` clean with no new audits.
- [ ] `./mach build` (or `forge build`) succeeds: cbindgen emits
      `astra_blocker_ffi.h`, `AstraBlocker.cpp` compiles, libxul links.
- [ ] `mach configure`-level proof already possible today: the two
      `extern crate`/dep lines follow the precedent verbatim.
- [ ] Live contract test (new, follow-up): with seed rules installed, a
      fixture ad URL is cancelled pre-connect (`NS_ERROR_ABORT`, no network
      egress) while first-party app JS loads; pref-off and no-rules states
      allow everything; `about:`/`chrome:` loads unaffected.
- [ ] p95 added latency per checked channel within the P4-T02 budget
      (in-memory hash match; measure on the motor of the follow-up build).

## 6. Known deviation: `forge lint` new-file carve-out (lane A)

`forge lint` rejects `Upstream-Files` entries that do not exist at the engine
baseline commit — which is every new file in ASTRA-0004. The entries are
kept anyway because `forge export` *requires* them: its uncovered-drift
check (`git diff --name-only baseline`) errors on engine changes no patch
covers, and its body refresh is `git diff baseline -- <Upstream-Files>`.
Listing only the modified `moz.build` would make `lint` pass but silently
drop the new files on the next `export`.

Required lane-A follow-up (~5 lines in `forge/astra-forge/src/main.rs`,
`cmd_lint`): accept an `Upstream-Files` entry when the patch body contains
it as a `new file` hunk. The wiring script machine-checks exactly this
invariant (§5.3 above), so the carve-out is behavior-preserving.

## 7. Fallback (not implemented): local filtering proxy

Per the task brief the fallback ships only if in-tree proves infeasible. It
does not: every mechanism used here already exists in the pinned tree, so no
proxy code was written. If a future ESR rebase breaks the precedent, the
contingency is a loopback filtering proxy in `astra-core` behind the same
verdict interface (`Net.ShouldBlock(url, sourceUrl, requestType) → Verdict`),
toggled by one pref; the `astra-blocker` semantics (this doc, §3) are the
shared contract either way.

## 8. References (all verified 2026-11-02)

- firefox-source-docs: [Including Rust Code in
  Firefox](https://firefox-source-docs.mozilla.org/build/buildsystem/rust.html),
  [XPCOM components in
  Rust](https://firefox-source-docs.mozilla.org/writing-rust-code/xpcom.html)
- Searchfox/pinned tree: `toolkit/components/content-classifier/`,
  `toolkit/library/rust/{moz.build,shared/Cargo.toml,shared/lib.rs}`,
  `netwerk/url-classifier/AsyncUrlChannelClassifier.cpp`,
  `supply-chain/audits.toml` (`[[audits.adblock]]`, 0.12.1),
  `third_party/rust/adblock` (0.12.1, features incl.
  `embedded-domain-resolver`)
