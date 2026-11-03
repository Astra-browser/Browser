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
// - The chrome integration (`Permissions.install`) is the only place that
//   knows Firefox: it replaces the engine's own prompt for Astra tabs and
//   supplies the engine allow/cancel/persist closures.
//
// SECURITY - trust boundary:
// - The prompt token is the capability. `respond` requires the token plus the
//   exact profile/item the prompt was published for; anything else is refused
//   as `invalid_scope` and changes nothing.
// - A decision is single-shot: the record leaves the queue before the engine
//   is touched, so a replayed or double-clicked response cannot resolve twice.
// - Content never reaches this module. Only chrome-privileged code can call
//   `ask` with engine closures.
// - A failed durable write cancels the request instead of granting it, and the
//   operation is reported as rejected rather than applied.

import { emit } from "./Events.sys.mjs";
import { admit, refuse } from "./Operations.sys.mjs";

/** Astra prompt kinds the app can render. */
export const KINDS = new Set(["camera", "microphone", "geolocation"]);

/** Engine permission type -> Astra kind. */
export const KIND_BY_ENGINE_TYPE = {
  geolocation: "geolocation",
  camera: "camera",
  microphone: "microphone",
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

/** One on-screen prompt is bounded by the window's tab strip; the queue only
 *  exists so a request is never dropped on the floor. */
const MAX_QUEUE = 8;

const _records = new Map(); // prompt_id -> record
const _queue = []; // prompt_id, oldest first
let _revision = 0;
let _minted = 0;
let _sidebarHost = false;
let _view = { projection_revision: ZERO_REVISION, prompt: null };

function randomHex8() {
  return Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0")
    .slice(-8);
}

function mintPromptId() {
  _minted += 1;
  const counter = _minted.toString(16).padStart(8, "0").slice(-8);
  // Opaque echo fence: the app only ever hands this value back.
  return `${counter}${randomHex8()}${randomHex8()}${randomHex8()}`;
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
    blocked_by_system: false,
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
  if (record.browser && record.onPageHide) {
    try {
      record.browser.removeEventListener("pagehide", record.onPageHide, true);
    } catch {
      // The browser was already torn down with its window.
    }
  }
  record.browser = null;
  record.onPageHide = null;
}

/**
 * Publish one prompt for an engine permission request.
 *
 * `allow`/`cancel` resolve the engine request; `persist(allow, durable)` writes
 * the site decision and returns whether it landed. Both are supplied by the
 * chrome integration (or a stub in the contract test).
 */
export function ask({
  kind = "",
  origin = "",
  item_id = "",
  profile_id = "default",
  rememberable = true,
  allow = null,
  cancel = null,
  persist = null,
  principal = null,
  browser = null,
} = {}) {
  if (!KINDS.has(kind)) return null;
  if (typeof origin !== "string" || origin === "") return null;
  if (typeof item_id !== "string" || item_id === "") return null;
  // Never let an unbounded queue swallow a person's current request: drop the
  // oldest unrendered prompt and cancel it, so the engine is not left waiting.
  while (_queue.length >= MAX_QUEUE) {
    const oldest = _records.get(_queue[0]);
    if (!oldest) {
      _queue.shift();
      continue;
    }
    detach(oldest);
    try {
      oldest.cancel?.();
    } catch {
      // The request may already be gone with its document.
    }
  }
  const record = {
    prompt_id: mintPromptId(),
    kind,
    origin,
    item_id,
    profile_id: typeof profile_id === "string" && profile_id !== "" ? profile_id : "default",
    rememberable: rememberable === true,
    kinds: [kind],
    allow,
    cancel,
    persist,
    principal,
    browser: null,
    onPageHide: null,
  };
  _records.set(record.prompt_id, record);
  _queue.push(record.prompt_id);
  if (browser && typeof browser.addEventListener === "function") {
    // A prompt must never outlive its page. The engine usually cancels the
    // request with the document, but the Astra prompt is chrome state and has
    // to close on its own when the page hides.
    const onPageHide = () => {
      if (_records.get(record.prompt_id) !== record) return;
      detach(record);
      try {
        record.cancel?.();
      } catch {
        // Already cancelled with the document.
      }
      publish();
    };
    record.browser = browser;
    record.onPageHide = onPageHide;
    try {
      browser.addEventListener("pagehide", onPageHide, true);
    } catch {
      record.browser = null;
      record.onPageHide = null;
    }
  }
  publish();
  return record.prompt_id;
}

export const Permissions = {
  ask,

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
    const wantsAllow = ALLOW_DECISIONS.has(decision);

    // Single-shot: leave the queue before touching the engine.
    detach(record);

    let persisted = true;
    if (typeof record.persist === "function") {
      try {
        persisted = record.persist(wantsAllow, durable) === true;
      } catch {
        persisted = false;
      }
    } else if (durable) {
      // A durable decision with no store behind it is not a grant.
      persisted = false;
    }

    const effectiveAllow = wantsAllow && persisted;
    try {
      if (effectiveAllow) {
        record.allow?.();
      } else {
        // Denial, dismissal and a failed durable write all cancel: the engine
        // is never told "allow" for a decision we could not apply.
        record.cancel?.();
      }
    } catch {
      // The request went away with its document; the prompt still closes.
    }

    publish();

    if (!persisted) {
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
   * Chrome startup: replace the engine's own prompt for the kinds the app
   * renders, and leave every other permission on Firefox's path.
   *
   * Idempotent per process, because every browser window mounts the shell.
   */
  async install() {
    if (_installed) return true;
    if (typeof ChromeUtils === "undefined") return false;
    try {
      const { Integration } = ChromeUtils.importESModule(
        "resource://gre/modules/Integration.sys.mjs"
      );
      Integration.contentPermission.register((base) => ({
        createPermissionPrompt(type, request) {
          const kind = KIND_BY_ENGINE_TYPE[type];
          if (!kind) {
            return base.createPermissionPrompt(type, request);
          }
          return {
            prompt() {
              promptForRequest(kind, type, request);
            },
          };
        },
      }));
      _installed = true;
      return true;
    } catch {
      return false;
    }
  },

  /** Test-only: reset the prompt queue, revision and sidebar host. */
  __resetForTests() {
    for (const record of _records.values()) {
      detach(record);
    }
    _records.clear();
    _queue.length = 0;
    _revision = 0;
    _minted = 0;
    _sidebarHost = false;
    _view = { projection_revision: ZERO_REVISION, prompt: null };
    _installed = false;
  },
};

let _installed = false;

// --- Chrome-only engine glue -------------------------------------------------

function lazyModule(specifier, key) {
  if (typeof ChromeUtils === "undefined") return null;
  lazyModules[key] ??= ChromeUtils.importESModule(specifier)[key] ?? null;
  return lazyModules[key];
}

const lazyModules = {};

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

function persistPermission(record, allow, durable) {
  const SitePermissions = lazyModule(
    "resource:///modules/SitePermissions.sys.mjs",
    "SitePermissions"
  );
  if (!SitePermissions) return false;
  const name = ENGINE_PERMISSION_NAME[record.kind];
  if (!name) return false;
  try {
    SitePermissions.setForPrincipal(
      record.principal,
      name,
      allow ? SitePermissions.ALLOW : SitePermissions.BLOCK,
      durable ? SitePermissions.SCOPE_PERSISTENT : SitePermissions.SCOPE_TEMPORARY,
      record.browser ?? undefined
    );
    return true;
  } catch {
    return false;
  }
}

function promptForRequest(kind, type, request) {
  let browser = null;
  try {
    browser = request.element ?? request.window?.docShell?.chromeEventHandler ?? null;
  } catch {
    browser = null;
  }
  const win = browser?.ownerGlobal ?? browser?.ownerDocument?.defaultView ?? null;
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
    // Nothing to show or store: fail closed rather than let the request hang.
    try {
      request.cancel();
    } catch {
      // Already gone.
    }
    return;
  }
  // An existing policy answers without a prompt, exactly like the engine's own
  // PermissionPrompt.prompt() short-circuit.
  const state = sitePermissionState(principal, kind, browser);
  if (state === "block") {
    try {
      request.cancel();
    } catch {
      // Already gone.
    }
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
    try {
      request.cancel();
    } catch {
      // Already gone.
    }
    return;
  }

  const token = ask({
    kind,
    origin,
    item_id: tabIdForBrowser(browser),
    profile_id: profileForWindow(win),
    rememberable: !isPrivateWindow(win),
    principal,
    browser,
    allow: () => request.allow(),
    cancel: () => request.cancel(),
    persist: (allow, durable) => persistPermission({ kind, principal, browser }, allow, durable),
  });
  if (token === null) {
    // Unrenderable request: do not leave the engine waiting on a prompt that
    // does not exist.
    try {
      request.cancel();
    } catch {
      // Already gone.
    }
  }
}
