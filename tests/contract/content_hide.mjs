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

console.log(`content_hide contract: ${process.exitCode ? "FAIL" : `PASS (${passed} checks)`}`);
