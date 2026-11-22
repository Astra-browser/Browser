#!/usr/bin/env node
// Search contract: what a typed field means, and that the answer is safe.
//
//   - a URL stays a URL; words become a search on the chosen engine
//   - Google is the default engine, matching the Settings picker;
//     an unset, blank or unknown setting falls back to it, and an explicit
//     stored engine still wins
//   - the query is encoded exactly once, so it cannot add parameters or
//     change the host
//   - only http, https and about are navigable; javascript:, data:, file:,
//     chrome: and resource: typed by hand are searched for instead
//   - a custom engine is used only when it is https and carries %s
//
// Usage: node tests/contract/search_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const { Search } = await import(
  pathToFileURL(path.join(HOST, "Search.sys.mjs")).href
);
const { Settings, __resetSettingsForTests } = await import(
  pathToFileURL(path.join(HOST, "Settings.sys.mjs")).href
);
const { resolve, searchUrl, engine } = await import(
  pathToFileURL(path.join(HOST, "Search.sys.mjs")).href
);

__resetSettingsForTests();

// --- engine ---------------------------------------------------------------
check("the default engine is Google", engine().id === "google");
check(
  "a query becomes that engine's https URL",
  searchUrl("hello world") === "https://www.google.com/search?q=hello%20world",
);
check(
  "the query is encoded exactly once",
  searchUrl("a&b=c#d") === "https://www.google.com/search?q=a%26b%3Dc%23d",
);
check("an empty query has no URL", searchUrl("   ") === null);

// --- a chosen built-in engine --------------------------------------------
await Settings.set({ key: "search.engine", value: "google" });
check("the chosen engine is used", engine().id === "google");
check(
  "and its URL carries the encoded query",
  searchUrl("rust lifetimes") ===
    "https://www.google.com/search?q=rust%20lifetimes",
);
await Settings.set({ key: "search.engine", value: "nope" });
check("an unknown engine falls back to the default", engine().id === "google");
await Settings.set({ key: "search.engine", value: "" });
check("a blank engine falls back to the default", engine().id === "google");
await Settings.set({ key: "search.engine", value: "duckduckgo" });
check("an explicit stored engine still wins", engine().id === "duckduckgo");
await Settings.set({ key: "search.engine", value: "" });

// --- custom engine safety -------------------------------------------------
await Settings.set({
  key: "search.custom-url",
  value: "http://search.example/?q=%s",
});
check("a plain-http custom engine is refused", engine().id === "google");
await Settings.set({
  key: "search.custom-url",
  value: "javascript:alert('%s')",
});
check("a javascript custom engine is refused", engine().id === "google");
await Settings.set({
  key: "search.custom-url",
  value: "https://search.example/?q=",
});
check("a custom engine without %s is refused", engine().id === "google");
await Settings.set({
  key: "search.custom-url",
  value: "https://search.example/?q=%s",
});
check("a safe https custom engine is used", engine().id === "custom");
check(
  "and it encodes the query",
  searchUrl("a b") === "https://search.example/?q=a%20b",
);
await Settings.set({
  key: "search.custom-url",
  value: "https://search.example/?q={searchTerms}",
});
check(
  "a {searchTerms} custom engine is accepted too",
  engine().id === "custom",
);
check(
  "and the token is normalised once",
  searchUrl("a b") === "https://search.example/?q=a%20b",
);
await Settings.set({
  key: "search.custom-url",
  value: "https://search.example/?q=%s&x={searchTerms}",
});
check("two placeholders are refused", engine().id === "google");
await Settings.set({ key: "search.custom-url", value: "" });

// --- !bangs override the engine before URL detection ----------------------
check(
  "!g searches Google",
  resolve("!g rust lifetimes").url ===
    "https://www.google.com/search?q=rust%20lifetimes",
);
check(
  "!d searches DuckDuckGo",
  resolve("!d rust lifetimes").url ===
    "https://duckduckgo.com/?q=rust%20lifetimes",
);
check(
  "!b searches Bing",
  resolve("!b rust").url === "https://www.bing.com/search?q=rust",
);
check(
  "!br searches Brave Search",
  resolve("!br rust").url === "https://search.brave.com/search?q=rust",
);
check(
  "a bang wins over address detection",
  resolve("!g example.com").kind === "search" &&
    resolve("!g example.com").url ===
      "https://www.google.com/search?q=example.com",
);
check(
  "a bang keeps the words without the shortcut",
  resolve("!d a b").query === "a b",
);
check(
  "an unknown bang is ordinary words",
  resolve("!z rust").kind === "search",
);
check("a bang with no words is not a command", resolve("!g").kind === "search");

// --- what a field means ---------------------------------------------------
check(
  "an https address stays an address",
  resolve("https://example.com/x").kind === "url",
);
check(
  "an http address stays an address",
  resolve("http://example.com").kind === "url",
);
check("about: stays about:", resolve("about:blank").kind === "url");
check("a bare host becomes https", resolve("example.com").kind === "url");
check(
  "and it keeps its path",
  resolve("example.com/a?b=1").url === "https://example.com/a?b=1",
);
check("a word is a search", resolve("hello").kind === "search");
check("two words are a search", resolve("hello world").kind === "search");
check(
  "javascript: typed by hand is searched, not run",
  resolve("javascript:alert(1)").kind === "search",
);
check(
  "data: typed by hand is searched",
  resolve("data:text/html,hi").kind === "search",
);
check(
  "file: typed by hand is searched",
  resolve("file:///etc/passwd").kind === "search",
);
check(
  "chrome: typed by hand is searched",
  resolve("chrome://astra/content/app").kind === "search",
);
check(
  "resource: typed by hand is searched",
  resolve("resource://astra/host/HostAPI.sys.mjs").kind === "search",
);
check(
  "a colon that is not a scheme is a search",
  resolve("10:30 standup").kind === "search",
);
check("an empty field means nothing", resolve("   ") === null);

// --- the New Tab answer ---------------------------------------------------
const seen = [];
const { addEventListener } = await import(
  pathToFileURL(path.join(HOST, "Events.sys.mjs")).href
);
const off = addEventListener((event) => {
  if (event.type === "search-changed") seen.push(event.data);
});
const context = await Search.newtabContext({ tabId: "tab-1" });
check(
  "the New Tab context names its tab",
  context.session_id === "newtab:tab-1",
);
check(
  "the New Tab context is complete",
  !!context.window_id && !!context.profile_id,
);

await Settings.set({ key: "search.suggestions", value: "false" });
seen.length = 0;
await Search.newtabSearch({
  query: "hello world",
  context: { ...context, request_id: "r1" },
});
const answer = seen.at(-1);
check("suggestions off answers with one row", answer.results.length === 1);
check("the row is a search", answer.results[0].kind === "search");
check(
  "the row opens the engine URL",
  answer.results[0].action.type === "OpenUrl" &&
    answer.results[0].action.url ===
      "https://www.google.com/search?q=hello%20world",
);
check(
  "the answer names the engine",
  answer.results[0].detail === "Search Google",
);
check("the answer echoes the query", answer.query === "hello world");
check("the answer echoes the context", answer.context.request_id === "r1");

// --- online suggestions ---------------------------------------------------
const realFetch = globalThis.fetch;
await Settings.set({ key: "search.suggestions", value: "true" });
globalThis.fetch = async (url) => {
  check(
    "the suggestion fetch goes to the engine",
    String(url).includes("suggestqueries.google.com"),
  );
  return {
    ok: true,
    text: async () => JSON.stringify(["rust", ["rust book", "rust lang"], []]),
  };
};
seen.length = 0;
await Search.newtabSearch({
  query: "rust",
  context: { ...context, request_id: "r2" },
});
const suggested = seen.at(-1);
check(
  "a suggestion answer has rows ahead of the search",
  suggested.results.length === 3,
);
check(
  "the first row is a suggestion",
  suggested.results[0].kind === "suggestion",
);
check(
  "the provider's order is kept",
  suggested.results[0].title === "rust book",
);
check(
  "the second suggestion follows",
  suggested.results[1].title === "rust lang",
);
check(
  "a suggestion searches its own words",
  suggested.results[0].action.type === "OpenUrl" &&
    suggested.results[0].action.url ===
      "https://www.google.com/search?q=rust%20book",
);
check("the search row stays last", suggested.results.at(-1).kind === "search");
check("the final answer is settled", suggested.pending === false);

globalThis.fetch = async () => {
  throw new Error("offline");
};
seen.length = 0;
await Search.newtabSearch({
  query: "offline",
  context: { ...context, request_id: "r3" },
});
check(
  "a failed suggestion fetch emits no suggestion",
  seen.at(-1).results.length === 1 && seen.at(-1).results[0].kind === "search",
);

globalThis.fetch = async () => ({
  ok: false,
  text: async () => "[]",
});
seen.length = 0;
await Search.newtabSearch({
  query: "gone",
  context: { ...context, request_id: "r4" },
});
check(
  "a non-2xx suggestion fetch emits no suggestion",
  seen.at(-1).results.length === 1 && seen.at(-1).results[0].kind === "search",
);
globalThis.fetch = realFetch;

// --- a typed address is a row of its own ----------------------------------
// The field resolves an address the same way the address bar does, and never
// asks a provider about it: a host:port is not words.
let asked = 0;
globalThis.fetch = async () => {
  asked += 1;
  return { ok: true, text: async () => JSON.stringify(["never", [], []]) };
};
seen.length = 0;
await Search.newtabSearch({
  query: "localhost:3000",
  context: { ...context, request_id: "r7" },
});
const direct = seen.at(-1);
check(
  "a typed address answers with one row",
  direct.results.length === 1 && direct.results[0].kind === "url",
);
check(
  "the address row opens the resolved address",
  direct.results[0].action.type === "OpenUrl" &&
    direct.results[0].action.url === "http://localhost:3000/",
);
check(
  "the address row says it opens rather than searches",
  direct.results[0].title === "localhost:3000" &&
    direct.results[0].detail === "localhost:3000",
);
check("a typed address asks no provider", asked === 0);
check("the address answer is settled at once", direct.pending === false);

seen.length = 0;
await Search.newtabSearch({
  query: "https://example.com/a",
  context: { ...context, request_id: "r8" },
});
check(
  "a typed http address opens the same",
  seen.at(-1).results.length === 1 &&
    seen.at(-1).results[0].action.url === "https://example.com/a",
);
check("and still asks no provider", asked === 0);

seen.length = 0;
await Search.newtabSearch({
  query: "hello world",
  context: { ...context, request_id: "r9" },
});
check(
  "words still go to the engine",
  seen.at(-1).results.at(-1).action.url ===
    "https://www.google.com/search?q=hello%20world",
);
globalThis.fetch = realFetch;

// A newer request id replaces the older request before its answer lands.
let release;
const delayed = new Promise((resolve) => {
  release = resolve;
});
globalThis.fetch = async () => {
  await delayed;
  return { ok: true, text: async () => JSON.stringify(["one", [], []]) };
};
seen.length = 0;
const first = Search.newtabSearch({
  query: "one",
  context: { ...context, request_id: "r5" },
});
await new Promise((resolve) => setTimeout(resolve, 10));
const second = Search.newtabSearch({
  query: "two",
  context: { ...context, request_id: "r6" },
});
await new Promise((resolve) => setTimeout(resolve, 10));
release();
await Promise.all([first, second]);
check(
  "a superseded request cannot paint over the newer one",
  seen.at(-1).query === "two",
);
check(
  "and it leaves only the newer search row",
  seen.at(-1).results.length === 1,
);
globalThis.fetch = realFetch;

// --- the launcher uses the same provider ----------------------------------
globalThis.fetch = async () => ({
  ok: true,
  text: async () => JSON.stringify({ suggestions: ["rust book", "rust lang"] }),
});
seen.length = 0;
await Search.launcherSearch({ query: "rust", requestId: "l1" });
const launcher = seen.at(-1);
check(
  "the launcher puts suggestions first",
  launcher.results[0].kind === "suggestion",
);
check(
  "the launcher keeps the search row last",
  launcher.results.at(-1).kind === "search",
);
check("the launcher answer has three rows", launcher.results.length === 3);
globalThis.fetch = realFetch;
await Settings.set({ key: "search.suggestions", value: "false" });
off();

const refused = await Search.newtabRun({
  action: { type: "OpenUrl", url: "javascript:alert(1)" },
});
check("a javascript action is never admitted", refused.accepted === false);

console.log(`\nsearch_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
