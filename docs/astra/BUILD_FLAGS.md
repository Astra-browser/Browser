# Build flags — Linux (P1-T02)

Every flag from plan F-05 re-verified against the **pinned source**
(`engine/`, ESR 153.6.0) and the **official build docs**. F-05 was written
from fork precedent (Tor/Mullvad); three entries needed correction. This file
is the correction record.

## Build requirements (official docs, verified 2026-11-01)

| Requirement | Official docs | Pinned source | This machine | Verdict |
|---|---|---|---|---|
| RAM ≥ 4 GB (8+ rec.) | [linux_build.html](https://firefox-source-docs.mozilla.org/setup/linux_build.html): "4GB minimum, 8GB+ recommended" | `engine/docs/setup/linux_build.rst` (same text) | 31 GiB | OK |
| Disk ≥ 30 GB free | same page: "At least 30GB" | same file | 158 GiB free on `/home` | OK |
| 64-bit Linux | same page | same file | x86_64 | OK |
| Python ≥ 3.9 | in-tree `linux_build.rst`: "Python of version 3.9 or later" (live site now says 3.10+ for `main`; ESR 153 pins 3.9) | `engine/docs/setup/linux_build.rst` | 3.14.8 | OK |
| Rust ≥ 1.90.0 | toolchain pins via bootstrap | `engine/python/mozboot/mozboot/util.py: MINIMUM_RUST_VERSION = "1.90.0"`; `engine/Cargo.toml: rust-version = "1.90.0"` | 1.99.1 | OK |
| mozconfig layout | [configuring_build_options.rst](https://firefox-source-docs.mozilla.org/setup/configuring_build_options.html) (`mk_add_options MOZ_OBJDIR`, `ac_add_options`, `export VAR=`) | `engine/docs/setup/configuring_build_options.rst` | `config/mozconfig.linux` follows it | OK |

Note: the live site tracks `main`; where it differs from the pinned ESR
(e.g. Python 3.10+ vs 3.9+), **the in-tree doc wins** — it ships with the
exact source we build.

## Flag verification (all paths relative to `engine/`)

| Plan flag | Status | Evidence |
|---|---|---|
| `MOZ_TELEMETRY_REPORTING=` (empty) | VERIFIED, used | `option(env="MOZ_TELEMETRY_REPORTING", …)` at `toolkit/moz.configure:1124`; empty env → `NegativeOptionValue` (`python/mozbuild/mozbuild/configure/options.py:454-456`) |
| `MOZ_DATA_REPORTING` | CORRECTION — **not a flag**. Derived output: `data_reporting()` ORs telemetry/healthreport/crashreporter/normandy (`toolkit/moz.configure:3494-3507`). Disabling the four inputs turns it off automatically. Not set in mozconfig. | `toolkit/moz.configure:3494-3507` |
| `MOZ_NORMANDY=False` | CORRECTION — **not settable from mozconfig**. `project_flag("MOZ_NORMANDY")` allows only `possible_origins=("implied",)` (`build/moz.configure/util.configure:522-529`); `browser/moz.configure:10` implies it True. Env assignment `=False` would be truthy-or-error, never disable (`options.py:454-460`). Neutralise via policy/pref in P1-T06. | `util.configure:522-529`, `browser/moz.configure:10`, `options.py:454-460` |
| `MOZ_SERVICES_HEALTHREPORT=False` | CORRECTION — same as Normandy. `project_flag` origins `("implied",)`; implied True by `browser/moz.configure:6`. P1-T06 prefs, not mozconfig. | `util.configure:522-529`, `browser/moz.configure:6` |
| `--disable-updater` | VERIFIED, used | `option("--enable-updater", …)` at `build/moz.configure/update-programs.configure:33-40`; `--disable-` form is the auto-generated negation (`options.py:449-452`) |
| `--disable-crashreporter` | VERIFIED, used | `option("--enable-crashreporter", …)` at `toolkit/moz.configure:3475-3482`; negation per `options.py:449-452` |
| `--disable-parental-controls` | VERIFIED, used (literal) | `toolkit/moz.configure:3640` |
| `--disable-backgroundtasks` | VERIFIED, used (literal) | `toolkit/moz.configure:3167` |
| `--disable-legacy-profile-creation` | VERIFIED, used (literal) | `toolkit/moz.configure:4244` |
| `--enable-geckodriver` | VERIFIED, used | `toolkit/moz.configure:1401-1413`, comment explicitly allows `--enable-geckodriver` override |
| `MOZ_BRANDING_DIRECTORY` (custom dir) | CORRECTION — **not settable from mozconfig**. `confvar` allows only `origins=("confvars",)` (`util.configure:552-568`); default comes from `browser/confvars.sh` (`MOZ_BRANDING_DIRECTORY=browser/branding/unofficial`). Custom dir is selected with the verified `--with-branding=DIR` option (`toolkit/moz.configure:3238`). mozconfig uses `--with-branding=astra/branding` (lands P1-T03; `--branding unofficial` fallback until then). | `util.configure:552-568`, `toolkit/moz.configure:3222-3270`, `browser/confvars.sh` |
| `MOZ_APPUPDATE_HOST` (F-07 Ghostery precedent) | CORRECTION — **absent from ESR 153**. No match in `toolkit/moz.configure`, `browser/moz.configure`, or `toolkit/mozapps/update/`. Update URLs now come from branding prefs (`app.update.url.*`, see `browser/app/profile/firefox.js:156-158`). D-16 stands; the mechanism is branding prefs in P1-T03, not a build flag. | grep ∅; `firefox.js:156-158` |

## Normandy / Health Report disable path (P1-T06, recorded here so the gap is tracked)

mozconfig cannot unset the two implied flags, so P1-T06 must set (names to
verify against the pinned tree at that time): `app.normandy.enabled=false`,
`app.shield.optoutstudies.enabled=false`, `datareporting.healthreport.uploadEnabled=false`,
plus `policies.json` `DisableTelemetry`/`DisableFirefoxStudies`. The endpoint
audit (P1-T07) is the gate that proves the combination works.

## Configure proof (2026-11-01, `engine/`, ESR 153.6.0)

`forge config --os linux --branding unofficial` →
`export MOZCONFIG=$PWD/out/mozconfig.linux` → `./mach configure`:
**`Configure complete!`** (2694 moz.build files, backends generated).

`obj-astra-linux/config.status` confirms the flag effects:

- absent (disabled): `MOZ_TELEMETRY_REPORTING`, `MOZ_CRASHREPORTER`, `MOZ_UPDATER`
- still `1` (implied True, need P1-T06 prefs): `MOZ_NORMANDY`, `MOZ_SERVICES_HEALTHREPORT`, `MOZ_DATA_REPORTING`
- `MOZ_BRANDING_DIRECTORY = browser/branding/unofficial` (fallback; `astra/branding` lands P1-T03)

With `--branding astra` (default render) configure correctly refuses to
proceed — `engine/astra/branding/moz.build` does not exist yet — which is the
documented P1-T03 dependency, not a flag error.

## `forge` coverage

- `forge config --os linux [--branding astra|unofficial]` renders
  `config/mozconfig.linux` → `out/mozconfig.linux` (substitutes
  `@ASTRA_BRANDING_DIR@`, `@ASTRA_DISPLAY_NAME@`, `@ASTRA_BINARY_NAME@`).
- `forge doctor` re-checks every `ac_add_options`/`export` line of the
  template against the pinned source and fails on unknown flags.
- Full-configure proof is P1-T04 (`./mach configure` + first build).
