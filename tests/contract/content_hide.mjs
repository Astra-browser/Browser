#!/usr/bin/env node
// P4-T03 contract test: ContentHide element hiding.
//
// Imports overlay/astra/host/ContentHide.sys.mjs by file path (pure logic,
// no browser internals) and drives it with fake-DOM fixtures — stdlib only.
// Covers: cosmetic hide on static pages, same-origin iframes, open shadow
// DOM; the click-to-hide picking flow; per-site persist round-trip through
// an injected store adapter; selector validation; request_id echo +
// host_api_version on every call.
//
// Usage: node tests/contract/content_hide.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const Hide = await import(path.join(HOST, "ContentHide.sys.mjs"));

// --- Minimal fake DOM ----------------------------------------------------
// Supports tag, #id, .class, "*" and comma lists — enough for the hiding
// selectors under test. Elements expose shadowRoot / contentDocument so
// scopesOf() traverses iframe + shadow fixtures like the live shell.
function matches(el, sel) {
  const s = sel.trim();
  if (s === "*") {
    return true;
  }
  if (s.startsWith("#")) {
    return el.id === s.slice(1);
  }
  if (s.startsWith(".")) {
    const tokens = String(el.className || "").split(/\s+/);
    return tokens.includes(s.slice(1));
  }
  return String(el.tagName || "").toLowerCase() === s.toLowerCase();
}

function fakeElement(tag, { id = "", className = "" } = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    className,
    parentNode: null,
    children: [],
    attrs: new Map(),
    style: {},
    shadowRoot: null,
    contentDocument: null,
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    },
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    attachShadow() {
      this.shadowRoot = fakeDocument();
      return this.shadowRoot;
    },
  };
  return el;
}

function collectAll(el, out) {
  out.push(el);
  for (const c of el.children) {
    collectAll(c, out);
  }
  if (el.shadowRoot) {
    for (const c of el.shadowRoot.children) {
      collectAll(c, out);
    }
  }
  if (el.contentDocument) {
    for (const c of el.contentDocument.children) {
      collectAll(c, out);
    }
  }
  return out;
}

function fakeDocument() {
  const doc = {
    children: [],
    frames: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    querySelectorAll(sel) {
      const parts = String(sel)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const all = [];
      for (const c of this.children) {
        collectAll(c, all);
      }
      // "*" inside querySelectorAll returns every element (no self).
      return all.filter((el) => parts.some((p) => matches(el, p)));
    },
  };
  return doc;
}

function iframeWith(doc, child) {
  const frame = fakeElement("iframe");
  const inner = fakeDocument();
  inner.appendChild(child);
  frame.contentDocument = inner;
  doc.appendChild(frame);
  return frame;
}

// --- Harness ---------------------------------------------------------------
let passed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
  }
}

Hide.__resetForTests();
const events = [];
Hide.ContentHide.setEventSink((type, data) => events.push({ type, data }));
Hide.ContentHide.setCosmeticProvider({
  cosmeticSelectors: async (url, classes) =>
    classes.includes("sponsored-card") ? [".sponsored-card"] : [],
});

// 1. Static page: cosmetic selector hides the ad, content stays visible.
{
  const doc = fakeDocument();
  const ad = fakeElement("div", { className: "sponsored-card" });
  const body = fakeElement("p", { className: "article" });
  doc.appendChild(ad);
  doc.appendChild(body);
  const out = await Hide.hideForPage(doc, {
    request_id: "h-1",
    url: "https://shop.fixture.invalid/item",
  });
  check("static: echoes request_id", out.request_id === "h-1");
  check("static: carries host_api_version", out.host_api_version === 1);
  check("static: cosmetic selector resolved", out.selectors.includes(".sponsored-card"));
  check("static: ad hidden", out.hidden >= 1 && ad.style.display === "none");
  check("static: content untouched", body.style.display !== "none");
  check("static: host parsed", out.host === "shop.fixture.invalid");
}

// 2. Iframe fixture: ad inside a same-origin iframe is hidden too.
{
  const doc = fakeDocument();
  const innerAd = fakeElement("div", { id: "frame-ad", className: "sponsored-card" });
  iframeWith(doc, innerAd);
  const out = await Hide.hideForPage(doc, {
    request_id: "h-2",
    url: "https://shop.fixture.invalid/item",
  });
  check("iframe: ad hidden through contentDocument", innerAd.style.display === "none");
  check("iframe: marked idempotent", innerAd.getAttribute("data-astra-hide") === "1");
  const again = Hide.applySelectors(doc, [".sponsored-card"]);
  check("iframe: second sweep hides nothing new", again.hidden === 0);
}

// 3. Shadow DOM fixture: ad inside an open shadow root is hidden.
{
  const doc = fakeDocument();
  const host = fakeElement("div", { id: "widget" });
  const shadow = host.attachShadow();
  const shadowAd = fakeElement("span", { className: "sponsored-card" });
  shadow.appendChild(shadowAd);
  doc.appendChild(host);
  const out = await Hide.hideForPage(doc, {
    request_id: "h-3",
    url: "https://shop.fixture.invalid/item",
  });
  check("shadow: ad hidden through shadowRoot", shadowAd.style.display === "none");
  check("shadow: hidden count counts it", out.hidden >= 1);
}

// 4. collectObserved sees classes/ids across iframe + shadow scopes.
{
  const doc = fakeDocument();
  doc.appendChild(fakeElement("div", { id: "top", className: "a b" }));
  iframeWith(doc, fakeElement("div", { className: "frame-cls" }));
  const host = fakeElement("div");
  host.attachShadow().appendChild(fakeElement("div", { id: "shadow-id" }));
  doc.appendChild(host);
  const { classes, ids } = Hide.collectObserved(doc);
  check("collect: iframe class seen", classes.includes("frame-cls"));
  check("collect: top ids seen", ids.includes("top"));
  check("collect: shadow id seen", ids.includes("shadow-id"));
}

// 5. Click-to-hide flow: start -> confirm(element) -> rule stored + event.
{
  events.length = 0;
  const el = fakeElement("div", { id: "annoying-banner" });
  const started = await Hide.ContentHide.startPicking({ request_id: "p-1" });
  check("pick: start echoes + picking", started.request_id === "p-1" && started.picking === true);
  check("pick: picking state", Hide.isPicking() === true);
  const done = await Hide.ContentHide.confirmPick({
    request_id: "p-2",
    url: "https://news.fixture.invalid/article",
    element: el,
  });
  check("pick: confirm derives #id selector", done.selector === "#annoying-banner");
  check("pick: confirm echoes + version", done.request_id === "p-2" && done.host_api_version === 1);
  check("pick: picking ends", Hide.isPicking() === false);
  check(
    "pick: rule-added emitted",
    events.some((e) => e.type === "content-hide.rule-added" && e.data.selector === "#annoying-banner"),
  );
  const listed = await Hide.ContentHide.listRules({ request_id: "p-3", host: "news.fixture.invalid" });
  check("pick: rule listed per-site", listed.selectors.includes("#annoying-banner"));
}

// 6. Per-site persist round-trip through an injected adapter (simulates a
// restart: fresh module state, same adapter still yields the rules).
{
  const backing = new Map();
  Hide.ContentHide.setStoreAdapter({
    load: async (host) => [...(backing.get(host) ?? [])],
    save: async (host, selectors) => {
      backing.set(host, [...selectors]);
    },
  });
  await Hide.ContentHide.addRule({ request_id: "s-1", host: "Shop.Fixture.Invalid.", selector: ".promo" });
  const listed = await Hide.ContentHide.listRules({ request_id: "s-2", host: "shop.fixture.invalid" });
  check("persist: host normalized across round-trip", listed.selectors.includes(".promo"));
  // "Restart": reset module state but keep the adapter, then re-list.
  Hide.__resetForTests();
  const relisted = await Hide.ContentHide.listRules({ request_id: "s-3", host: "shop.fixture.invalid" });
  check("persist: rules survive reset via adapter", relisted.selectors.includes(".promo"));
  await Hide.ContentHide.removeRule({ request_id: "s-4", host: "shop.fixture.invalid", selector: ".promo" });
  const after = await Hide.ContentHide.listRules({ request_id: "s-5", host: "shop.fixture.invalid" });
  check("persist: removal round-trips", !after.selectors.includes(".promo"));
}

// 7. Validation + error envelope.
{
  const noPick = await Hide.ContentHide.confirmPick({ request_id: "e-1", host: "a.invalid", selector: ".x" });
  check("errors: confirm without picking", !!noPick.error && noPick.error.code === "not_picking");
  const badSel = await Hide.ContentHide.addRule({ request_id: "e-2", host: "a.invalid", selector: "<img>" });
  check("errors: markup selector rejected", !!badSel.error && badSel.error.code === "invalid_selector");
  const badHost = await Hide.ContentHide.listRules({ request_id: "e-3", host: "" });
  check("errors: empty host rejected", !!badHost.error && badHost.error.code === "invalid_host");
  const badUrl = await Hide.hideForPage(fakeDocument(), { request_id: "e-4", url: "not a url" });
  check("errors: bad page url rejected", !!badUrl.error && badUrl.error.code === "invalid_url");
  for (const r of [noPick, badSel, badHost, badUrl]) {
    check(`errors: ${r.request_id} echoes + version`, typeof r.request_id === "string" && r.host_api_version === 1);
  }
}

// 8. Stylesheet builder + selector derivation units.
{
  const css = Hide.buildStylesheet([".a", "#b", "<evil>"]);
  check("css: joins valid selectors", css.includes(".a{display:none!important;}") && css.includes("#b{display:none!important;}"));
  check("css: drops invalid selectors", !css.includes("<evil>"));
  check("selector: id wins", Hide.selectorForElement(fakeElement("div", { id: "x" })) === "#x");
  check("selector: first class next", Hide.selectorForElement(fakeElement("div", { className: "c1 c2" })) === ".c1");
}

// 9. LIVE wiring (P4-T11): stylesheet injection, MutationObserver re-pass,
// Blocker provider adapter, override store adapter, Content actor binding.
{
  const ContentMod = await import(path.join(HOST, "Content.sys.mjs"));
  const { Content } = ContentMod;
  check("live: Content actor exposes ContentHide", Content.ContentHide === Hide.ContentHide);
  check("live: Content exposes attachHiding", typeof Content.attachHiding === "function");
  check("live: Content exposes wireHiding", typeof Content.wireHiding === "function");
  check("live: HostAPI facade exposes ContentHide", "ContentHide" in Hide);

  // Override action convention: one blocker_overrides row per selector.
  check("live: action formats with prefix", Hide.formatOverrideAction(".ad") === "cosmetic-hide:.ad");
  check("live: action parses back", Hide.parseOverrideAction("cosmetic-hide:.ad") === ".ad");
  check("live: foreign action ignored", Hide.parseOverrideAction("block") === null);
  check("live: markup action rejected", Hide.parseOverrideAction("cosmetic-hide:<img>") === null);

  // Blocker provider adapter: sync native lookup -> async seam.
  const provider = Hide.createBlockerCosmeticProvider((url, classes) =>
    classes.includes("sponsored-card") ? [".sponsored-card"] : [],
  );
  const via = await provider.cosmeticSelectors("https://x.invalid/", ["sponsored-card"], []);
  check("live: provider adapts native lookup", via.includes(".sponsored-card"));
  const failing = Hide.createBlockerCosmeticProvider(() => {
    throw new Error("engine down");
  });
  check("live: provider degrades on native failure", (await failing.cosmeticSelectors("https://x.invalid/", [], [])).length === 0);

  // Override store adapter: writes cosmetic-hide: rows, reads mirror + native rows.
  const written = [];
  const store = Hide.createOverrideStoreAdapter({
    setAction: async (host, action) => {
      written.push([host, action]);
    },
    getActions: async () => ["cosmetic-hide:.native", "block"],
  });
  await store.save("news.fixture.invalid", [".a"]);
  check("live: store writes prefixed rows", written.some(([, a]) => a === "cosmetic-hide:.a"));
  const loaded = await store.load("news.fixture.invalid");
  check("live: store merges mirror + native rows", loaded.includes(".a") && loaded.includes(".native"));

  // Stylesheet injection on a style-capable fake document.
  const liveDoc = fakeDocument();
  const head = fakeElement("head");
  liveDoc.appendChild(head);
  const styleNodes = [];
  liveDoc.querySelector = (sel) => {
    if (sel === "head") {
      return head;
    }
    const m = /^#([\w-]+)$/.exec(sel);
    return m ? (styleNodes.find((n) => n.attrs.get("id") === m[1]) ?? null) : null;
  };
  liveDoc.createElement = (tag) => {
    const el = fakeElement(tag);
    if (tag === "style") {
      styleNodes.push(el);
    }
    return el;
  };
  check("live: inject creates style node", Hide.injectStylesheet(liveDoc, [".sponsored-card"]) === true);
  check("live: style carries hiding css", (styleNodes[0].textContent ?? "").includes(".sponsored-card{display:none!important;}"));
  check("live: re-inject refreshes same node", Hide.injectStylesheet(liveDoc, [".other"]) === true && styleNodes.length === 1);
  check("live: inject fails headless", Hide.injectStylesheet(fakeDocument(), [".x"]) === false);

  // installLiveHiding: initial pass + observer re-pass on late nodes.
  Hide.__resetForTests();
  Hide.ContentHide.setCosmeticProvider({
    cosmeticSelectors: async (_url, classes) =>
      classes.includes("late-ad") ? [".late-ad"] : [],
  });
  const seen = [];
  liveDoc.defaultView = {
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe() {
        seen.push("observe");
      }
      disconnect() {
        seen.push("disconnect");
      }
    },
  };
  const page = fakeDocument();
  page.querySelector = liveDoc.querySelector;
  page.createElement = liveDoc.createElement;
  page.defaultView = liveDoc.defaultView;
  const handle = await Hide.installLiveHiding(page, { url: "https://shop.fixture.invalid/item", request_id: "l-1" });
  check("live: observer attached", seen.includes("observe"));
  check("live: style injected on install", styleNodes.length >= 1);
  const late = fakeElement("div", { className: "late-ad" });
  page.appendChild(late);
  await handle.run();
  check("live: re-pass hides late node", late.style.display === "none");
  handle.detach();
  check("live: detach disconnects observer", seen.includes("disconnect"));

  // Content.wireHiding routes native lookups into the seams.
  Hide.__resetForTests();
  const rows = [];
  Content.wireHiding({
    cosmeticSelectors: (url, classes) => (classes.includes("wired-ad") ? [".wired-ad"] : []),
    overrideSet: async (host, action) => {
      rows.push([host, action]);
    },
  });
  await Hide.ContentHide.addRule({ request_id: "w-1", host: "wire.fixture.invalid", selector: ".picked" });
  check("live: wireHiding persists via override writer", rows.some(([, a]) => a === "cosmetic-hide:.picked"));
  const wdoc = fakeDocument();
  wdoc.appendChild(fakeElement("div", { className: "wired-ad" }));
  const wout = await Hide.hideForPage(wdoc, { request_id: "w-2", url: "https://wire.fixture.invalid/p" });
  check("live: wireHiding resolves blocker selectors", wout.selectors.includes(".wired-ad"));
  const attached = await Content.attachHiding(fakeDocument(), { url: "https://wire.fixture.invalid/p" });
  check("live: attachHiding returns a live handle", typeof attached.detach === "function" && typeof attached.run === "function");
  attached.detach();
  Hide.__resetForTests();
}

console.log(`content_hide contract: ${process.exitCode ? "FAIL" : `PASS (${passed} checks)`}`);
