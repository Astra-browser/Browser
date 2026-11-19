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

/**
 * The window's Host API instance.
 *
 * `resource://` ES modules are per document, so importing here would give the
 * app a second tab model while the shell owns the content browser: a
 * navigation would commit into a model nothing listens to, and the stage
 * would stay blank. The shell publishes its instance on `Services`, the
 * per-process singleton both chrome documents share. A top-level surface
 * (standalone, goldens) has no `Services` and imports its own.
 */
async function loadHostModules(): Promise<HostModules> {
  try {
    const services = (
      window as unknown as {
        Services?: {
          astraHost?: HostModules;
          astraHosts?: WeakMap<Window, HostModules>;
        };
      }
    ).Services;
    const keyed = services?.astraHosts?.get?.(window) ?? services?.astraHosts?.get?.(window.parent);
    if (keyed) return keyed;
    if (services?.astraHost) return services.astraHost;
  } catch {
    // No Services: fall through to this document's own import.
  }
  return (await import(
    /* @vite-ignore */ "resource://astra/host/HostAPI.sys.mjs"
  )) as unknown as HostModules;
}

/** The shell's namespace for the request/response relay. */
const SHELL_NS = "astra-shell";

/** True when this document is the app frame inside the browser window. */
export function framedInShell(): boolean {
  try {
    // A parent window means this document is the app frame; a top-level page
    // (standalone preview, goldens, a plain tab) has none. `frameElement` is
    // not reliable for chrome documents, so the parent itself decides.
    return window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * The window's Host API, reached over the frame relay.
 *
 * `resource://` modules are per document, so importing here would give the app
 * its own tab model while the shell owns the content browser — navigations
 * would commit into a model nothing is listening to and the stage would stay
 * blank. Expando properties do not cross compartments either, so every call is
 * a message to the shell and every event is posted back.
 */
function relayHost(): HostModules {
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let next = 0;
  window.addEventListener("message", (event) => {
    const data = event.data as {
      ns?: string;
      kind?: string;
      id?: string;
      payload?: unknown;
      error?: { message?: string };
    } | null;
    if (!data || data.ns !== SHELL_NS || data.kind !== "res" || typeof data.id !== "string") return;
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(data.error.message ?? "host error"));
    else waiter.resolve(data.payload);
  });
  const call = (moduleName: string, method: string) => (args: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const id = `relay-${++next}`;
      pending.set(id, { resolve, reject });
      try {
        const ds = document.documentElement.dataset;
        if (!ds.astraPost) {
          ds.astraPost = String(Math.round(performance.now()));
          ds.astraPostName = `${moduleName}.${method}`;
        }
      } catch {
        // Diagnostics only.
      }
      window.parent.postMessage(
        { ns: SHELL_NS, kind: "req", id, module: moduleName, method, args },
        "*",
      );
    });
  const moduleProxy = (moduleName: string) =>
    new Proxy(
      {},
      {
        get: (_target, method) =>
          typeof method === "string" ? call(moduleName, method) : undefined,
      },
    );
  return new Proxy(
    {
      addEventListener: () => () => {},
      eventSeq: () => 0,
    } as unknown as HostModules,
    {
      get: (target, prop) => {
        if (prop === "addEventListener" || prop === "eventSeq") {
          return (target as unknown as Record<string, unknown>)[prop as string];
        }
        return typeof prop === "string" ? moduleProxy(prop) : undefined;
      },
    },
  );
}

// Schemes that always take the in-memory MOCK host. `http(s)`/`file` cover
// goldens, `bun run dev` and static previews; `resource:`/`about:` cover the
// packaged page opened in a plain content tab (no chrome privilege, so the
// `resource://astra/host` import above would throw instead of booting
// cleanly). `chrome:` is NOT here: the packaged app is a first-party chrome
// document (P3-T21) and imports the Host API directly.
const STANDALONE_PROTOCOLS = new Set(["http:", "https:", "file:", "resource:", "about:"]);

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
  const framed = framedInShell();
  try {
    document.documentElement.dataset.bridgeMode = framed ? "relay" : "direct";
  } catch {
    // Diagnostics only.
  }
  const bridge = framed
    ? configureBridge({ mode: "host", dispatch: createHostDispatch(relayHost()) })
    : configureBridge({
        mode: "host",
        dispatch: createHostDispatch(await loadHostModules(), (event) => {
          bridge.ingestEvent(event.type, event.data, `evt-${event.event_seq}`, event.event_seq);
        }),
      });
  if (framed) {
    // Events arrive from the shell over the same relay.
    window.addEventListener("message", (event) => {
      const data = event.data as {
        ns?: string;
        kind?: string;
        type?: string;
        data?: unknown;
        seq?: number;
      } | null;
      if (!data || data.ns !== SHELL_NS || data.kind !== "evt" || typeof data.type !== "string")
        return;
      bridge.ingestEvent(data.type, data.data, `evt-${data.seq ?? 0}`, data.seq);
    });
  }
  ensuredFor = surfaceLabel;
  return bridge;
}

/** Test-only: forget the ensured surface so tests can re-configure. */
export function __resetBridgeWiringForTests(): void {
  ensuredFor = null;
}
