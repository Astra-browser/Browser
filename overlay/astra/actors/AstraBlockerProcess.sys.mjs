/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Process-level half of the blocker's page work.
//
// The window actor is created and destroyed with each document, and its
// earliest event (`DOMWindowCreated`) can arrive before its module is ready
// in a freshly spawned content process. This actor lives as long as the
// process, so it can:
//   * hold the scriptlet payload the parent computes at request time, and
//   * inject it from `document-element-inserted`, which fires before the
//     parser runs the document's first script.
// It also owns the one injection per document, so the window actor can ask it
// for CSS without injecting a second time.

const MAX_ENTRIES = 4;

// uBlock Origin's scriptlets read this harness object. adblock-rust ships the
// scriptlet bodies and their helpers, not the object that publishes the
// per-frame values, so the injector provides it. Without it every scriptlet
// throws `ReferenceError: scriptletGlobals is not defined` inside the engine's
// own `try { ... } catch {}` wrapper.
//
// The aliases make the payload run against the page's own realm. A chrome
// sandbox otherwise exposes the page through a WindowProxy and its own
// intrinsics: traps land in the Xray expando (invisible to page scripts) and
// `x instanceof Object` is false for page objects, which silently breaks every
// nested chain (`set-constant`, JSON pruning).
const SCRIPTLET_GLOBALS = (() => {
  const lines = [
    "const scriptletGlobals = {};",
    "const window = __astraPageWindow;",
    "const self = __astraPageWindow;",
    "const globalThis = __astraPageWindow;",
  ];
  const names = [
    "Object",
    "Array",
    "Boolean",
    "Date",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "Function",
    "JSON",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Proxy",
    "Reflect",
    "RegExp",
    "String",
    "Number",
    "BigInt",
    "Symbol",
    "Math",
    "Intl",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "Event",
    "CustomEvent",
    "EventTarget",
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "Document",
    "Element",
    "Node",
    "HTMLElement",
    "XMLHttpRequest",
    "fetch",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "performance",
    "navigator",
    "location",
    "document",
    "localStorage",
    "sessionStorage",
    "BroadcastChannel",
    "Worker",
    "Blob",
    "atob",
    "btoa",
    "structuredClone",
    "queueMicrotask",
  ];
  for (const name of names) {
    lines.push(`const ${name} = window[${JSON.stringify(name)}];`);
  }
  return `${lines.join("\n")}\n`;
})();

function injectScriptlet(window, script, url) {
  try {
    const sandbox = Cu.Sandbox(window, {
      sandboxPrototype: window,
      wantXrays: false,
      sandboxName: "astra-blocker-scriptlet",
    });
    sandbox.__astraPageWindow = window.wrappedJSObject ?? window;
    Cu.evalInSandbox(SCRIPTLET_GLOBALS + script, sandbox, "latest", url, 1);
    return true;
  } catch {
    // A scriptlet that needs an unsupported helper fails alone; CSS and
    // network blocking are unaffected.
    return false;
  }
}

function urlKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export class AstraBlockerProcessChild extends JSProcessActorChild {
  #prefetched = new Map();
  #injected = new WeakSet();

  actorCreated() {
    try {
      Services.obs.addObserver(this, "document-element-inserted");
    } catch {
      // The observer service is unavailable; the window actor still injects.
    }
  }

  observe(subject, topic) {
    if (topic !== "document-element-inserted") return;
    let doc;
    try {
      doc = subject.QueryInterface(Ci.nsIDocument);
    } catch {
      return;
    }
    const href = doc.location?.href ?? "";
    if (!/^https?:/iu.test(href)) return;
    const payload = this.#payloadFor(href);
    if (!payload || typeof payload.script !== "string") return;
    this.inject(doc, payload.script, href);
  }

  /** Inject once per document; returns whether this call did the injection. */
  inject(doc, script, url) {
    if (!doc || typeof script !== "string" || script === "") return false;
    if (this.#injected.has(doc)) return false;
    const window = doc.defaultView;
    if (!window) return false;
    const ok = injectScriptlet(window, script, url);
    if (ok) this.#injected.add(doc);
    return ok;
  }

  /** The payload the window actor uses for its CSS and procedural pass. */
  take(url) {
    return this.#take(url) ?? null;
  }

  #payloadFor(url) {
    const exact = this.#prefetched.get(url);
    if (exact) return exact;
    const wanted = urlKey(url);
    for (const [candidate, value] of this.#prefetched) {
      if (urlKey(candidate) === wanted) return value;
    }
    return null;
  }

  #take(url) {
    const payload = this.#payloadFor(url);
    if (!payload) return null;
    this.#prefetched.delete(url);
    for (const candidate of [...this.#prefetched.keys()]) {
      if (urlKey(candidate) === urlKey(url)) this.#prefetched.delete(candidate);
    }
    return payload;
  }

  receiveMessage(message) {
    if (message.name !== "astra-blocker-prefetch") return undefined;
    const data = message.data ?? {};
    if (typeof data.url !== "string" || !data.payload) return undefined;
    this.#prefetched.set(data.url, data.payload);
    if (this.#prefetched.size > MAX_ENTRIES) {
      this.#prefetched.delete(this.#prefetched.keys().next().value);
    }
    return undefined;
  }
}
