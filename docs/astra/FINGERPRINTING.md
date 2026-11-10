# Fingerprinting and tracking protection

> Status: **live** (D-43, 2026-11-07). Tracker blocking itself is the Astra
> blocker (`docs/astra/BLOCKER.md`); this document covers the additional
> browser-wide fingerprinting defence.

## What is on

| Layer | Pref | Default | What it does |
|---|---|---|---|
| FPP | `privacy.fingerprintingProtection` (+ `.pbmode`) | on | Firefox's low-breakage fingerprinting protection: canvas/audio randomization, font visibility, GPU model hiding, screen/hardware-concurrency tiering |
| FPP targets | `privacy.fingerprintingProtection.overrides` | `+WebGLRenderInfo,+WebGLRenderCapability,+WebGLVendorSanitize,+WebGLRendererConstant,+WebGLRandomization,+AudioContext,+AudioSampleRate,+MediaCapabilities,+MediaDevices,+MediaError,+NetworkConnection,+FontVisibilityBaseSystem,+CSSResolution,+CSSDeviceSize,+CSSColorInfo,+FrameRate,+WebCodecs,+WebGPULimits,+WebGPUIsFallbackAdapter,+WebGPUSubgroupSizes,+VideoElementMozFrames,+VideoElementMozFrameDelay,+VideoElementPlaybackQuality` | Strengthens the default set: hides the GPU model, capabilities and rendered pixels, audio stack parameters, media/network capabilities and device labels, base-system fonts, display metrics, frame rate, WebCodecs/WebGPU limits and video playback statistics |
| Native tracking lists | `privacy.trackingprotection.{,pb,cryptomining,fingerprinting,emailtracking}enabled` | on | Defence in depth next to Astra's filter engine: ETP's Disconnect list, cryptominer and fingerprinting lists, and email tracking-pixel stripping in webmail. The site shield writes a `trackingprotection` permission so pausing a site restores it |
| Query stripping | `privacy.query_stripping.{enabled,enabled.pbmode,strip_on_share.enabled}` | on | The engine's maintained tracking-parameter set is stripped before the first request and when a link is shared, alongside the blocker's `$removeparam` |
| Referrer trimming | `network.http.referer.{trimmingPolicy,XOriginTrimmingPolicy}` | `2` | Same-origin requests drop the path; cross-origin requests send only the origin, removing a common cross-site identifier |
| Cookies | `network.cookie.cookieBehavior` | `5` (upstream app default) | Third-party cookies blocked |
| RFP | `privacy.resistFingerprinting` | **off** | Full strict spoofing (screen, DPR, canvas per call, GPU); opt-in because it breaks layouts and some sites |

Astra sets these with `defaultPref()` in `overlay/astra/mozilla.cfg`, so a user
value (including the Settings switch) wins on every restart. `pref()` would
have written a user value on every boot and silently reset the switch.

## Settings

Privacy → **Fingerprinting protection** has three levels and two independent
spoofs (live in `ProtectionControls`/`PrivacyControls`):

| Control | Native value |
|---|---|
| Off | `privacy.fingerprintingProtection=false` |
| Standard | FPP on with the strengthened target set below |
| Aggressive | FPP on with canvas/audio/WebGL/font/display **and** screen/window/locale targets |
| Language fingerprinting | adds `+JSLocale,+JSLocalePrompt`, sets `intl.accept_languages=en-US, en`, and overrides `Accept-Language` on requests |
| Screen fingerprinting | adds `+ScreenRect,+ScreenAvailRect,+ScreenPixelDepth,+WindowOuterSize,+WindowScreenXY,+WindowInnerScreenXY,+RoundWindowSize,+MouseEventScreenPoint` |
| Per-site (shield menu) | `privacy.fingerprintingProtection.granularOverrides` with `{firstPartyDomain, overrides}`: `-AllTargets` (off), the standard set, or `+AllTargets` (aggressive) |

Turning protection off leaves the filter lists and cookie policy untouched;
native tracking protection is not forced on by Astra. The per-site entry is
removed when the person chooses Default.

## Verified surfaces (packaged dev build, 2026-11-07)

`tools/marionette-probe/fingerprint-probe.py` launches the packaged build twice
with a local page: once with defaults, once with
`privacy.fingerprintingProtection=false` as the control.

| Surface | Default (FPP) | Control (FPP off) | Result |
|---|---|---|---|
| Canvas output | `9a86e6d7c4828f0f` (session-randomized) | `3d58f904bf22ffd9` | randomized |
| WebGL / unmasked renderer | `Mozilla` | `Intel(R) HD Graphics, or similar` | GPU model hidden |
| `navigator.hardwareConcurrency` | `8` | `16` | tiered |
| User agent | Linux Firefox 153 | Linux Firefox 153 | **not** spoofed (site compatibility) |
| Timezone | `Asia/Kolkata` | `Asia/Kolkata` | **not** spoofed |
| Screen | 1920×1080 | 1920×1080 | **not** spoofed |

RFP remains an opt-in; when enabled in a test profile it additionally
randomized the canvas per call, forced `dpr=2`, `hardwareConcurrency=4` and a
constant WebGL renderer. It is not the default because the screen spoofing
(`25×25` in the headless probe) breaks real layouts.

The 2026-11-10 hardening added the capability/pixel/WebGPU/WebCodecs/media
targets listed above plus native tracking lists, query stripping and referrer
trimming. The target set and every pref are asserted by
`tests/contract/blocker_coverage.mjs`; the live `fingerprint-probe.py` and
`shields-probe.py` still pass on the packaged build, and the full
`superadblock-probe.py` run is 100% with zero reachable probes. The new media
and WebGPU targets are contract-checked, not individually measured by the
probe; they are FPP's own documented targets and keep the user agent,
timezone and screen real.

## What this does not claim

- It does not make a browser unlinkable. It removes the cheap, high-entropy
  surfaces (canvas, GPU, fonts, audio, display metrics) while keeping sites
  working; a determined fingerprinter can still combine remaining signals.
- The user agent and timezone stay real by design. Use RFP if full spoofing is
  more important than site compatibility.
- No remote FPP override service is required for these targets; the override
  list is shipped as a pref.
