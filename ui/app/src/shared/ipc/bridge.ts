/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// App wiring for `@astra/bridge` (P2-T08). Owns bridge selection per UI
// surface: Firefox chrome dispatches Appendix C envelopes to the Host API
// (`overlay/astra/host/*.sys.mjs`, loaded via `resource://astra/...` like
// `ui/shell/src/host.js`); standalone (goldens/dev, `http(s)`/`file`,
// `resource:` in a plain tab, `chrome:`/`about:`, or `?astra-mock=1`) uses
// the in-memory MOCK host. Call `ensureBridge(label)`
// once per entry surface (`browser`/`panel`/`onboarding`); UI code then
// imports Tauri-shaped `invoke`/`listen` from `@astra/bridge` instead of
// `@tauri-apps/api/*` (see `bindings.ts`, still generated).

import type { HostModules } from "@astra/bridge";
import { configureBridge, createHostDispatch, getBridge, setWindowLabel } from "@astra/bridge";
import type { Bridge } from "@astra/bridge";

async function loadHostModules(): Promise<HostModules> {
  return (await import(
    /* @vite-ignore */ "resource://astra/host/HostAPI.sys.mjs"
  )) as unknown as HostModules;
}

// Schemes that always take the in-memory MOCK host. `http(s)`/`file` cover
// goldens, `bun run dev` and static previews; `resource:`/`about:` cover the
// packaged page opened in a plain content tab (no chrome privilege, so the
// `resource://astra/host` import above would throw instead of booting
// cleanly). `chrome:` is NOT here: the packaged app is a first-party chrome
// document (P3-T21) and imports the Host API directly.
const STANDALONE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "file:",
  "resource:",
  "about:",
]);

/** True outside Firefox chrome: goldens, `bun run dev`, static previews. */
export function isStandalone(query = ""): boolean {
  if (query.includes("astra-mock=1")) return true;
  try {
    return STANDALONE_PROTOCOLS.has(window.location.protocol);
  } catch {
    return true;
  }
}

let ensuredFor: string | null = null;

/**
 * Configure the process-wide bridge for one surface. Idempotent per label;
 * re-call with a different label (or after `resetBridge`) to switch.
 */
export async function ensureBridge(surfaceLabel: string, query = ""): Promise<Bridge> {
  setWindowLabel(surfaceLabel);
  if (ensuredFor === surfaceLabel) return getBridge();
  if (isStandalone(query)) {
    ensuredFor = surfaceLabel;
    return configureBridge({ mode: "mock" });
  }
  const host = await loadHostModules();
  const bridge = configureBridge({
    mode: "host",
    dispatch: createHostDispatch(host, (event) => {
      bridge.ingestEvent(event.type, event.data, `evt-${event.event_seq}`, event.event_seq);
    }),
  });
  ensuredFor = surfaceLabel;
  return bridge;
}

/** Test-only: forget the ensured surface so tests can re-configure. */
export function __resetBridgeWiringForTests(): void {
  ensuredFor = null;
}
