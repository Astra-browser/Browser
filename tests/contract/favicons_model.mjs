#!/usr/bin/env node
// Favicons contract: the host turns a stored favicon into the one raster form
// the chrome UI accepts (32x32 RGBA, base64) and announces it as
// `favicons-changed`; the tab model carries only the reference.
//
// The live Places backend is exercised in the shell; here the seam is the
// injectable backend, so the pure pipeline can be tested without an image
// decoder or a database.
//
// Usage: node tests/contract/favicons_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const {
  Favicons,
  originOf,
  revisionOf,
  encodeRgba,
  __setFaviconBackend,
  __setFaviconEventSink,
  __resetFaviconsForTests,
} = await import(path.join(HOST, "Favicons.sys.mjs"));
const TabsMod = await import(path.join(HOST, "Tabs.sys.mjs"));
const NavMod = await import(path.join(HOST, "Navigation.sys.mjs"));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const SIDE = 32;
const RASTER_LENGTH = SIDE * SIDE * 4;
const BASE64_LENGTH = Math.ceil(RASTER_LENGTH / 3) * 4;
const URL = "https://astra.example/docs/page?q=1";

/** A deterministic RGBA buffer: enough variety to tell two icons apart. */
function raster(seed = 0) {
  const bytes = new Uint8ClampedArray(RASTER_LENGTH);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + seed * 97) % 256;
  }
  return bytes;
}

// === Pure helpers ==========================================================
{
  check("an https origin drops the path", originOf("https://astra.example/a/b?c") === "https://astra.example");
  check("a non-default port stays in the origin", originOf("https://astra.example:8443/a") === "https://astra.example:8443");
  check("a default port is normalised away", originOf("https://astra.example:443/a") === "https://astra.example");
  check("http is its own origin", originOf("http://astra.example:80/a") === "http://astra.example");
  check("an unparseable address has no origin", originOf("not a url") === "");
  check("a non-http origin is not a site", originOf("about:blank") === "");

  check("the same pixels hash the same", revisionOf(raster(1)) === revisionOf(raster(1)));
  check("different pixels hash differently", revisionOf(raster(1)) !== revisionOf(raster(2)));
  check("a revision is short hex", /^[0-9a-f]{16}$/u.test(revisionOf(raster(0))));
  check("base64 matches the UI's expected length", encodeRgba(raster(0)).length === BASE64_LENGTH);
  check("base64 round-trips the bytes", Buffer.from(encodeRgba(raster(3)), "base64").equals(Buffer.from(raster(3))));
}

// === No backend (the Node default): nothing is invented ====================
{
  __resetFaviconsForTests();
  check("no store resolves no icon", (await Favicons.resolve({ url: URL, doc: {} })) === null);
  check("no store refreshes nothing", (await Favicons.refresh({ url: URL, doc: {} })) === null);
  check("a missing document resolves no icon", (await Favicons.resolve({ url: URL })) === null);
}

// === A resolved icon: reference, raster, event =============================
const emitted = [];
__setFaviconEventSink((view) => emitted.push(view));
const reset = __setFaviconBackend({ raster: async () => raster(1) });

{
  const resolved = await Favicons.resolve({ url: URL, doc: {} });
  check("a stored icon resolves", !!resolved);
  check("the entry names the page origin", resolved.entry.origin === "https://astra.example");
  check("the entry carries a revision", /^[0-9a-f]{16}$/u.test(resolved.entry.revision));
  check("the entry carries exactly 32x32 RGBA", Buffer.from(resolved.entry.rgba, "base64").length === RASTER_LENGTH);
  check("the view targets chrome", resolved.surface === "chrome");
  check("the view names the default profile", resolved.profile_id === "default");

  const ref = await Favicons.refresh({ url: URL, doc: {} });
  check("refresh answers the tab's IconRef", ref.origin === resolved.entry.origin && ref.revision === resolved.entry.revision);
  check("refresh announced one event", emitted.length === 1);
  check("the event is a FaviconsView", emitted[0].surface === "chrome" && emitted[0].profile_id === "default" && Array.isArray(emitted[0].entries));
  check("the event carries one entry", emitted[0].entries.length === 1);
  check("the event entry has the wire shape", typeof emitted[0].entries[0].origin === "string" && typeof emitted[0].entries[0].revision === "string" && typeof emitted[0].entries[0].rgba === "string" && emitted[0].entries[0].rgba.length === BASE64_LENGTH);

  const again = await Favicons.resolve({ url: URL, doc: {} });
  check("the same pixels yield the same revision", again.entry.revision === resolved.entry.revision);
}

// === Raster validation ====================================================
{
  const bad = __setFaviconBackend({ raster: async () => new Uint8ClampedArray(16) });
  check("a short raster is refused", (await Favicons.resolve({ url: URL, doc: {} })) === null);
  bad();

  const throwing = __setFaviconBackend({
    raster: async () => {
      throw new Error("decode failed");
    },
  });
  check("a failing decoder answers null, not a throw", (await Favicons.resolve({ url: URL, doc: {} })) === null);
  throwing();

  const none = __setFaviconBackend({ raster: async () => null });
  check("no stored icon answers null", (await Favicons.resolve({ url: URL, doc: {} })) === null);
  none();
}

// === Publishing is defensive ==============================================
{
  emitted.length = 0;
  check("an empty view is not published", Favicons.publish(null) === false);
  check("a view without a raster is not published", Favicons.publish({ entry: { origin: "https://x.example" } }) === false);
  check("nothing reached the sink", emitted.length === 0);
}

// === The tab model carries the reference, not the pixels ==================
{
  TabsMod.__resetTabsForTests();
  await TabsMod.Tabs.create({ request_id: "f-1", url: URL });
  const id = (await TabsMod.Tabs.list({ request_id: "f-2" })).tabs[0].astra_tab_id;

  TabsMod.__applyExternalUpdate(id, { icon: { origin: "https://astra.example", revision: "0123456789abcdef" } });
  let view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("the projection carries the icon ref", view.icon?.origin === "https://astra.example" && view.icon?.revision === "0123456789abcdef");

  TabsMod.__applyExternalUpdate(id, { icon: { origin: "", revision: "x" } });
  view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("a malformed ref is ignored", view.icon?.origin === "https://astra.example");

  // A different origin is a different site: the old mark must not survive.
  TabsMod.__applyExternalUpdate(id, { url: "https://other.example/landing" });
  view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("a navigation to another origin clears the icon", view.icon === null);

  TabsMod.__applyExternalUpdate(id, { icon: { origin: "https://other.example", revision: "fedcba9876543210" } });
  TabsMod.__applyExternalUpdate(id, { url: "https://other.example/next" });
  view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("a same-origin navigation keeps the icon", view.icon?.revision === "fedcba9876543210");

  // Navigation.commit writes `tab.url` itself (a typed address), bypassing the
  // external-update path: the projection still must not keep a foreign mark.
  await NavMod.Navigation.loadURL({
    request_id: "f-4",
    astra_tab_id: id,
    url: "https://elsewhere.example/page",
  });
  view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("a typed navigation to another origin projects no icon", view.icon === null);

  TabsMod.__applyExternalUpdate(id, { icon: null });
  view = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === id);
  check("an explicit null clears the icon", view.icon === null);

  const fresh = await TabsMod.Tabs.create({ request_id: "f-3", url: "https://blank.example/" });
  const freshView = TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === fresh.astra_tab_id);
  check("a tab with no icon projects null", freshView.icon === null);
}

reset();
__resetFaviconsForTests();
console.log(`\nfavicons_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
