# Astra Windows 11 x64 — master port plan

> **Status:** active plan, 2026-11-14. Owner direction (D-51) puts the
> Windows 11 x64 port and its packaging in scope. Linux remains the reference
> platform and must not change.
>
> **Base branch:** `windows-port` at `4b27e65b`.
> **This plan's branch:** `docs/windows-master-plan`.
> **Build host:** Windows 11 Home Single Language, 32 GiB RAM, NVIDIA RTX 3050
> Laptop + Intel Iris Xe, source on `E:`, objdir/caches on `D:`.
> **Scope contract:** `docs/astra/SCOPE.md` as amended by D-51.

This document is the map, the order of work, the acceptance criteria and the
branch/push protocol. A task is not done when it compiles; it is done when the
running Windows build answers the action, the tests pass, the Linux path is
unchanged, and the evidence is recorded.

---

## 1. Goal

Build and ship **Astra as a native Windows 11 x64 browser**:

- a native Gecko engine build from the pinned Firefox `153.6.0esr` source,
  compiled with the Windows toolchain (MSVC libraries + clang-cl),
- the Astra overlay (`overlay/astra/**`) and the Svelte UI (`ui/**`) loaded by
  that engine,
- the Rust sidecar (`astra-core.exe`) running beside `firefox.exe`,
- every visible Astra control wired through `UI -> Host API -> Gecko` or
  `UI -> sidecar -> Rust`, with no Firefox menu, dialog, window, tabbox or
  context menu answering instead,
- a per-user Windows package (portable zip + installer), default-browser and
  login-item wiring, and Authenticode signing when the owner supplies a
  certificate,
- measured startup, memory and responsiveness, with a budget derived from a
  stock Firefox build on the same machine, and
- no regression to the Linux paths or the Linux build.

Work/AI/Account stay build-flag off (D-48 and the shipped flags); the Windows
port does not turn them on.

### Non-negotiables

1. **Native wiring only.** No mock, fixture, empty or `unknown_command` state
   for a surface whose backend exists. `unknown_command` is a defect.
2. **Windows-only code is isolated.** New behavior lives behind `cfg(windows)`,
   `--os windows`, or a new `*.ps1`/Windows module. Linux commands, flags,
   paths and tests keep their current behavior.
3. **One logical change per commit**, on a per-task branch, pushed to both
   hosts.
4. **No fake optimization.** Memory work must reduce measured private commit
   without removing a feature. `EmptyWorkingSet`-style trims that only move
   pages to the pagefile are not accepted as a win.
5. **Verify on the running build.** Unit and contract tests are necessary but
   not sufficient. Every visual, interactive, multi-window or engine-backed
   surface gets a live Marionette probe on the packaged Windows build.
6. **No assumptions.** A fact that changes the design is either read from the
   machine/repo or asked. Open owner inputs are listed in section 12.

---

## 2. Owner decisions (locked 2026-11-14)

| # | Decision | Value |
|---|---|---|
| 1 | Definition of "working" | Full native engine + UI + Rust + packaging, all existing surfaces |
| 2 | Toolchain install | Allowed: MozillaBuild, missing VS components, `make`, Defender exclusions, git long paths; may trigger UAC |
| 3 | Build location | Objdir and caches on **D:** (`D:\astra-build`), source stays on `E:` |
| 4 | Git workflow | Per-task `win/<id>-<slug>` branches off `windows-port`, merge `--no-ff`, push both hosts |
| 5 | OS/arch | **Windows 11 x64 only** for the first phase; Win10/ARM64 later |
| 6 | Passkeys | **Windows Hello native**; exclude ASTRA-0014 and the Astra vault on Windows |
| 7 | RAM target | Measure stock Firefox Windows and Astra on identical fixtures, then set and enforce a budget |
| 8 | Linux safety | Preserve Linux paths/behavior; CI static gates on `ubuntu-latest`; no Linux engine build claimed |
| 9 | Live verification | Headed build on this desktop is allowed, including visible windows |

### Still needed from the owner (section 12)

- Authenticode certificate and SmartScreen reputation plan.
- Update channel decision (ship without updater, or per-user in-place updater).
- Exact product meaning of the existing Windows reputation row.
- Whether tray/global-hotkey are in the first Windows release or a later one.

---

## 3. What the repository contains

`E:\Astra` is not a long-lived Firefox fork. It is a pinned upstream tree plus
an ordered patch series, an overlay, a Svelte UI and a Rust core, assembled by
`astra-forge`.

### 3.1 Top level

| Path | What it is | Windows state |
|---|---|---|
| `upstream.toml` | Firefox pin (`esr` `153.6.0`, tarball URL + GPG signature) | Platform-neutral |
| `Cargo.toml` | Rust workspace: 12 crates, `astra-agents` included, `forge` excluded | `cargo check --workspace` passes on Windows |
| `engine/` | Full Firefox source (468,908 files, 3.27 GB), baseline commit `208dccc1ca`, no patches applied, no objdir | Source present; **never built on Windows** |
| `overlay/astra/` | 55 Host API modules, chrome frame, actors, PiP, policies, prefs, branding, `jar.mn`, `mozilla.cfg` | Mostly platform-neutral; passkeys is Linux-only |
| `ui/` | Bun workspace: `ui/app` (Svelte), `ui/shell` (chrome frame), `ui/packages/bridge` | Already has Windows branches (Mica, chrome, privacy) |
| `crates/` | 12 Rust crates: proto, ipc, host-trait, store, core, tasks, import, blocker, extensions, notes, time, agents | Compile on Windows; 2 tests fail |
| `blocker/` | Ad/tracker engine (`blocker/engine` linked into Gecko), lists, tools | Rust `dlopen("libresolv.so.2")` fails on MSVC |
| `passkeys/` | Astra platform authenticator (Linux): Rust vault + engine bridge | **Does not compile on Windows** |
| `patches/` | `ASTRA-0001` … `ASTRA-0014`, 4,693 patch lines (3,813 P2/P3) | Mostly neutral; 0013 Linux-gated, 0014 Linux-only |
| `forge/astra-forge` | Rust build/import/overlay/lint/footprint driver | Linux shell assumptions throughout |
| `config/` | `mozconfig.linux`, `mozconfig.windows` (scaffold) | Windows template unverified |
| `tools/` | Setup, probes, perf, packaging, contract runner, venv resolver | Mostly Linux/POSIX; venv resolver is cross-platform |
| `tests/contract/` | Node wire/contract suites | Portable |
| `schemas/` | Host API JSON schemas | Portable |
| `branding/` | `astra.toml` (product version), assets | Portable |
| `.github/workflows/` | `ci-fast`, `footprint`, `golden-firefox` | All Linux; no Windows job |
| `engine/` AGENTS | Firefox's own instructions (searchfox, mach, style) | Applies inside `engine/` |

### 3.2 Build pipeline

```
upstream.toml
   -> forge fetch       download + verify Firefox source, seed engine/.git
   -> forge import      apply patches/ASTRA-* in order
   -> forge overlay     copy overlay/astra, blocker, passkeys, branding into engine/
   -> forge build       mach build, then install astra-core beside firefox
   -> mach package      Linux tarball path (Windows packaging is new)
```

### 3.3 Runtime path

```
ui/app  --postMessage/bridge-->  ui/shell  --Host API-->  overlay/astra/host/*.sys.mjs
   |                                                              |
   |                                                              +--> Gecko (browsingContext, gBrowser, Places, NSS, ...)
   |
   +--> astra-core.exe (stdio, Appendix C frames) --> Rust domains --> SQLite (WAL)
```

### 3.4 Patch series summary

| Patch | What it does | Windows risk |
|---|---|---|
| ASTRA-0001 | Astra dir hook (`browser/app.mozbuild`) | None expected |
| ASTRA-0002 | Shell mount in `browser.xhtml` | None expected |
| ASTRA-0003 | Blocker crate in `gkrust` | Build files only |
| ASTRA-0004 | Blocker engine (C++ + Rust, IDL, cbindgen) | **`dlopen("libresolv.so.2")` cannot link on MSVC** |
| ASTRA-0005 | Network classifier hook (C++) | None expected |
| ASTRA-0006 | Chrome-unsanitized content utils | None expected |
| ASTRA-0007 | Fullscreen behavior (JS) | None expected |
| ASTRA-0008 | WebRTC prompt (JS) | None expected |
| ASTRA-0009 | HTTP auth prompt (JS) | None expected |
| ASTRA-0010 | DevTools teardown races (JS) | None expected |
| ASTRA-0011 | Battery WebIDL exposure | None expected |
| ASTRA-0012 | Async tab switcher null URI (JS) | None expected |
| ASTRA-0013 | Astra PiP (Linux-gated dependent dialog) | Already keeps the Windows path; verify |
| ASTRA-0014 | Astra passkeys (Linux platform authenticator) | **Exclude on Windows; use Windows Hello** |

---

## 4. Baseline evidence (2026-11-14, this machine)

These are facts, not projections.

### 4.1 Git

```
branch: windows-port
HEAD:   4b27e65b fix(ci): raise footprint budget to 4000 (D-50) ...
origin (GitLab): https://gitlab.com/kyoiske/astra.git
origin push URL 2 (GitHub): https://github.com/Astra-browser/Browser.git
github: https://github.com/Astra-browser/Browser.git
both hosts: refs/heads/windows-port = 4b27e65ba8cb72a8a971d3ae4d131a89d77c35b6
working tree: clean
```

### 4.2 Toolchain

| Tool | State |
|---|---|
| Windows | 11 Home Single Language, build 26300 |
| RAM / disk | 31.7 GiB; C: 104.7 GB free, D: 320.2 GB free, E: 63.2 GB free |
| VS2022 | Community 17.14.45, MSVC 14.44.35207, Windows SDK 10.0.26100 |
| clang-cl | `C:\Program Files\LLVM\bin\clang-cl.exe` |
| NASM / sccache / gpg / patch | present |
| Rust / Bun / Python | Rust stable, Bun 1.4.4, repo `.venv` Python 3.15.2 |
| MozillaBuild | **missing** (`C:\mozilla-build` absent) |
| `make` | **missing** (MozillaBuild supplies it) |
| `gh` / `glab` | missing (git remotes work) |
| Long paths | Windows registry `LongPathsEnabled=1`; git `core.longpaths=false` |
| Line endings | global `core.autocrlf=true`; root `.sh` files check out CRLF despite `eol=lf` |

### 4.3 Rust

```
cargo check --workspace                          PASS (12 crates)
cargo test --workspace                           107 passed, 2 failed
```

Failures:

- `astra-agents::handoff::tests::spawn_settles_transient_executable_busy` —
  `%1 is not a valid Win32 application` (Unix mock executable).
- `astra-agents::tools::cli::tests::live_runner_against_mocked_gh_binary` —
  mock `gh` shell script is not a Windows executable.

Both are Windows test-harness gaps, not domain-logic failures.

### 4.4 UI

```
bun install --frozen-lockfile                    PASS (456 packages)
bun run --filter @astra/frame typecheck          PASS (0 errors, 0 warnings)
bun run --filter @astra/frame test               1247 passed, 3 failed, 2 skipped
```

Failures to fix or prove environmental:

- `stylelint.config.test.ts` timed out at 5 s (first-run/module-load cost).
- `features/notes/tests/sections.test.ts` "a day's dates change at midnight"
  depends on the machine timezone; Windows local time differs from the Linux
  CI expectation.
- One further failure in the truncated summary; identified and fixed in W3.1.

### 4.5 Engine

```
engine/ : baseline commit 208dccc1ca, branch master, clean
objdir  : none
patches : not applied (no engine/astra, no astra_blocker, no astra_passkeys)
size    : 3.27 GB, 468,908 files, longest path 230 chars
```

### 4.6 Already Windows-aware

- `ui/app/src/shared/platform.ts` exposes `IS_WINDOWS`; components already
  branch for Windows chrome, materials, privacy, dock and about links.
- `overlay/astra/host/System.sys.mjs` already offers Mica on `WINNT` build
  >= 22621 and sets `widget.windows.mica`.
- `overlay/astra/host/Downloads.sys.mjs` already branches on `WINNT` for the
  download confirmation policy.
- `ui/app/src/features/settings/components/WindowsPrivacy.svelte` exists.
- `.gitattributes` and `tools/venv-python.sh` already carry Windows intent.

### 4.7 Known Windows gaps already visible

- `forge` uses `cp -a`, `grep`, `python3`, `./mach`, `date +%F`; `fs::canonicalize`
  produces `\\?\` paths that Git for Windows rejects.
- `obj-astra-linux`, `firefox`, `geckodriver`, `astra-core` are hardcoded in
  forge, `ui/shell/src/Shell.svelte`, probes, perf and packaging.
- `ui/shell/src/Shell.svelte` appends `"astra-core"` without `.exe`; the database
  path is built with a literal `/astra/core.sqlite`.
- `passkeys/engine` uses `std::os::unix::fs` and POSIX modes.
- `blocker/engine` links `dlopen`/`dlsym`.
- `windows_reputation_managed` and `windows_diagnostics_settings` exist in the
  generated bindings and Settings UI but have no Host API route (they would be
  `unknown_command` on Windows).
- `System.defaultBrowserStatus()` returns `null` and `loginItemStatus()` returns
  `supported: false`; both are honest placeholders, not Windows wiring.

---

## 5. Target Windows architecture

### 5.1 Build

- Source: `E:\Astra` (no spaces, already long-path clean).
- Objdir: `D:\astra-build\obj-astra-windows`.
- sccache: `D:\astra-build\sccache`.
- Package cache: `D:\astra-build\package`.
- MozillaBuild: `C:\mozilla-build`.
- Build command: `mach` through the MozillaBuild environment, invoked by
  `forge build --os windows`, never `./mach` through `CreateProcess`.
- Jobs: start at `--jobs 2` per the standing OOM rule; raise only after a
  measured successful build with at least 12 GiB headroom and owner approval.

### 5.2 Runtime

```
C:\...\Astra\firefox.exe
  +-- chrome/astra/...                  (overlay resources)
  +-- astra-core.exe                    (sidecar, same directory)
  +-- distribution/policies.json
  +-- defaults/pref/local-settings.js
  +-- mozilla.cfg

profile\
  +-- astra\core.sqlite                 (WAL, local NTFS only)
  +-- astra\logs\...
```

- Transport: Appendix C over `Subprocess` stdio is the primary path on Windows
  too. A named-pipe transport is an optional W2 optimization after the stdio
  path is green.
- Passkeys: Gecko's Windows platform authenticator (Windows Hello). The Astra
  vault, `ASTRA-0014`, `toolkit/components/astra_passkeys` and the passkeys
  Settings card are absent on Windows unless the owner later asks for a port.
- GPU: Windows graphics preference for `firefox.exe` = High performance and
  NVIDIA Control Panel preferred GPU = NVIDIA. Verify in `about:support`
  (`Compositing`, `WebRender`, adapter name). No fake mozconfig GPU flag.

### 5.3 Resource model

Windows has no PSS. Measurement uses:

- **Private commit** (`PrivateMemorySize64`) as the budget number.
- **Working set** (`WorkingSet64`) as the responsiveness number.
- **Commit charge** (`Get-Counter '\Memory\Committed Bytes'`) for the machine.
- **CPU** (`TotalProcessorTime`) and GPU engine counters for the perf matrix.

Numbers are compared only against the stock Firefox build measured on this
machine with the same fixtures.

---

## 6. Work breakdown

Phases are ordered by dependency. Each row becomes a branch and a commit.
Effort: S = hours, M = a day or two, L = multi-day.

### Phase W0 — toolchain and first build (foundation)

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W0.1 | `win/w0-toolchain` | Install MozillaBuild; verify VS2022 C++ workload, clang-cl, SDK, NASM, make; add Defender exclusions for `C:\mozilla-build`, `E:\Astra`, `D:\astra-build`, `%USERPROFILE%\.mozbuild`; set `core.longpaths=true` and repo/engine `core.autocrlf=false`; add `*.patch text eol=lf`; force a clean LF re-checkout of tracked files | `forge doctor --os windows` green; `git ls-files --eol` shows no LF-pinned file as CRLF; `git -C engine status` clean | M |
| W0.2 | `win/w0-objdir` | Add an objdir/cache contract: `D:\astra-build` for objdir/sccache/package; render it through `forge config --os windows` without hardcoding in committed files | `out/mozconfig.windows` names `D:/astra-build/obj-astra-windows`; `forge config --os linux` byte-identical | S |
| W0.3 | `win/w0-forge-platform` | Forge platform layer: host OS, `objdir(os)`, `binary_name(os)`, `mach` invocation, Python resolver, Rust `grep`/`cp`, `\\?\` stripping, Windows `date`; `--os` on `build`, `test`, `import`, `overlay`, `run`; Linux branches untouched | `forge lint`, `footprint`, `import --check` pass on Windows; Linux output unchanged by review | L |
| W0.4 | `win/w0-configure` | Resolve every `TODO(windows-port)` in `config/mozconfig.windows` against the pinned tree; make `doctor` validate the same template `config` renders; document crashreporter/updater/backgroundtasks/sccache/geckodriver decisions | `mach configure` completes; `config.status` confirms flags; no unknown option | M |
| W0.5 | `win/w0-baseline-build` | First **unpatched** engine build, `--jobs 2`, sccache on D:, no overlay; run `firefox.exe --version` and a blank window | Build succeeds; `firefox.exe` launches; build time and peak commit recorded in `BUILD_TIMES.md` | L |
| W0.6 | `win/w0-import` | Apply patches 0001–0013 on Windows; fix `git apply` path/case/line-ending issues; add per-OS patch metadata (`OS: linux` for 0014) | `forge import --check` clean; `forge import` applies 13 patches; `forge lint` clean | M |
| W0.7 | `win/w0-first-patched-build` | Overlay + build the patched tree; install `astra-core.exe`; boot Astra UI | `data-app-booted=true`; Host API handshake; no `unknown_command` for Boot/Tabs/Windows | L |
| W0.8 | `win/w0-run-dev` | `tools/run-dev.ps1` or `forge run --os windows`: profile in `out/dev-profile`, `-no-remote`, `firefox.exe` | One command launches the packaged dev build | S |

### Phase W1 — engine, overlay and native surfaces

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W1.1 | `win/w1-blocker-dns` | Blocker `res_query` path: keep `libresolv` on Linux; on Windows use `DnsQuery_W(DNS_TYPE_CNAME)` or `GetAddrInfoW` with `AI_CANONNAME`; add a CNAME fixture test | `cargo test -p astra-blocker` + a live CNAME classification probe on Windows | M |
| W1.2 | `win/w1-passkeys-off` | Exclude ASTRA-0014 and `passkeys/engine` on Windows; set `security.webauthn.astra_passkeys=false`; guard `Passkeys.sys.mjs` against the absent service; use Windows Hello | No `@astra/passkeys;1` lookup on Windows; passkey create/sign-in works through Windows Hello; Settings card absent or reads "Windows Hello" honestly | M |
| W1.3 | `win/w1-msvc-fixes` | Fix MSVC/C++ compile errors from the patch series and overlay; no GCC-only constructs; keep Linux code unchanged | Engine builds with all Windows patches; `forge lint` clean | L |
| W1.4 | `win/w1-overlay` | Overlay copy without `cp -a`; `jar.mn` LF-safe; `mozilla.cfg`/policies staged; branding assets | `dist/bin` has the overlay; `chrome://astra` and `resource://astra` load in chrome; CSP audit clean | M |
| W1.5 | `win/w1-sidecar-path` | `astra-core.exe` install; `Shell.svelte` `.exe` lookup; `Path.join` database path; `Boot` launch with correct cwd/stdin | Sidecar launches from beside `firefox.exe`; `Metadata.status().available === true` | S |
| W1.6 | `win/w1-window-chrome` | Windows titlebar, caption buttons, resize, snap layouts, per-monitor DPI, Mica, high contrast, accent color | Live probe: controls hit-test, window resizes, Mica material reported by `ui_info`, no double titlebar | M |
| W1.7 | `win/w1-native-ui-suppression` | Verify every Firefox menu/dialog/context menu/window/tabbox is suppressed on Windows; fix any native path the engine still answers | Live probe: app menu, tab menu, page context menu, print, auth, cert, find, DevTools open only through Astra UI | L |
| W1.8 | `win/w1-gpu` | Set Windows graphics preference + NVIDIA preferred GPU; verify WebRender/video/canvas use the RTX 3050 | `about:support` live probe: NVIDIA adapter, hardware WebRender, no Intel fallback for the browser | S |
| W1.9 | `win/w1-menu-actions` | Route the remaining known-unrouted controls (`tab_menu_popup`, `chrome_menu_popup`, `tabs_split`, `tab_drop`, `extension_action_*`) or remove them | `wire_coverage` and contract suites green; no `unknown_command` for visible controls | L |

### Phase W2 — Rust core, process model and memory safety

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W2.1 | `win/w2-cargo-tests` | Windows test twins: `.cmd` mock executables, `notify` timing, symlink/junction jail escape, IPC chaos echo child | `cargo test --workspace` green on Windows; Unix tests still green | M |
| W2.2 | `win/w2-process-spawn` | PATHEXT/`.cmd` resolution; concurrent stdout/stderr drain (4 KiB Windows pipe); Job Object kill-on-close; `CREATE_NO_WINDOW`; drop dead `ETXTBSY` retry | Agent command, handoff, MCP and sidecar tests; no hang on >4 KiB output; no console flash | M |
| W2.3 | `win/w2-paths` | Normalize `\\?\`, case-fold, reject reserved names/trailing dots/ADS in `ScopedFs` and `handoff`; drive-letter/UNC tests | Path tests green; no false allow/deny; symlink/junction test on Windows | M |
| W2.4 | `win/w2-ipc` | Validate length prefix before allocation; bound frame size/queues; optional named-pipe transport with user-only DACL, token handshake retained | Chaos tests green; no multi-GiB allocation from a bad prefix; pipe ACL probe | M |
| W2.5 | `win/w2-logging` | Close-before-rename on rotation with retry; seek-based log tail; single-pass redaction buffer | Log rotation test; log tail memory bounded; no unbounded log growth | S |
| W2.6 | `win/w2-notes` | Drop `mem::forget(watcher)`; bound event channel; mtime/size short-circuit; `HashMap` diff; no 2 s full rescan in Live mode | Notes tests; watcher released on shutdown; idle CPU/RSS measured | M |
| W2.7 | `win/w2-store` | Named-mutex single instance per DB/profile; local-NTFS guard; rename `-wal`/`-shm` with the main file on recovery | Two launches: second fails fast; corrupt DB recovers; no `SQLITE_BUSY` after 5 s | M |
| W2.8 | `win/w2-keyring` | Target-scoped `keyring` features: Windows native only; keep Linux Secret Service on Linux | Provider key read/write works; no zbus/secret-service compiled on Windows | S |
| W2.9 | `win/w2-core-crash` | Sidecar in a Job Object; stdin EOF still primary; pipe stderr drained; crash recovery test | Kill browser -> sidecar exits; kill sidecar -> browser reports unavailable and recovers | M |

### Phase W3 — UI and Host API surfaces

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W3.1 | `win/w3-ui-gates` | Make `bun run --filter @astra/frame check` green on Windows: timezone-stable notes test, stylelint timeout, the third failure; add a Windows CI job | 0 failures, 0 warnings; component/unit suites green on Windows | M |
| W3.2 | `win/w3-windows-privacy` | Implement `windows_reputation_managed` and `windows_diagnostics_settings` Host routes (registry/Defender state; `ms-settings:privacy-feedback`), with contract tests | Settings -> Privacy Windows rows answer real state; no `unknown_command`; probe passes | S |
| W3.3 | `win/w3-default-browser` | Real `default_browser_status` (UserChoice ProgId) and a "set default" path (Windows Settings deep link or association UI); installer registers ProgId | Status matches Windows; action opens the right surface; no false claim | M |
| W3.4 | `win/w3-login-item` | Real `login_item_status` + toggle (HKCU Run or StartupTask), per-user only | Toggle persists; launches at login; disable removes it | S |
| W3.5 | `win/w3-dialogs` | File pickers, downloads, save/open, notifications, print, auth, cert, permission prompts through Astra surfaces | Live probes for each; no native Firefox dialog | L |
| W3.6 | `win/w3-passkeys-hello` | Windows Hello prompt for WebAuthn; private-window refusal; Settings copy | Create/sign-in with Hello; private context refused; no vault file on Windows | M |
| W3.7 | `win/w3-extensions` | Firefox add-ons + Chrome CRX3 intake, temporary install/restore, store callout, action buttons | Extension corpus probe on Windows; no native store/action UI | L |
| W3.8 | `win/w3-media` | Media controls, PiP (Windows path), now-playing, video decode on NVIDIA | Media/PiP probes on Windows; playback survives tab return | M |
| W3.9 | `win/w3-import` | Chrome/Edge/Brave/Firefox/Zen importers on Windows paths; migration pickers | Fixture tests + live import from a synthetic profile | M |
| W3.10 | `win/w3-remaining` | Onboarding, search launcher, diagnostics/About, spaces/containers, bookmarks/history, notes/tasks/time, private/multi-window isolation | Surface-by-surface live probe; `wire_coverage` green | L |
| W3.11 | `win/w3-shell-tests` | Playwright/component shell tests against the Windows build; fix Linux-only assumptions in test boot | Shell suite green on Windows | M |

### Phase W4 — packaging, installer and release

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W4.1 | `win/w4-portable-zip` | `package-windows.ps1`: stage `dist/bin`, `astra-core.exe`, defaults, distribution, icons, `BUILD.txt`, SHA-256 | Zip extracts and runs on a clean profile; hash verified | M |
| W4.2 | `win/w4-installer` | Per-user installer (NSIS or MSIX): Start Menu, desktop shortcut, uninstaller, no admin requirement, file associations, ProgId, AppUserModelID | Clean-VM install/uninstall; default-browser registration; no leftover files | L |
| W4.3 | `win/w4-signing` | Authenticode sign `firefox.exe`, `astra-core.exe`, installer; verify with `signtool`; SmartScreen plan | `signtool verify /pa` clean; owner certificate required | M |
| W4.4 | `win/w4-updater-decision` | Resolve U-09: either ship with updater off (honest `unavailable`) or implement per-user in-place MAR updates without the Mozilla Maintenance Service | Decision recorded; if implemented, N-1 -> N update passes without admin | L |
| W4.5 | `win/w4-release-checklist` | Windows release checklist, artifact naming, versioning, rollback | Checklist reviewed against a real artifact | S |

### Phase W5 — performance and RAM

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W5.1 | `win/w5-harness` | Windows perf harness: startup, private commit, working set, CPU, GPU, tab switch, scroll, blocker; local fixtures; headed build | `tools/perf/windows/` runs and writes JSON; numbers reproducible | L |
| W5.2 | `win/w5-stock-baseline` | Download/verify stock Firefox ESR 153 Windows x64; measure same fixtures | Stock baseline recorded with URL/hash/version | M |
| W5.3 | `win/w5-astra-baseline` | Measure Astra Windows baseline; compare per surface | Baseline table + per-scenario deltas | M |
| W5.4 | `win/w5-budgets` | Set budgets from the measured stock baseline (startup <= stock +15%; 50 sleeping tabs <= stock; 1 tab <= stock +10%; no >10% regression on switch/scroll) | Budgets recorded and gated in CI | S |
| W5.5 | `win/w5-rust-memory` | Apply section 8 Rust reductions with tests and live probes | Each change measured; no feature loss; budget met | L |
| W5.6 | `win/w5-ui-memory` | Startup graph, lazy routes, bounded caches, listener teardown, per-window model | Bundle budget green; per-window memory measured | M |
| W5.7 | `win/w5-engine-memory` | Content-process count, `unloadOnLowMemory`, bfcache/process prefs, jemalloc settings; measure before/after | No functional regression; private commit improves or stays within budget | M |
| W5.8 | `win/w5-gpu-power` | NVIDIA-only rendering, hardware video decode, no iGPU fallback; power/thermal check | GPU probe + power sample | S |
| W5.9 | `win/w5-regression-gate` | Nightly Windows perf job; compare rolling median; fail on regression | Job green and artifacted | M |

### Phase W6 — CI and cross-platform guardrails

| ID | Branch | Work | Acceptance | Effort |
|---|---|---|---|---|
| W6.1 | `win/w6-ci-static` | GitHub `windows-latest` job: cargo fmt/clippy/test, bun check, contracts, forge lint/footprint, state-check (UTF-8), brand-lint | Green on `windows-port` and PRs | M |
| W6.2 | `win/w6-ci-engine` | Self-hosted Windows runner job: MozillaBuild + VS2022 + sccache on D:, `forge build --os windows --jobs 2`, live smoke probe; cached | Build + smoke pass; no hosted-runner engine build | L |
| W6.3 | `win/w6-gitlab-ci` | Mirror static gates in `.gitlab-ci.yml` so GitLab and GitHub report the same result | Both hosts green for the same SHA | M |
| W6.4 | `win/w6-linux-guard` | Keep `ubuntu-latest` jobs and add a `cfg(unix)`/Linux-path review checklist; no Windows-only change may edit Linux branches | Linux jobs green; diff review sign-off | S |

---

## 7. Verification matrix

| Layer | Windows command | Proves |
|---|---|---|
| Rust unit | `cargo test --workspace` | Domain logic, Windows test twins |
| Rust lint | `cargo fmt --check`, `cargo clippy --workspace --all-targets` | Style and correctness |
| UI types | `bun run --filter @astra/frame typecheck` | Svelte/TS |
| UI unit | `bun run --filter @astra/frame test` | 1,200+ unit tests |
| UI components | `bun run --filter @astra/frame test:component` | Browser components |
| UI build | `bun run --filter @astra/frame build:chrome` | Chrome bundle + CSP audit |
| Contracts | `node tests/contract/*.mjs`, `python tools/contract-runner/run.py --os windows` | Wire shapes and host contracts |
| Forge | `forge lint`, `forge footprint`, `forge import --check` | Patch health and budget |
| State/brand | `python tools/state-check.py`, `tools/brand-lint.sh` | Registry and naming |
| Live boot | `tools/marionette-probe/headed-probe.py` (Windows build) | Packaged chrome boots, app frame host mode |
| Surface probes | `tools/marionette-probe/*.py` made OS-aware | Tabs, spaces, windows, menus, downloads, media, passkeys, privacy |
| Perf | `tools/perf/windows/run_all.py` | Startup, memory, CPU, GPU, blocker |
| Linux | existing `ubuntu-latest` CI + code review | No Linux regression |

A probe exit code of 2 means "environment cannot run this", not a pass. Every
Windows probe must state the GPU adapter it used.

---

## 8. RAM reduction plan (measured, behavior-preserving)

| # | Hotspot | File | Change | Risk | Verification |
|---|---|---|---|---|---|
| 1 | IPC frame/queue ceilings | `crates/astra-ipc/src/config.rs` | Cap frame at 1 MiB; queues 128 -> 32; allocate body incrementally | Low | Chaos tests; large legitimate frame test |
| 2 | Untrusted length prefix | `crates/astra-core/src/bin/astra_core.rs`, `astra-proto/src/main.rs` | Reject `len > MAX_FRAME_BYTES` before `vec![0; len]` | Low | Fuzz/unit test |
| 3 | Unbounded outbound channel | `crates/astra-host-trait/src/gecko.rs` | Bounded channel + `try_send` backpressure for non-critical calls | Medium | Call-site tests; slow-transport test |
| 4 | Log redaction allocations | `crates/astra-core/src/logging.rs` | Single-pass scanner; reusable buffer; no per-marker `Vec` | Low | Existing log tests |
| 5 | Log rotation fail on Windows | `crates/astra-core/src/logging.rs` | Close -> rename -> reopen; retry on sharing violation | Low | Rotation test; file size cap |
| 6 | Log tail whole-file read | `crates/astra-core/src/diagnostics.rs` | Seek to last 64 KiB; read backwards | Low | Tail correctness test |
| 7 | Notes watcher leak | `crates/astra-notes/src/watch.rs` | Store/drop watcher; bound event channel | Low | Shutdown test; handle count |
| 8 | Notes 2 s full rescan/rehash | `crates/astra-notes/src/lib.rs`, `watch.rs` | mtime+size short-circuit; `HashMap` diff; Live mode event-driven with 60 s safety | Medium | External-write tests; idle RSS/CPU |
| 9 | Agent spawn 2 MiB stacks | `crates/astra-agents/src/handoff.rs` | 256 KiB stacks for helper threads | Low | Handoff tests |
| 10 | Agent pipe deadlock | `crates/astra-agents/src/tools/command.rs` | Drain stdout/stderr concurrently | High | >4 KiB output test; timeout test |
| 11 | Fresh MCP server per call | `crates/astra-agents/src/tools/mcp.rs` | Persistent child + request ids | Medium | MCP round-trip; idle process count |
| 12 | Audit record growth | `crates/astra-agents/src/audit.rs` | Ring buffer or spill-to-store | Low | Audit integrity test |
| 13 | Blocker list duplication | `blocker/src/lists.rs`, `lib.rs`, `seed.rs` | Move text instead of clone; rebuild on idle; serialize snapshot option | Medium | Rule-count/classify tests; peak RSS |
| 14 | Extension whole-package reads | `crates/astra-extensions/src/pipeline.rs` | Stream hash; in-place rewrites | Medium | Corpus tests; signature tests |
| 15 | Unbounded UI caches | `ui/app/**`, `ui/shell/**` | Bounded caches; release listeners/observers; lazy destinations | Medium | Bundle budget; per-window memory |
| 16 | Engine process defaults | overlay prefs / `mozilla.cfg` | Tune content-process count, `unloadOnLowMemory`, bfcache only after measurement | Medium | Live probes; no functional regression |
| 17 | Windows working-set tricks | none | Do **not** call `EmptyWorkingSet`/`SetProcessWorkingSetSize` as a "win" | n/a | Budget uses private commit |

Rule: every item ships only with a before/after number on the same fixture and
a test that proves the behavior is unchanged. If a change cannot be measured,
it does not claim a RAM reduction.

---

## 9. Branch, commit, merge and push protocol

### Branch model

- Integration branch: `windows-port`.
- Every task: `win/<phase>-<slug>` off the current `windows-port`.
- Plan/docs tasks: `docs/<slug>`.
- Merge back with `git merge --no-ff`, one task per merge.
- Never force-push. Never mix unrelated changes.

### Before starting a task

```sh
git fetch origin
git fetch github
git status --short --branch
git log -5 --oneline
```

If `origin/windows-port` and `github/windows-port` differ, stop and reconcile
before branching.

### Commit

- Conventional prefix: `feat(windows):`, `fix(windows):`, `build(windows):`,
  `test(windows):`, `docs(windows):`, `perf(windows):`.
- One logical change. Stage only the files in scope.
- Include the verification command and result in the commit body.
- Never commit secrets, `.env`, build outputs, `obj-*`, `target/`, profiles.

### Push to both hosts

`origin` already has two push URLs (GitLab + GitHub). Push with:

```sh
git push origin <branch>
git ls-remote --heads origin <branch>
git ls-remote --heads github <branch>
```

Report both SHAs. If one host fails, preserve the local commit, report the
per-host status, and do not claim synchronization.

### Merge and conflict resolution

1. Fetch both hosts.
2. Merge `windows-port` into the task branch; resolve only conflicts in the
   task's files.
3. Re-run the task's tests plus the contract/static gates.
4. Merge `--no-ff` into `windows-port`.
5. Push `windows-port` to both hosts.
6. Verify both tips match.

If `main` also moved, merge `main` into `windows-port` separately and re-run
the Linux static gates before pushing.

---

## 10. Risks and mitigations

| Risk | Trigger | Mitigation |
|---|---|---|
| Toolchain mismatch | `mach configure` cannot find clang-cl/SDK | `forge doctor --os windows` checks VS, SDK, clang-cl, MozillaBuild, make before build |
| Long paths / MAX_PATH | overlay copy or mach fails on a deep file | Registry long paths already on; git `core.longpaths=true`; short objdir on D: |
| Defender quarantines test files | missing file during build | Add documented exclusions; verify after install |
| CRLF corrupts patches/scripts | `git apply` rejects a patch; `setup.sh` bad interpreter | `.gitattributes` pins patches; `core.autocrlf=false`; LF re-checkout; CI check |
| gkrust LTO OOM | build killed during final link | Start `--jobs 2`; record peak commit; thin-LTO dev recipe only if needed; never raise without headroom |
| MSVC-only compile errors in patches | C++/Rust build failure | Fix behind `cfg(windows)`/`#ifdef`; keep Linux branch byte-identical |
| Blocker DNS link failure | unresolved `dlopen`/`dlsym` | Windows branch uses `dnsapi`; Linux keeps `libresolv` |
| Passkeys module crash | `@astra/passkeys;1` absent | Skip 0014 on Windows; guard host module; use Windows Hello |
| Native Firefox UI leaks | menu/dialog appears | Live suppression probe for every native surface; patch or remove the path |
| Sidecar `.exe` not found | `astra-core` lookup fails | `.exe` in shell, forge, packaging, probes; live Metadata check |
| Sidecar pipe deadlock | command output > 4 KiB | Concurrent drains; test with large output |
| User data corruption | WAL on network/OneDrive path | Local NTFS guard; single-instance mutex; WAL cleanup |
| Installer/admin policy | default browser or install requires admin | Per-user install; Windows Settings deep link for default; document policy limits |
| Signing unavailable | no Authenticode certificate | Ship unsigned dev builds only; do not claim SmartScreen trust; owner supplies cert |
| Linux regression | Windows-only edit touches shared path | `cfg`/`--os` isolation; Linux CI; diff review checklist |
| CI cost | self-hosted Windows engine runner | Static gates on hosted Windows; engine job nightly/self-hosted, cached sccache |

---

## 11. Reporting format

Every completed task reports:

```
Task: <ID + title>
Branch: <branch>
Commit: <sha>
Changed: <files>
Wiring: <UI control -> route -> host module -> engine/Rust API>
Verified: <commands + counts; live probe result + GPU adapter>
RAM: <before/after private commit and working set, fixture>
Linux: <why unchanged; CI result>
Pushed: GitLab <sha> / GitHub <sha> / tips match
Deferred: <none or exact gap>
```

No task is reported "done" from a compile alone.

---

## 12. Deferred items and owner inputs

| Item | Why deferred | Owner input needed |
|---|---|---|
| Authenticode certificate | No certificate on this machine | Certificate + password/HSM procedure |
| SmartScreen reputation | Follows signing and download history | Distribution plan |
| Updater | U-09: Mozilla Maintenance Service needs Mozilla signing; current build disables updater | Ship without updater, or approve per-user in-place MAR design |
| Windows 10 | Owner chose Win11 x64 first | Later milestone |
| ARM64 | Owner chose x64 first | Later milestone |
| Tray icon / global hotkey | Not an existing Astra surface on all platforms | Include in first Windows release or later |
| Windows reputation row semantics | UI exists; product behavior undefined | Exact meaning of "reputation managed" (Defender SmartScreen policy state?) |
| Windows Hello UX | Native prompt text/behavior is engine-owned | Confirm the Settings copy and private-window wording |
| Work/AI/Account | Build flags off (D-48) | Not part of this port |

---

## 13. Definition of done (Windows 11 x64)

A Windows release candidate is done when all of these are true:

- [ ] `forge doctor --os windows` green on a clean shell.
- [ ] `forge import --check`, `forge lint`, `forge footprint` green.
- [ ] Native engine build succeeds with `--jobs 2`; build time and peak commit recorded.
- [ ] `firefox.exe` launches, shows Astra chrome, and `data-app-booted=true`.
- [ ] `astra-core.exe` launches; `Metadata.status().available === true`; store survives restart.
- [ ] `cargo test --workspace` green on Windows; Linux tests unchanged.
- [ ] `bun run --filter @astra/frame check` green on Windows.
- [ ] Contract suites and `wire_coverage` green; no `unknown_command` for a visible control.
- [ ] Every listed surface has a live Marionette probe on the packaged build, and the probe is in the suite.
- [ ] No Firefox menu, dialog, window, tabbox or context menu answers an Astra action.
- [ ] Private windows and multi-window isolation probes pass.
- [ ] Passkeys work through Windows Hello; no Astra vault file is created.
- [ ] Portable zip and per-user installer install, run and uninstall on a clean profile.
- [ ] Authenticode-signed artifacts verify (when the certificate is available).
- [ ] Baseline vs stock Firefox table recorded; RAM budget met or each miss explained with evidence.
- [ ] Linux CI (brand, state, footprint, contracts, UI, Rust) still green; no Linux code path changed.
- [ ] `windows-port` and both remotes are in sync at the reported SHA.

---

## 14. Immediate next actions

1. **This plan** — `docs/windows-master-plan`, including D-51/SCOPE/STATE notes.
2. **W0.1 toolchain** — install MozillaBuild, verify VS components, Defender
   exclusions, git long paths, LF re-checkout; `forge doctor --os windows`.
3. **W0.2/W0.3 forge platform** — objdir on `D:\astra-build`, Windows command
   layer, `--os` plumbing, `\\?\` fix.
4. **W0.4 configure** — resolve every `TODO(windows-port)` and prove
   `mach configure`.
5. **W0.5 baseline build** — unpatched engine build, `--jobs 2`, sccache on D:.
6. Then W0.6/W0.7: patches, overlay, sidecar, first Astra boot.

The next task starts only after this plan is merged into `windows-port` and both
remotes are verified at the same SHA.
