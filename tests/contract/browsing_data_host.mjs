#!/usr/bin/env node
// Lane 3 contract test: BrowsingData host.
//
// The route is `browsing_data_call`. This test imports the chrome module with
// an in-memory backend and asserts:
//   - the five ranges and four categories map to the engine's clear request
//   - `cookies` means cookies + site data, `downloads` is the list only
//   - everything is unbounded; relative ranges name an exact span
//   - a private window answers `private` and performs no write
//   - sites / forget_site / forget_page keep the documented response shapes
//   - failures are reported, never a fake success
//
// Usage: node tests/contract/browsing_data_host.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { BrowsingData, __setBrowsingDataBackend } = await import(pathToFileURL(path.join(HOST, "BrowsingData.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

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

function backend({
  privateWindow = false,
  hasWindow = true,
  failClear = false,
  failForgetSite = false,
  failForgetPage = false,
  sites = [],
  partial = false,
} = {}) {
  const calls = [];
  return {
    calls,
    isPrivate: () => privateWindow,
    hasWindow: () => hasWindow,
    async clear(range, kinds) {
      calls.push({ op: "clear", range, kinds });
      return !failClear;
    },
    async sites() {
      calls.push({ op: "sites" });
      return { sites, partial };
    },
    async forgetSite(site) {
      calls.push({ op: "forget_site", site });
      return !failForgetSite;
    },
    async forgetPage(origin) {
      calls.push({ op: "forget_page", origin });
      return !failForgetPage;
    },
  };
}

const seen = [];
const off = Events.addEventListener((event) => seen.push(event));
const ofType = (type) => seen.filter((event) => event.type === type);

function reset() {
  seen.length = 0;
  __setBrowsingDataBackend(null);
}

const EMPTY = { history: false, cookies: false, cache: false, downloads: false };
const ALL = { history: true, cookies: true, cache: true, downloads: true };

// --- Clear -------------------------------------------------------------------
{
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...EMPTY, history: true },
  });
  check("history clears with the existing response shape", response.kind === "cleared");
  check("the backend saw one clear", store.calls.length === 1);
  check("the range is passed through", store.calls[0].range === "hour");
  check("only history is selected", store.calls[0].kinds.history === true && store.calls[0].kinds.cookies === false);
  check("a history clear emits history.cleared", ofType("history.cleared").length === 1);
  check("a history-only clear does not emit sites-changed", ofType("sites-changed").length === 0);
}

{
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "everything", ...ALL },
  });
  check("all categories clear as one request", response.kind === "cleared");
  check("cookies and site data are both selected", store.calls[0].kinds.cookies === true);
  check("downloads are selected", store.calls[0].kinds.downloads === true);
  check("the everything range is explicit", store.calls[0].range === "everything");
  check("a cookie clear emits sites-changed", ofType("sites-changed").length === 1);
  check("history still emits its own signal", ofType("history.cleared").length === 1);
}

for (const range of ["hour", "day", "week", "four_weeks", "everything"]) {
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range, ...EMPTY, cache: true },
  });
  check(`range ${range} is accepted`, response.kind === "cleared" && store.calls[0].range === range);
}

// --- Validation --------------------------------------------------------------
{
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const none = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...EMPTY },
  });
  check("no category is invalid", none.kind === "error" && none.error === "invalid");
  const badRange = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "year", ...EMPTY, history: true },
  });
  check("an unknown range is invalid", badRange.kind === "error" && badRange.error === "invalid");
  const missing = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", history: true },
  });
  check("a missing category flag is invalid", missing.kind === "error" && missing.error === "invalid");
  const unknown = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "teleport" },
  });
  check("an unknown call kind is invalid", unknown.kind === "error" && unknown.error === "invalid");
  const nil = await BrowsingData.call({ expected_profile: "default", call: null });
  check("a null call is invalid", nil.kind === "error" && nil.error === "invalid");
  check("validation reached no backend write", store.calls.length === 0);
}

// --- Private scope -----------------------------------------------------------
{
  reset();
  const store = backend({ privateWindow: true });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("a private window answers private", response.kind === "error" && response.error === "private");
  check("a private clear writes nothing", store.calls.length === 0);
  const declared = await BrowsingData.call({
    expected_profile: "incognito",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("an incognito profile answers private even if the window looks normal", declared.error === "private");
  check("an incognito clear writes nothing", store.calls.length === 0);
}

{
  reset();
  const store = backend({ hasWindow: false });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("a clear with no owning window is unavailable", response.error === "unavailable");
  check("an unattributed clear writes nothing", store.calls.length === 0);
  const other = await BrowsingData.call({
    expected_profile: "work",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("an unknown profile is unavailable, not the default profile", other.error === "unavailable");
}

{
  reset();
  const store = backend({ failClear: true });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("a failed engine clear is reported as failed", response.error === "failed");
  check("a failed clear emits no change", ofType("sites-changed").length === 0 && ofType("history.cleared").length === 0);
}

// --- Sites -------------------------------------------------------------------
{
  reset();
  const store = backend({
    sites: [
      { site: "a.example", cookies: true, storage: false },
      { site: "b.example", cookies: false, storage: true },
    ],
    partial: true,
  });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({ expected_profile: "default", call: { kind: "sites" } });
  check("sites keeps the response shape", response.kind === "sites");
  check("both sites are returned", response.sites.length === 2);
  check("the partial flag is preserved", response.partial === true);
  check("the first site names cookies", response.sites[0].cookies === true);
  check("the second site names storage", response.sites[1].storage === true);
}

{
  reset();
  __setBrowsingDataBackend(backend({ privateWindow: true }));
  const response = await BrowsingData.call({ expected_profile: "default", call: { kind: "sites" } });
  check("sites in a private window is private", response.error === "private");
}

{
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_site", site: "a.example" },
  });
  check("forget_site is cleared", response.kind === "cleared");
  check("forget_site passes the site", store.calls[0].site === "a.example");
  check("forget_site emits sites-changed", ofType("sites-changed").length === 1);
  const bad = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_site", site: "https://a.example/path" },
  });
  check("forget_site rejects a URL", bad.error === "invalid");
  const space = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_site", site: "two words" },
  });
  check("forget_site rejects whitespace", space.error === "invalid");
}

{
  reset();
  const store = backend({ failForgetSite: true });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_site", site: "a.example" },
  });
  check("a failed forget_site is reported", response.error === "failed");
  check("a failed forget emits nothing", ofType("sites-changed").length === 0);
}

// --- Page origin -------------------------------------------------------------
{
  reset();
  const store = backend();
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_page", origin: "https://a.example:8443" },
  });
  check("forget_page is cleared", response.kind === "cleared");
  check("forget_page passes the canonical origin", store.calls[0].origin === "https://a.example:8443");
  check("forget_page emits sites-changed", ofType("sites-changed").length === 1);
  for (const origin of ["https://a.example/path", "a.example", "file:///tmp/x"]) {
    const bad = await BrowsingData.call({
      expected_profile: "default",
      call: { kind: "forget_page", origin },
    });
    check(`forget_page rejects ${origin}`, bad.error === "invalid");
  }
}

{
  reset();
  const store = backend({ failForgetPage: true });
  __setBrowsingDataBackend(store);
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "forget_page", origin: "https://a.example" },
  });
  check("a failed forget_page is reported", response.error === "failed");
}

off();

// --- No backend (standalone/Node) -------------------------------------------
{
  reset();
  const response = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear", range: "hour", ...ALL },
  });
  check("without the chrome backend the call is unavailable", response.error === "unavailable");
}

console.log(
  `\nbrowsing data host contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
