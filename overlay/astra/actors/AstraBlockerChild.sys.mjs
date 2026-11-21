/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Child half of the page blocker: injects the CSS selectors the engine
// returned for this document, then re-asks as new classes/ids appear. The
// parent performs the lookup; this module only touches the page. It owns one
// observer, one agent sheet (or a fallback style node) and one throttle timer
// per document, all released when the document goes away. Scriptlet injection
// is delegated to the long-lived process actor (`AstraBlockerProcess`), which
// can run it before the parser executes the document's first script.

const STYLE_ID = "astra-blocker-style";
const MAX_SELECTORS = 4096;
const MAX_SHEET_CHUNK = 120_000;
const MAX_SEEN = 512;
const MAX_PROCEDURAL = 256;
const MAX_MUTATION_NODES = 2048;
// Minimum spacing between two parent lookups for one document. A batch that
// brings a class/id the document has never shown is answered immediately
// instead -- that is new information, and an ad container injected after load
// must be hidden on the frame it appears -- up to this many times per
// document; after that the floor bounds the cost of a page that mints new
// class names forever.
const REFRESH_FLOOR_MS = 500;
const IMMEDIATE_BATCHES = 32;
const PROCESS_ACTOR = "AstraBlockerProcess";

export class AstraBlockerChild extends JSWindowActorChild {
  #style = null;
  #observer = null;
  #timer = null;
  #sheetUris = [];
  #sheetCss = "";
  #url = "";
  #document = null;
  #started = false;
  #seenClasses = new Set();
  #seenIds = new Set();
  #pendingClasses = new Set();
  #pendingIds = new Set();
  #lastRefresh = 0;
  #immediate = IMMEDIATE_BATCHES;
  #procedural = [];
  #scriptInjected = false;
  #request = 0;
  #refreshed = false;
  #observerAttached = false;
  #lastCss = "";

  handleEvent(event) {
    const doc = this.document;
    if (!doc) return;
    // The actor lives as long as the window global, and a window global can
    // host several documents (same-origin navigation, bfcache restore). Every
    // document owns its own CSS sheet, observer, timer, seen names and
    // scriptlet, so a document change starts from a clean slate.
    if (doc !== this.#document) {
      this.#releaseDocument();
      this.#document = doc;
    }
    if (!this.#started) {
      // DOMWindowCreated is the earliest document event; the scriptlet itself
      // is injected by the process actor, which does not depend on this
      // per-document actor being ready in time.
      void this.#start(doc);
      return;
    }
    if (event.type === "DOMContentLoaded" || event.type === "load") {
      // A very early start may have run before the root element existed; the
      // observer and the initial walk belong here.
      this.#observe(doc);
    } else if (event.type === "pageshow") {
      this.#observe(doc);
      // A bfcache restore keeps the same document and its state; re-run the
      // live-DOM actions so a page that came back matches the current DOM.
      this.#applyProcedural(doc);
    }
  }

  didDestroy() {
    this.#releaseDocument();
    this.#document = null;
  }

  #releaseDocument() {
    this.#stop();
    this.#seenClasses.clear();
    this.#seenIds.clear();
    this.#procedural = [];
    this.#scriptInjected = false;
    this.#refreshed = false;
    this.#observerAttached = false;
    this.#lastCss = "";
    this.#request = 0;
    this.#url = "";
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
    this.#dropSheets();
    this.#sheetCss = "";
    this.#pendingClasses.clear();
    this.#pendingIds.clear();
    this.#lastRefresh = 0;
    this.#immediate = IMMEDIATE_BATCHES;
    this.#started = false;
  }

  async #start(doc) {
    if (this.#started || !doc) return;
    const href = doc.location?.href ?? "";
    if (!/^https?:/iu.test(href)) return;
    this.#started = true;
    this.#url = href;

    // The parent computes the scriptlet payload when the top-level request
    // starts and hands it to the content process. Reading it here is
    // synchronous, so the scriptlet is in the page before its first inline
    // script; without it the async lookup below is still complete, just later.
    let prefetched = null;
    try {
      prefetched =
        ChromeUtils.domProcessChild?.getActor(PROCESS_ACTOR)?.take(href) ??
        null;
    } catch {
      prefetched = null;
    }
    if (prefetched) {
      this.#apply(doc, prefetched);
      this.#observe(doc);
      return;
    }

    const reply = await this.#ask([], []);
    if (!this.#started || this.document !== doc) return;
    if (reply?.enabled === false) {
      // The blocker is off (or both cosmetic payloads are off): no observer,
      // no DOM walk, no per-mutation query.
      this.#started = false;
      return;
    }
    this.#apply(doc, reply);
    this.#observe(doc);
  }

  /** Attach the observer and do the first walk once the root element exists. */
  #observe(doc) {
    if (!doc || !doc.documentElement) return;
    this.#applyCss(doc);
    if (this.#observerAttached) return;
    this.#observerAttached = true;

    const observed = collectObserved(doc);
    for (const name of observed.classes)
      this.#remember(this.#seenClasses, name);
    for (const name of observed.ids) this.#remember(this.#seenIds, name);

    if (typeof this.contentWindow?.MutationObserver === "function") {
      this.#observer = new this.contentWindow.MutationObserver((records) => {
        this.#schedule(doc, collectMutated(records));
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
    this.#lastRefresh = now(this.contentWindow);
    if (observed.classes.length || observed.ids.length) {
      void this.#refresh(doc, observed);
    }
  }

  /**
   * Coalesce one mutation batch into the next parent lookup. A batch that
   * brings a class or id the document has never shown is looked up at once
   * (an injected ad container must be hidden on the frame it appears);
   * everything else waits out the floor so a busy page costs at most two
   * lookups per second.
   */
  #schedule(doc, observed) {
    let unseen = false;
    for (const name of observed.classes) {
      if (!this.#seenClasses.has(name)) unseen = true;
      this.#pendingClasses.add(name);
    }
    for (const name of observed.ids) {
      if (!this.#seenIds.has(name)) unseen = true;
      this.#pendingIds.add(name);
    }
    if (unseen && this.#immediate > 0) {
      this.#immediate -= 1;
      this.#flush(doc);
      return;
    }
    const wait = this.#lastRefresh + REFRESH_FLOOR_MS - now(this.contentWindow);
    if (wait <= 0) {
      this.#flush(doc);
      return;
    }
    if (this.#timer !== null) return;
    const timer = this.contentWindow?.setTimeout(() => {
      this.#timer = null;
      if (!this.#started) return;
      this.#flush(doc);
    }, wait);
    if (timer !== undefined) this.#timer = timer;
  }

  #flush(doc) {
    if (!this.#started) return;
    const observed = {
      classes: [...this.#pendingClasses],
      ids: [...this.#pendingIds],
    };
    this.#pendingClasses.clear();
    this.#pendingIds.clear();
    this.#lastRefresh = now(this.contentWindow);
    void this.#refresh(doc, observed);
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
    // The scriptlet is the time-critical layer (an ad JSON hook must exist
    // before the page's inline scripts), so it goes in before the CSS sheet.
    if (
      !this.#scriptInjected &&
      typeof reply.script === "string" &&
      reply.script !== ""
    ) {
      try {
        this.#scriptInjected =
          ChromeUtils.domProcessChild
            ?.getActor(PROCESS_ACTOR)
            ?.inject(doc, reply.script, this.#url) ?? false;
      } catch {
        this.#scriptInjected = false;
      }
    }
    const selectors = Array.isArray(reply.selectors)
      ? reply.selectors.slice(0, MAX_SELECTORS)
      : [];
    this.#lastCss = selectors
      .map((selector) => `${selector}{display:none!important;}`)
      .join("\n");
    this.#applyCss(doc);
    if (Array.isArray(reply.procedural) && reply.procedural.length > 0) {
      this.#procedural = reply.procedural.slice(0, MAX_PROCEDURAL);
    } else {
      this.#procedural = [];
    }
    this.#applyProcedural(doc);
  }

  /**
   * Install the current selector CSS. Called as soon as the lookup returns
   * (possibly before the root element exists) and again when the root does
   * exist, because the style-node fallback needs a parent to attach to.
   */
  #applyCss(doc) {
    if (!doc) return;
    const css = this.#lastCss;
    if (!this.#applySheet(css)) {
      // No `windowUtils` seam (or the sheet was refused): fall back to a
      // document style node. A page with a strict `style-src` rejects that
      // node, which is exactly why the agent sheet path comes first.
      if (!css) {
        if (this.#style) this.#style.textContent = "";
        return;
      }
      const root = doc.head || doc.documentElement;
      if (!root) return;
      if (!this.#style || !this.#style.isConnected) {
        this.#style = doc.createElement("style");
        this.#style.id = STYLE_ID;
        this.#style.setAttribute("data-astra-blocker", "1");
        root.append(this.#style);
      }
      this.#style.textContent = css;
    }
  }

  /**
   * Install the cosmetic CSS as an agent sheet on the document's window.
   *
   * A `<style>` node lives in the page's origin, so a page that ships
   * `Content-Security-Policy: style-src` (the benchmark below does) silently
   * drops it and no selector ever applies. `windowUtils` sheets are chrome
   * side, bypass that policy, and their `!important` declarations outrank the
   * page's own. Returns false when the seam is unavailable so the caller can
   * use the style node instead.
   */
  #applySheet(css) {
    if (css === this.#sheetCss) return true;
    let utils;
    try {
      utils = this.contentWindow?.windowUtils;
    } catch {
      return false;
    }
    if (!utils) return false;
    this.#dropSheets();
    if (!css) {
      this.#sheetCss = "";
      return true;
    }
    try {
      const type = Ci.nsIDOMWindowUtils.AGENT_SHEET;
      let chunk = "";
      const flush = () => {
        if (!chunk) return;
        const uri = `data:text/css;charset=utf-8,${encodeURIComponent(chunk)}`;
        utils.loadSheetUsingURIString(uri, type);
        this.#sheetUris.push(uri);
        chunk = "";
      };
      for (const line of css.split("\n")) {
        if (chunk.length + line.length > MAX_SHEET_CHUNK) flush();
        chunk += (chunk ? "\n" : "") + line;
      }
      flush();
      this.#sheetCss = css;
      return true;
    } catch {
      this.#dropSheets();
      return false;
    }
  }

  #dropSheets() {
    const utils = this.contentWindow?.windowUtils;
    for (const uri of this.#sheetUris) {
      try {
        utils?.removeSheetUsingURIString(uri, Ci.nsIDOMWindowUtils.AGENT_SHEET);
      } catch {
        // Already gone with the window.
      }
    }
    this.#sheetUris = [];
  }
}

/**
 * Classes and ids carried by one mutation batch: the elements that were added
 * and, for attribute changes, the element whose class/id changed. Scanning
 * only the new subtrees keeps the first batch cheap enough to run on the frame
 * the node appears, unlike a full document walk.
 */
function collectMutated(records) {
  const classes = new Set();
  const ids = new Set();
  let budget = MAX_MUTATION_NODES;
  const addElement = (element) => {
    if (!element || element.nodeType !== 1 || budget <= 0) return;
    budget -= 1;
    if (element.id) ids.add(element.id);
    const className = element.getAttribute?.("class");
    if (className) {
      for (const name of className.split(/\s+/u)) {
        if (name) classes.add(name);
      }
    }
  };
  const addSubtree = (root) => {
    if (!root || budget <= 0) return;
    addElement(root);
    const matches = root.querySelectorAll?.("[id],[class]") ?? [];
    for (const element of matches) {
      if (budget <= 0) return;
      addElement(element);
    }
    if (root.nodeType === 1 && root.shadowRoot) addSubtree(root.shadowRoot);
  };
  for (const record of records) {
    if (budget <= 0) break;
    if (record.type === "attributes") {
      addElement(record.target);
    } else {
      for (const node of record.addedNodes) addSubtree(node);
    }
  }
  return { classes: [...classes], ids: [...ids] };
}

/** Monotonic time in the page's realm, with a wall-clock fallback. */
function now(win) {
  try {
    if (typeof win?.performance?.now === "function")
      return win.performance.now();
  } catch {
    // The window is gone; fall through.
  }
  return Date.now();
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
        } else if (
          entry?.type === "has-text" &&
          typeof entry.value === "string"
        ) {
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
