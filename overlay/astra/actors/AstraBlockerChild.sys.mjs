/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Child half of the page blocker: injects the CSS selectors and scriptlet
// payload the engine returned for this document, then re-asks as new
// classes/ids appear. The parent performs the lookup; this module only
// touches the page. It owns one observer, one style element and one debounce
// timer per document, all released when the document goes away.

const STYLE_ID = "astra-blocker-style";
const MAX_SELECTORS = 4096;
const MAX_SEEN = 512;
const MAX_PROCEDURAL = 256;
const DEBOUNCE_MS = 500;

export class AstraBlockerChild extends JSWindowActorChild {
  #style = null;
  #observer = null;
  #timer = null;
  #url = "";
  #started = false;
  #seenClasses = new Set();
  #seenIds = new Set();
  #procedural = [];
  #scriptInjected = false;
  #request = 0;
  #refreshed = false;

  handleEvent(event) {
    if (event.type === "DOMContentLoaded") {
      void this.#start();
    }
  }

  didDestroy() {
    this.#stop();
  }

  #stop() {
    if (this.#timer !== null) {
      try {
        this.contentWindow?.clearTimeout(this.#timer);
      } catch {
        // The window is already gone.
      }
      this.#timer = null;
    }
    try {
      this.#observer?.disconnect();
    } catch {
      // The document went away with the observer.
    }
    this.#observer = null;
    this.#style = null;
    this.#started = false;
  }

  async #start() {
    if (this.#started) return;
    const doc = this.document;
    if (!doc || !doc.documentElement) return;
    this.#url = this.contentWindow?.location?.href ?? "";
    if (!/^https?:/iu.test(this.#url)) return;
    this.#started = true;

    const observed = collectObserved(doc);
    for (const name of observed.classes) this.#remember(this.#seenClasses, name);
    for (const name of observed.ids) this.#remember(this.#seenIds, name);
    const reply = await this.#ask([], []);
    if (!this.#started || !this.document) return;
    if (reply?.enabled === false) {
      // The blocker is off (or both cosmetic payloads are off): no observer,
      // no DOM walk, no per-mutation query.
      this.#started = false;
      return;
    }
    this.#apply(doc, reply);

    if (typeof this.contentWindow?.MutationObserver === "function") {
      this.#observer = new this.contentWindow.MutationObserver(() => {
        this.#schedule(doc);
      });
      this.#observer.observe(doc.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "id"],
      });
    }
    // The first walk already seeded the sets; reuse it instead of walking
    // the document a second time before the first generic query.
    if (observed.classes.length || observed.ids.length) {
      void this.#refresh(doc, observed);
    }
  }

  #schedule(doc) {
    if (this.#timer !== null) return;
    const timer = this.contentWindow?.setTimeout(() => {
      this.#timer = null;
      if (!this.#started) return;
      void this.#refresh(doc);
    }, DEBOUNCE_MS);
    if (timer !== undefined) this.#timer = timer;
  }

  async #refresh(doc, preObserved = null) {
    if (!doc || !this.#started) return;
    const observed = preObserved ?? collectObserved(doc);
    let fresh = false;
    for (const name of observed.classes) {
      if (this.#remember(this.#seenClasses, name)) fresh = true;
    }
    for (const name of observed.ids) {
      if (this.#remember(this.#seenIds, name)) fresh = true;
    }
    if (!fresh && this.#refreshed) {
      // Static CSS and scriptlets are already installed. Procedural actions
      // depend on the live DOM (`:has-text`, `:style`, `:remove`), so re-run
      // the cached set without another parent round-trip.
      this.#applyProcedural(doc);
      return;
    }
    if (this.#seenClasses.size === 0 && this.#seenIds.size === 0) return;
    this.#refreshed = true;
    const reply = await this.#ask([...this.#seenClasses], [...this.#seenIds]);
    if (!this.#started || !this.document) return;
    this.#apply(doc, reply);
  }

  /** Add one name to a bounded insertion-ordered set; true when new. */
  #remember(set, name) {
    if (!name || set.has(name)) return false;
    set.add(name);
    if (set.size > MAX_SEEN) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
    return true;
  }

  #applyProcedural(doc) {
    for (const action of this.#procedural) runProcedural(doc, action);
  }

  async #ask(classes, ids) {
    const generation = ++this.#request;
    try {
      const reply = await this.sendQuery("astra-blocker-cosmetic", {
        url: this.#url,
        classes,
        ids,
      });
      // A newer mutation batch superseded this one; its reply wins.
      return generation === this.#request ? reply : null;
    } catch {
      return null;
    }
  }

  #apply(doc, reply) {
    if (!doc || !reply) return;
    const selectors = Array.isArray(reply.selectors)
      ? reply.selectors.slice(0, MAX_SELECTORS)
      : [];
    const css = selectors
      .map((selector) => `${selector}{display:none!important;}`)
      .join("\n");
    if (css) {
      if (!this.#style || !this.#style.isConnected) {
        this.#style = doc.createElement("style");
        this.#style.id = STYLE_ID;
        this.#style.setAttribute("data-astra-blocker", "1");
        (doc.head || doc.documentElement).append(this.#style);
      }
      this.#style.textContent = css;
    } else if (this.#style) {
      this.#style.textContent = "";
    }

    if (
      !this.#scriptInjected &&
      typeof reply.script === "string" &&
      reply.script !== ""
    ) {
      this.#scriptInjected = true;
      injectScriptlet(this.contentWindow, reply.script, this.#url);
    }
    if (Array.isArray(reply.procedural) && reply.procedural.length > 0) {
      this.#procedural = reply.procedural.slice(0, MAX_PROCEDURAL);
    } else {
      this.#procedural = [];
    }
    this.#applyProcedural(doc);
  }
}

/** Classes and ids currently present, bounded. */
function collectObserved(doc) {
  const classes = new Set();
  const ids = new Set();
  let count = 0;
  const remember = (set, value) => {
    if (!value || set.has(value)) return;
    set.add(value);
    if (set.size > MAX_SEEN) set.delete(set.values().next().value);
  };
  const walk = (root) => {
    if (!root || count > 20000) return;
    // Only elements that can contribute a name; avoids allocating a NodeList
    // for every element on the page.
    const elements = root.querySelectorAll?.("[id],[class]") ?? [];
    for (const element of elements) {
      count += 1;
      if (count > 20000) break;
      if (element.id) remember(ids, element.id);
      const className = element.getAttribute?.("class");
      if (className) {
        for (const name of className.split(/\s+/u)) remember(classes, name);
      }
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(doc);
  return { classes: [...classes], ids: [...ids] };
}

/** Best-effort scriptlet injection into the page's own realm. */
function injectScriptlet(window, script, url) {
  try {
    const sandbox = Cu.Sandbox(window, {
      sandboxPrototype: window,
      wantXrays: false,
      sandboxName: "astra-blocker-scriptlet",
    });
    Cu.evalInSandbox(script, sandbox, "latest", url, 1);
  } catch {
    // A scriptlet that needs an unsupported helper fails alone; CSS and
    // network blocking are unaffected.
  }
}

/**
 * The engine returns procedural filters as JSON or as the normalized
 * `selector:action()` text. Support the common action subset; unknown
 * actions are ignored rather than throwing.
 */
function runProcedural(doc, action) {
  if (typeof action !== "string" || action.length > 8192) return;
  let selector = "";
  let style = "";
  let remove = false;
  let text = "";
  try {
    const parsed = JSON.parse(action);
    selector = typeof parsed.selector === "string" ? parsed.selector : "";
    if (Array.isArray(parsed.actions)) {
      for (const entry of parsed.actions) {
        if (entry?.type === "style" && typeof entry.value === "string") {
          style = entry.value;
        } else if (entry?.type === "remove") {
          remove = true;
        } else if (entry?.type === "has-text" && typeof entry.value === "string") {
          text = entry.value;
        }
      }
    }
  } catch {
    const clean = action;
    if (clean.endsWith(":remove()")) {
      selector = clean.slice(0, -":remove()".length);
      remove = true;
    } else {
      const styleMatch = clean.match(/^(.*):style\(([\s\S]*)\)$/u);
      if (styleMatch) {
        selector = styleMatch[1];
        style = styleMatch[2];
      } else {
        const textMatch = clean.match(/^(.*):has-text\((.*)\)$/u);
        if (textMatch) {
          selector = textMatch[1];
          text = textMatch[2].replace(/^["']|["']$/gu, "");
        } else {
          return;
        }
      }
    }
  }
  if (!selector) return;
  let elements = [];
  try {
    elements = [...doc.querySelectorAll(selector)];
  } catch {
    return;
  }
  if (text) {
    const needle = text.toLowerCase();
    elements = elements.filter((element) =>
      (element.textContent ?? "").toLowerCase().includes(needle),
    );
  }
  for (const element of elements.slice(0, 512)) {
    if (remove) {
      element.remove();
    } else if (style) {
      const [property, value] = style.split(/:(.+)/u);
      if (property && value) {
        try {
          element.style.setProperty(property.trim(), value.trim(), "important");
        } catch {
          // Invalid declaration; leave the element alone.
        }
      }
    } else {
      element.style.setProperty("display", "none", "important");
    }
  }
}
