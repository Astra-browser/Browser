/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Permissions module (P6b). A page permission request becomes an
// Astra prompt: chrome publishes `page-permission-prompt-changed`, the app's
// existing PagePermissionPrompt answers it with `page_permission_respond`,
// and only this module resolves the engine request.
//
// Division of labour:
// - This module owns the prompt state machine (queue, stale fences, revision,
//   decision validation, settlement admission). It is pure logic and imports
//   in Node, so the contract test exercises the exact chrome behaviour.
// - `install()` is the only place that knows Firefox: it registers one
//   process-wide `Integration.contentPermission` override and routes each
//   request to the host instance of the window that owns the tab.
//
// SECURITY - trust boundary:
// - The prompt token plus the exact profile/item is the capability. `respond`
//   requires all three; anything else is refused as `invalid_scope` and
//   changes nothing.
// - A decision is single-shot: the record leaves the queue before the engine
//   is touched, so a replayed or double-clicked response cannot resolve twice.
// - A prompt is fenced to the document it was raised for. When the browser
//   navigates or the tab closes, the prompt is cancelled, and `respond` also
//   refuses a request whose document already changed.
// - Content never reaches this module. Only chrome-privileged code can call
//   `ask` with engine closures.
// - A failed durable write cancels the request instead of granting it, and the
//   operation is reported as rejected rather than applied.

import { emit } from "./Events.sys.mjs";
import { admit, refuse } from "./Operations.sys.mjs";

/** The page permissions the Astra prompt renders. Camera and microphone use
 *  Camera/microphone arrive through the WebRTC actor (`askForWebRTC`), not the
 *  `Integration.contentPermission` seam; both settle into this same queue. */
export const KINDS = new Set(["geolocation", "camera", "microphone"]);

/** Engine permission type -> Astra kind (the `contentPermission` seam). */
export const KIND_BY_ENGINE_TYPE = {
  geolocation: "geolocation",
};

/** Astra kind -> `SitePermissions` / `Services.perms` name. */
export const ENGINE_PERMISSION_NAME = {
  geolocation: "geo",
  camera: "camera",
  microphone: "microphone",
};

const DECISIONS = new Set([
  "allow_once",
  "always_allow",
  "deny_once",
  "always_deny",
  "dismiss",
]);

const ALLOW_DECISIONS = new Set(["allow_once", "always_allow"]);
const DURABLE_DECISIONS = new Set(["always_allow", "always_deny"]);

/** Same fixed-width shape as every other projection revision, so the app's
 *  lexicographic admission test is correct. */
const ZERO_REVISION = "00000000000000000000000000000000";

/** One prompt is on screen; the queue only exists so a request is never
 *  dropped on the floor. Overflow cancels the *incoming* request, never the
 *  prompt a person is already looking at. */
const MAX_QUEUE = 8;

/** Process-wide registry of window -> host instance, stored on the shared
 *  IntegrationPoint so every `resource://` document instance sees it. */
const REGISTRY = Symbol.for("astra.permissions.windows");

const _records = new Map(); // prompt_id -> record
const _queue = []; // prompt_id, oldest first
let _revision = 0;
let _minted = 0;
let _sidebarHost = false;
let _view = { projection_revision: ZERO_REVISION, prompt: null };

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mintPromptId() {
  _minted += 1;
  const counter = _minted.toString(16).padStart(8, "0").slice(-8);
  // Opaque echo fence: the app only ever hands this value back.
  return `${counter}${randomHex(12)}`;
}

function mintRevision() {
  _revision += 1;
  return _revision.toString(16).padStart(32, "0").slice(-32);
}

function publicPrompt(record) {
  return {
    profile_id: record.profile_id,
    item_id: record.item_id,
    request_id: record.prompt_id,
    origin: record.origin,
    kinds: record.kinds.slice(),
    rememberable: record.rememberable,
    processing: false,
    in_sidebar: _sidebarHost,
    blocked_by_system: record.blocked_by_system === true,
  };
}

function publish() {
  while (_queue.length > 0 && !_records.has(_queue[0])) {
    _queue.shift();
  }
  const head = _queue.length > 0 ? _records.get(_queue[0]) : null;
  _view = {
    projection_revision: mintRevision(),
    prompt: head ? publicPrompt(head) : null,
  };
  emit("page-permission-prompt-changed", _view);
  return _view;
}

function detach(record) {
  const index = _queue.indexOf(record.prompt_id);
  if (index >= 0) _queue.splice(index, 1);
  _records.delete(record.prompt_id);
  try {
    record.release?.();
  } catch {
    // The window or browser was already torn down.
  }
  record.release = null;
}

/** Close the prompt when its document goes away, for remote tabs too:
 *  `pagehide` on the `<browser>` is not delivered to chrome for every tab. */
function watchDocument(record, browser) {
  const releases = [];
  const close = () => {
    if (_records.get(record.prompt_id) !== record) return;
    detach(record);
    try {
      record.cancel?.();
    } catch {
      // Already cancelled with the document.
    }
    publish();
  };

  try {
    const progress = browser.webProgress;
    if (progress && typeof progress.addProgressListener === "function") {
      const listener = {
        QueryInterface:
          typeof ChromeUtils !== "undefined"
            ? ChromeUtils.generateQI([
                "nsIWebProgressListener",
                "nsISupportsWeakReference",
              ])
            : undefined,
        onLocationChange() {
          close();
        },
        onStateChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };
      const flags =
        typeof Ci !== "undefined" ? Ci.nsIWebProgress.NOTIFY_LOCATION : 0;
      progress.addProgressListener(listener, flags);
      releases.push(() => {
        try {
          progress.removeProgressListener(listener);
        } catch {
          // Already gone with the window.
        }
      });
    }
  } catch {
    // No progress listener: respond's own liveness check still fences it.
  }

  try {
    // A remote `<browser>` has no `ownerGlobal`; the document still reaches
    // the window that owns the tab.
    const win = browser.ownerGlobal ?? browser.ownerDocument?.defaultView ?? null;
    const container = win?.gBrowser?.tabContainer;
    if (container && typeof container.addEventListener === "function") {
      const onTabClose = (event) => {
        if (event?.target?.linkedBrowser === browser) close();
      };
      container.addEventListener("TabClose", onTabClose);
      releases.push(() => {
        try {
          container.removeEventListener("TabClose", onTabClose);
        } catch {
          // Already gone with the window.
        }
      });
    }
  } catch {
    // No tab container in a preview DOM.
  }

  record.release = () => {
    for (const release of releases) release();
  };
}

/**
 * Publish one prompt for an engine permission request.
 *
 * `allow`/`cancel` resolve the engine request; `persist(allow, durable)` writes
 * the site decision and returns whether it landed; `rollback()` removes a
 * durable decision the engine could not accept; `blocked_by_system` mirrors
 * the operating-system block the engine reported.
 */
export function ask({
  kind = "",
  kinds = null,
  call_id = "",
  origin = "",
  item_id = "",
  profile_id = "default",
  rememberable = false,
  allow = null,
  cancel = null,
  persist = null,
  rollback = null,
  principal = null,
  browser = null,
  blocked_by_system = false,
} = {}) {
  const list =
    Array.isArray(kinds) && kinds.length > 0 ? kinds.slice() : kind ? [kind] : [];
  if (list.length === 0) return null;
  if (list.some((entry) => !KINDS.has(entry))) return null;
  if (typeof origin !== "string" || origin === "") return null;
  if (typeof item_id !== "string" || item_id === "") return null;
  if (_queue.length >= MAX_QUEUE) {
    // The caller cancels this request; the visible prompt is untouched.
    return null;
  }
  const record = {
    prompt_id: mintPromptId(),
    kind: list[0],
    kinds: list,
    call_id: typeof call_id === "string" ? call_id : "",
    origin,
    item_id,
    profile_id: typeof profile_id === "string" && profile_id !== "" ? profile_id : "default",
    rememberable: rememberable === true,
    blocked_by_system: blocked_by_system === true,
    allow,
    cancel,
    persist,
    rollback,
    principal,
    browser: null,
    release: null,
    loaded_spec: "",
  };
  if (browser) {
    try {
      record.loaded_spec = browser.currentURI?.spec ?? "";
    } catch {
      record.loaded_spec = "";
    }
    record.browser = browser;
    watchDocument(record, browser);
  }
  _records.set(record.prompt_id, record);
  _queue.push(record.prompt_id);
  publish();
  return record.prompt_id;
}

/** True when the prompt still belongs to the document it was raised for. */
function documentIsCurrent(record) {
  const browser = record.browser;
  if (!browser || record.loaded_spec === "") return true;
  try {
    const spec = browser.currentURI?.spec ?? "";
    return spec === "" || spec === record.loaded_spec;
  } catch {
    return false;
  }
}

function sharedServices() {
  try {
    return typeof Services !== "undefined" && Services ? Services : null;
  } catch {
    return null;
  }
}

/** Restorable view of each kind's current policy, before an Astra write. */
function capturePermissionStates(kinds, principal, browser) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return null;
  const states = [];
  for (const kind of kinds) {
    const name = ENGINE_PERMISSION_NAME[kind];
    if (!name) return null;
    try {
      const { state, scope } = SitePermissions.getForPrincipal(principal, name, browser);
      states.push({ principal, browser, name, state, scope });
    } catch {
      return null;
    }
  }
  return states;
}

function writePermissionStates(states, allow, durable) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return false;
  const state = allow ? SitePermissions.ALLOW : SitePermissions.BLOCK;
  const scope = durable ? SitePermissions.SCOPE_PERSISTENT : SitePermissions.SCOPE_TEMPORARY;
  try {
    for (const entry of states) {
      SitePermissions.setForPrincipal(
        entry.principal,
        entry.name,
        state,
        scope,
        entry.browser
      );
    }
    return true;
  } catch {
    return false;
  }
}

function restorePermissionStates(states) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return;
  for (const entry of states) {
    try {
      if (entry.state === SitePermissions.ALLOW || entry.state === SitePermissions.BLOCK) {
        SitePermissions.setForPrincipal(
          entry.principal,
          entry.name,
          entry.state,
          entry.scope ?? SitePermissions.SCOPE_PERSISTENT,
          entry.browser
        );
      } else {
        SitePermissions.removeFromPrincipal(entry.principal, entry.name, entry.browser);
      }
    } catch {
      // Best effort: the request is already settled either way.
    }
  }
}

/**
 * WebRTC entry point (P6b-2). The engine actor owns device selection and the
 * actual `webrtc:Allow`/`webrtc:Deny`; this publishes the Astra prompt and
 * hands the decision back through `grant`/`deny`.
 *
 * Returns true when Astra owns the request, false when the engine should keep
 * its own prompt.
 */
export function askForWebRTC({
  browser = null,
  principal = null,
  origin = "",
  callID = "",
  kinds = [],
  isAllowed = null,
  grant = null,
  deny = null,
} = {}) {
  const list = Array.isArray(kinds) ? kinds.filter((kind) => KINDS.has(kind)) : [];
  if (!browser || !principal || list.length === 0) return false;
  if (typeof origin !== "string" || origin === "") return false;
  try {
    if (!(principal.URI instanceof Ci.nsIStandardURL)) return false;
    if (!principal.schemeIs("http") && !principal.schemeIs("https")) return false;
    if (principal.addonPolicy) return false;
  } catch {
    return false;
  }
  const win =
    browser.ownerDocument?.defaultView ?? browser.ownerGlobal ?? null;
  if (!win) return false;
  let tabId = "";
  try {
    tabId =
      win.gBrowser?.getTabForBrowser?.(browser)?.getAttribute?.("astra-tab-id") ?? "";
  } catch {
    tabId = "";
  }
  // Only Astra's own tabs: an engine-internal browser keeps Firefox's prompt.
  if (tabId === "") return false;
  if (typeof isAllowed === "function") {
    try {
      if (isAllowed() === true) return true;
    } catch {
      // Fall through to Astra's prompt.
    }
  }

  let prior = null;
  let settled = false;
  const denyOnce = (noOSPermission = false) => {
    if (settled) return;
    settled = true;
    try {
      deny?.(noOSPermission === true);
    } catch {
      // The request already went away.
    }
  };
  const persist = (allow, durable) => {
    if (prior === null) {
      prior = capturePermissionStates(list, principal, browser);
    }
    if (prior === null) return false;
    const ok = writePermissionStates(prior, allow, durable);
    if (!ok) restorePermissionStates(prior);
    return ok;
  };
  const rollback = () => {
    if (prior !== null) restorePermissionStates(prior);
  };

  const token = ask({
    kind: list[0],
    kinds: list,
    call_id: callID,
    origin,
    item_id: tabId,
    profile_id: profileForWindow(win),
    rememberable: !isPrivateWindow(win),
    principal,
    browser,
    persist,
    rollback,
    allow: () => {
      if (settled) return;
      settled = true;
      Promise.resolve()
        .then(() => grant?.())
        .catch(() => {
          try {
            deny?.(false);
          } catch {
            // Already gone.
          }
        });
    },
    cancel: () => denyOnce(false),
  });
  if (token === null) {
    // Never fall back to the native prompt once Astra owns the request.
    denyOnce(false);
  }
  return true;
}

/** A page that goes away cancels its pending WebRTC prompt. */
export function cancelWebRTC(callID, browser = null) {
  if (typeof callID !== "string" || callID === "") return false;
  for (const record of [..._records.values()]) {
    if (record.call_id !== callID) continue;
    if (browser && record.browser && record.browser !== browser) continue;
    detach(record);
    try {
      record.cancel?.();
    } catch {
      // Already cancelled with the document.
    }
    publish();
    return true;
  }
  return false;
}

export const Permissions = {
  ask,
  askForWebRTC,
  cancelWebRTC,

  /**
   * Answer the prompt on screen. Returns an OperationAdmission; the terminal
   * disposition arrives through the Operations ledger.
   */
  async respond({ prompt_id = "", profile_id = "", item_id = "", decision = "" } = {}) {
    const record = _records.get(prompt_id);
    if (!record) {
      // Missing, already answered or evicted: a stale fence, not an error the
      // person can act on. Nothing is resolved a second time.
      return refuse("invalid_scope");
    }
    if (record.profile_id !== profile_id || record.item_id !== item_id) {
      return refuse("invalid_scope");
    }
    if (!DECISIONS.has(decision)) {
      return refuse("invalid_input");
    }
    const durable = DURABLE_DECISIONS.has(decision);
    if (durable && !record.rememberable) {
      // Ephemeral contexts must not receive a durable policy; the app does not
      // offer one, and chrome refuses it if it arrives anyway.
      return refuse("invalid_scope");
    }
    if (!documentIsCurrent(record)) {
      // The page navigated while the prompt was up. A late answer belongs to
      // a document that is gone; settle the engine if the listener did not.
      detach(record);
      try {
        record.cancel?.();
      } catch {
        // Already cancelled with the document.
      }
      publish();
      return refuse("invalid_scope");
    }
    const wantsAllow = ALLOW_DECISIONS.has(decision);

    // Single-shot: leave the queue before touching the engine.
    detach(record);

    // `dismiss` decides nothing: it closes the prompt and cancels this one
    // request without recording a block for the site.
    let stored = true;
    if (decision !== "dismiss") {
      if (typeof record.persist === "function") {
        try {
          stored = record.persist(wantsAllow, durable) !== false;
        } catch {
          stored = false;
        }
      } else if (durable) {
        // A durable decision with no store behind it is not a grant.
        stored = false;
      }
    }

    const effectiveAllow = wantsAllow && stored;
    let resolved = true;
    try {
      if (effectiveAllow) {
        record.allow?.();
      } else {
        // Denial, dismissal and a failed durable write all cancel: the engine
        // is never told "allow" for a decision we could not apply.
        record.cancel?.();
      }
    } catch {
      // The request went away with its document.
      resolved = false;
    }

    publish();

    if (!resolved) {
      if (durable && stored) {
        // Undo a durable decision the engine never observed.
        try {
          record.rollback?.();
        } catch {
          // Best effort; the disposition already says it is unverified.
        }
      }
      return admit({ outcome: "rejected", reason: "store_outcome_unknown" });
    }
    if (!stored) {
      return admit({ outcome: "rejected", reason: "store_admission_rejected" });
    }
    if (decision === "dismiss") {
      return admit({ outcome: "no_op", reason: "state_unchanged" });
    }
    return admit({ outcome: "applied", reason: "mutation_applied" });
  },

  /** The expanded sidebar reports whether its inline card host is on screen. */
  async cardHost({ available = false } = {}) {
    _sidebarHost = available === true;
    const head = _queue.length > 0 ? _records.get(_queue[0]) : null;
    if (head) {
      // Re-publish so the open prompt moves between the card and the sheet.
      publish();
    }
  },

  /** The projection the app should be showing. */
  current() {
    return {
      projection_revision: _view.projection_revision,
      prompt: _view.prompt ? { ..._view.prompt, kinds: _view.prompt.kinds.slice() } : null,
    };
  },

  /** Re-announce the open prompt, e.g. when the app frame finished loading. */
  republish() {
    if (_view.prompt) publish();
  },

  /** Test/diagnostic view of what is waiting, oldest first. */
  pending() {
    return _queue
      .map((id) => _records.get(id))
      .filter(Boolean)
      .map((record) => ({
        prompt_id: record.prompt_id,
        item_id: record.item_id,
        origin: record.origin,
        kind: record.kind,
      }));
  },

  /**
   * Chrome startup: register one process-wide override and route each request
   * to the host instance of the window that owns the tab. Idempotent, and a
   * closed window falls back to the engine's own prompt instead of a dead
   * event pump.
   */
  async install({ window: win = null } = {}) {
    if (typeof ChromeUtils === "undefined") return false;
    let point = null;
    try {
      const { Integration } = ChromeUtils.importESModule(
        "resource://gre/modules/Integration.sys.mjs"
      );
      point = Integration.contentPermission;
    } catch {
      return false;
    }
    if (!point) return false;
    if (!point[REGISTRY]) {
      const registry = new Map();
      point[REGISTRY] = registry;
      try {
        point.register((base) => ({
          createPermissionPrompt(type, request) {
            const kind = KIND_BY_ENGINE_TYPE[type];
            if (!kind) {
              return base.createPermissionPrompt(type, request);
            }
            const owner = browserWindowFor(request);
            const entry = owner ? registry.get(owner) : null;
            if (!entry) {
              // No Astra window owns this tab: keep the engine's own prompt.
              return base.createPermissionPrompt(type, request);
            }
            return {
              prompt() {
                entry.promptForRequest(kind, type, request);
              },
            };
          },
        }));
      } catch {
        delete point[REGISTRY];
        return false;
      }
    }
    if (win) {
      point[REGISTRY].set(win, { promptForRequest });
      // The WebRTC actor runs in the shared parent module loader, so it cannot
      // import this per-window instance. Publish the window's entry instead;
      // the actor looks it up by the requesting browser's window.
      const shared = sharedServices();
      if (shared) {
        if (typeof shared.astraPermissionWindows?.get !== "function") {
          shared.astraPermissionWindows = new Map();
        }
        shared.astraPermissionWindows.set(win, { askForWebRTC, cancelWebRTC });
        try {
          win.addEventListener(
            "unload",
            () => void Permissions.uninstall({ window: win }),
            { once: true }
          );
        } catch {
          // A preview DOM without a window.
        }
      }
    }
    return true;
  },

  /** A closing window leaves the registry, so its prompts stop being routed. */
  async uninstall({ window: win = null } = {}) {
    if (!win || typeof ChromeUtils === "undefined") return;
    try {
      const { Integration } = ChromeUtils.importESModule(
        "resource://gre/modules/Integration.sys.mjs"
      );
      Integration.contentPermission[REGISTRY]?.delete(win);
    } catch {
      // The process is already gone.
    }
    try {
      sharedServices()?.astraPermissionWindows?.delete(win);
    } catch {
      // Already gone with the window.
    }
    // Settle this window's engine requests instead of leaving them waiting.
    for (const record of [..._records.values()]) {
      const recordWin =
        record.browser?.ownerDocument?.defaultView ?? record.browser?.ownerGlobal ?? null;
      if (recordWin !== win) continue;
      detach(record);
      try {
        record.cancel?.();
      } catch {
        // Already gone with the window.
      }
    }
    publish();
  },

  /** Test-only: reset the prompt queue, revision and sidebar host. */
  __resetForTests() {
    for (const record of [..._records.values()]) {
      detach(record);
    }
    try {
      sharedServices()?.astraPermissionWindows?.clear();
    } catch {
      // No shared Services in a Node test.
    }
    _records.clear();
    _queue.length = 0;
    _revision = 0;
    _minted = 0;
    _sidebarHost = false;
    _view = { projection_revision: ZERO_REVISION, prompt: null };
  },
};

// --- Chrome-only engine glue -------------------------------------------------

const lazyModules = {};

function lazyModule(specifier, key) {
  if (typeof ChromeUtils === "undefined") return null;
  lazyModules[key] ??= ChromeUtils.importESModule(specifier)[key] ?? null;
  return lazyModules[key];
}

function isPrivateWindow(win) {
  const PrivateBrowsingUtils = lazyModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    "PrivateBrowsingUtils"
  );
  try {
    return PrivateBrowsingUtils ? PrivateBrowsingUtils.isWindowPrivate(win) === true : false;
  } catch {
    return false;
  }
}

function profileForWindow(win) {
  return isPrivateWindow(win) ? "incognito" : "default";
}

function browserForRequest(request) {
  try {
    return request.element ?? request.window?.docShell?.chromeEventHandler ?? null;
  } catch {
    return null;
  }
}

function browserWindowFor(request) {
  const browser = browserForRequest(request);
  try {
    return browser?.ownerGlobal ?? browser?.ownerDocument?.defaultView ?? null;
  } catch {
    return null;
  }
}

function tabIdForBrowser(browser) {
  try {
    const win = browser?.ownerGlobal ?? browser?.ownerDocument?.defaultView ?? null;
    const tab = win?.gBrowser?.getTabForBrowser?.(browser) ?? null;
    const id = tab?.getAttribute?.("astra-tab-id") ?? "";
    if (typeof id === "string" && id !== "") return id;
  } catch {
    // Fall through to a stable native identity.
  }
  // A browser that is not (yet) an Astra tab still needs a prompt; key it by
  // the engine's own id so a stale response cannot hit another tab.
  const nativeId = browser?.browserId;
  return nativeId !== undefined && nativeId !== null ? `native-${nativeId}` : "native-0";
}

function sitePermissionState(principal, kind, browser) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return "";
  const name = ENGINE_PERMISSION_NAME[kind];
  try {
    const { state } = SitePermissions.getForPrincipal(principal, name, browser);
    if (state === SitePermissions.BLOCK) return "block";
    if (state === SitePermissions.ALLOW) return "allow";
  } catch {
    // An unreadable policy falls through to the prompt.
  }
  return "";
}

function persistPermission(kind, principal, browser, allow, durable) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return false;
  const name = ENGINE_PERMISSION_NAME[kind];
  if (!name) return false;
  try {
    SitePermissions.setForPrincipal(
      principal,
      name,
      allow ? SitePermissions.ALLOW : SitePermissions.BLOCK,
      durable ? SitePermissions.SCOPE_PERSISTENT : SitePermissions.SCOPE_TEMPORARY,
      browser ?? undefined
    );
    return true;
  } catch {
    return false;
  }
}

function removePermission(kind, principal, browser) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  const name = ENGINE_PERMISSION_NAME[kind];
  if (!SitePermissions || !name) return;
  try {
    SitePermissions.removeFromPrincipal(principal, name, browser ?? undefined);
  } catch {
    // Already removed with the window.
  }
}

/** Geoposition is shared with the site, not just granted: the toolbar and the
 *  site panel read this state, and "Stop sharing" clears it. */
function setGeoSharing(browser, sharing) {
  try {
    // Remote browsers expose the window through their document, not
    // `ownerGlobal`.
    const win = browser?.ownerGlobal ?? browser?.ownerDocument?.defaultView ?? null;
    win?.gBrowser?.updateBrowserSharing?.(browser, { geo: sharing === true });
  } catch {
    // No tabbrowser in a preview DOM.
  }
  if (!sharing) return;
  try {
    const host = browser?.currentURI?.host;
    if (!host) return;
    const { ContentPrefService2 } = ChromeUtils.importESModule(
      "resource://gre/modules/ContentPrefService2.sys.mjs"
    );
    ContentPrefService2.set(
      host,
      "permissions.geoLocation.lastAccess",
      new Date().toString(),
      browser.loadContext
    );
  } catch {
    // The timestamp is a nicety; the grant already happened.
  }
}

function systemBlocked(request) {
  try {
    const option = request.types
      .QueryInterface(Ci.nsIArray)
      .queryElementAt(0, Ci.nsIContentPermissionType).options?.[0];
    return option === "sysdlg" || option === "syssetting";
  } catch {
    return false;
  }
}

function cancelQuietly(request) {
  try {
    request.cancel();
  } catch {
    // Already gone.
  }
}

function promptForRequest(kind, type, request) {
  const browser = browserForRequest(request);
  if (!browser) {
    // Fail closed: without an owning browser there is no Astra tab to fence
    // the prompt to, and no window to render it in.
    cancelQuietly(request);
    return;
  }
  const win = browser.ownerGlobal ?? browser.ownerDocument?.defaultView ?? null;
  let principal = null;
  try {
    principal = request.getDelegatePrincipal(type);
  } catch {
    try {
      principal = request.principal ?? null;
    } catch {
      principal = null;
    }
  }
  if (!principal) {
    cancelQuietly(request);
    return;
  }
  // The engine's own prompts ignore non-standard URLs; a permission written
  // for an opaque origin would follow the person around.
  try {
    if (!(principal.URI instanceof Ci.nsIStandardURL)) {
      cancelQuietly(request);
      return;
    }
  } catch {
    cancelQuietly(request);
    return;
  }
  // An existing policy answers without a prompt, exactly like the engine's own
  // PermissionPrompt.prompt() short-circuit.
  const state = sitePermissionState(principal, kind, browser);
  if (state === "block") {
    cancelQuietly(request);
    return;
  }
  let delegatedUnsafe = false;
  try {
    delegatedUnsafe = request.isRequestDelegatedToUnsafeThirdParty === true;
  } catch {
    delegatedUnsafe = false;
  }
  if (state === "allow" && !delegatedUnsafe) {
    try {
      request.allow();
    } catch {
      // Already gone.
    }
    return;
  }

  const origin = principal.origin || principal.URI?.spec || "";
  if (origin === "") {
    cancelQuietly(request);
    return;
  }

  const token = ask({
    kind,
    origin,
    item_id: tabIdForBrowser(browser),
    profile_id: profileForWindow(win),
    // An unsafe third-party delegate must not be granted a durable policy for
    // an embedding page the person cannot see in this prompt.
    rememberable: !isPrivateWindow(win) && !delegatedUnsafe,
    blocked_by_system: systemBlocked(request),
    principal,
    browser,
    allow: () => {
      setGeoSharing(browser, true);
      request.allow();
    },
    cancel: () => {
      setGeoSharing(browser, false);
      request.cancel();
    },
    persist: (allow, durable) => persistPermission(kind, principal, browser, allow, durable),
    rollback: () => removePermission(kind, principal, browser),
  });
  if (token === null) {
    // Unrenderable or over the queue bound: do not leave the engine waiting.
    cancelQuietly(request);
  }
}
