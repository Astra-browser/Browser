/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API ContentTools module (v1, P6-T03). The tool-facing side of page
// access: open/read/snapshot/screenshot/click/type/scroll over the tabs
// model, with the readability text and the accessibility tree as the
// read path. The Rust `browser_*` tools (`crates/astra-agents`) own names,
// schemas, and validation; this module owns live page access behind the
// versioned Host API seam (§6.4).
//
// Two access paths, one envelope:
//
//   1. In-content path (primary): the mounted `<browser>` from
//      `Content.sys.mjs`. Readability extraction and the a11y snapshot run
//      against the live document; screenshots mirror into the browser
//      element (`Content.applyZoom`/`printPage` precedent).
//   2. WebDriver BiDi fallback: when no mounted browser is reachable
//      (detached actor, headless harness), the shell drives
//      `browsingContext.captureScreenshot` and `Accessibility.getTree`
//      over the BiDi session. The fallback is injected here as `driver`
//      functions — this module never opens sockets itself.
//
// Both paths return the same envelope: `{ request_id, host_api_version }`
// plus the payload, or `{ ..., error: { code, message } }` on failure.
// Pure logic with injectable seams, so Node contract tests import by path.

import { emit as defaultEmit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;

const MAX_TEXT_CHARS = 8000;

// --- Injectable seams (live shell wires the real ones) -------------------
// `driver`: async page-access functions over the mounted browser:
//   open(url), read(), snapshot(), screenshot(), click(target),
//   type(target, text, submit), scroll(dx, dy, target).
// `bidi`: async WebDriver BiDi fallback with the same function names,
// tried only when `driver` is absent or throws `no_page`.
let _driver = null;
let _bidi = null;
let _emitSink = (type, data) => defaultEmit(type, data);

export function setDriver(driver) {
  _driver = driver;
}

export function setBidiFallback(bidi) {
  _bidi = bidi;
}

export function setEventSink(fn) {
  _emitSink = fn;
}

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function isHttpUrl(url) {
  return typeof url === "string" && /^(https?):\/\//i.test(url);
}

// Run `op(...args)` against the driver, falling back to BiDi on absence
// or `no_page`. Driver faults keep their `code:` prefix so callers can
// tell `invalid_url` from `no_page`; unexpected throws become `failed`.
async function via(request_id, op, ...args) {
  const attempts = [_driver, _bidi];
  let lastError = null;
  for (const backend of attempts) {
    if (!backend || typeof backend[op] !== "function") {
      continue;
    }
    try {
      return { value: await backend[op](...args) };
    } catch (e) {
      lastError = e;
      const message = e && e.message ? String(e.message) : String(e);
      // Only `no_page` (nothing mounted) falls through to BiDi; every
      // other fault belongs to the backend that raised it.
      if (!message.startsWith("no_page")) {
        return { failure: failureOf(request_id, message) };
      }
    }
  }
  if (lastError) {
    const message =
      lastError && lastError.message ? String(lastError.message) : String(lastError);
    return { failure: failureOf(request_id, message) };
  }
  return { failure: err(request_id, "no_backend", `ContentTools.${op} has no driver or BiDi fallback`) };
}

function failureOf(request_id, message) {
  const code = message.includes(":") ? message.split(":")[0].trim() : "failed";
  return err(request_id, code || "failed", message);
}

function cappedText(text) {
  const str = String(text ?? "");
  if (str.length <= MAX_TEXT_CHARS) {
    return { text: str, truncated: false };
  }
  return { text: `${str.slice(0, MAX_TEXT_CHARS)}…[truncated]`, truncated: true };
}

export const ContentTools = {
  // Navigate the selected tab to an http(s) URL.
  async open({ request_id = "content-open", url = "" } = {}) {
    if (!isHttpUrl(url)) {
      return err(request_id, "invalid_url", "open requires an http(s) URL");
    }
    const out = await via(request_id, "open", url);
    if (out.failure) {
      return out.failure;
    }
    _emitSink("content-tools.opened", { request_id, url: out.value });
    return ok(request_id, { url: out.value });
  },

  // Readability text + title for the current page (capped).
  async read({ request_id = "content-read", max_chars = MAX_TEXT_CHARS } = {}) {
    const out = await via(request_id, "read");
    if (out.failure) {
      return out.failure;
    }
    const cap = Number.isFinite(max_chars) && max_chars > 0 ? Math.floor(max_chars) : MAX_TEXT_CHARS;
    const page = out.value ?? {};
    const { text, truncated } = cappedText(page.text ?? "");
    return ok(request_id, {
      url: page.url ?? "",
      title: page.title ?? "",
      text: text.slice(0, cap),
      snapshot_ref: page.snapshot_ref ?? "",
      truncated: truncated || String(page.text ?? "").length > cap,
    });
  },

  // Accessibility tree snapshot (JSON string) for the current page.
  async snapshot({ request_id = "content-snapshot" } = {}) {
    const out = await via(request_id, "snapshot");
    if (out.failure) {
      return out.failure;
    }
    return ok(request_id, { snapshot: typeof out.value === "string" ? out.value : JSON.stringify(out.value) });
  },

  // Screenshot metadata. Raw pixels stay with the shell (canvas preview);
  // the envelope carries bytes + dimensions only — never image data, so
  // envelopes are safe to log and audit.
  async screenshot({ request_id = "content-screenshot" } = {}) {
    const out = await via(request_id, "screenshot");
    if (out.failure) {
      return out.failure;
    }
    const shot = out.value ?? {};
    return ok(request_id, {
      bytes: shot.bytes ?? 0,
      width: shot.width ?? 0,
      height: shot.height ?? 0,
    });
  },

  // Click an element by a11y ref or CSS selector.
  async click({ request_id = "content-click", target = "" } = {}) {
    if (typeof target !== "string" || target.trim() === "") {
      return err(request_id, "invalid_target", "click requires a target");
    }
    const out = await via(request_id, "click", target);
    if (out.failure) {
      return out.failure;
    }
    return ok(request_id, { clicked: out.value ?? target });
  },

  // Type text into an element, optionally submitting (Enter) afterwards.
  async type({ request_id = "content-type", target = "", text = "", submit = false } = {}) {
    if (typeof target !== "string" || target.trim() === "") {
      return err(request_id, "invalid_target", "type requires a target");
    }
    if (typeof text !== "string") {
      return err(request_id, "invalid_text", "type requires a text string");
    }
    const out = await via(request_id, "type", target, text, Boolean(submit));
    if (out.failure) {
      return out.failure;
    }
    return ok(request_id, { typed: out.value ?? target, submit: Boolean(submit) });
  },

  // Scroll the viewport (or one element) by CSS-pixel deltas.
  async scroll({ request_id = "content-scroll", dx = 0, dy = 0, target = null } = {}) {
    const out = await via(request_id, "scroll", Number(dx) || 0, Number(dy) || 0, target ?? undefined);
    if (out.failure) {
      return out.failure;
    }
    return ok(request_id, { scrolled: out.value ?? `${Number(dx) || 0},${Number(dy) || 0}` });
  },
};

// Test-only reset: clears injected driver/BiDi so contract tests start clean.
export function __resetForTests() {
  _driver = null;
  _bidi = null;
}
