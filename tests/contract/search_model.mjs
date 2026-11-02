#!/usr/bin/env node
// Search contract: what a typed field means, and that the answer is safe.
//
//   - a URL stays a URL; words become a search on the chosen engine
//   - the query is encoded exactly once, so it cannot add parameters or
//     change the host
//   - only http, https and about are navigable; javascript:, data:, file:,
//     chrome: and resource: typed by hand are searched for instead
//   - a custom engine is used only when it is https and carries %s
//
// Usage: node tests/contract/search_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { Search } = await import(path.join(HOST, "Search.sys.mjs"));
const { Settings, __resetSettingsForTests } = await import(path.join(HOST, "Settings.sys.mjs"));
const { resolve, searchUrl, engine } = await import(path.join(HOST, "Search.sys.mjs"));

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

__resetSettingsForTests();

// --- engine ---------------------------------------------------------------
check("the default engine is DuckDuckGo", engine().id === "duckduckgo");
check(
  "a query becomes that engine's https URL",
  searchUrl("hello world") === "https://duckduckgo.com/?q=hello%20world",
);
check(
  "the query is encoded exactly once",
  searchUrl("a&b=c#d") === "https://duckduckgo.com/?q=a%26b%3Dc%23d",
);
check("an empty query has no URL", searchUrl("   ") === null);

// --- a chosen built-in engine --------------------------------------------
await Settings.set({ key: "search.engine", value: "google" });
check("the chosen engine is used", engine().id === "google");
check(
  "and its URL carries the encoded query",
  searchUrl("rust lifetimes") === "https://www.google.com/search?q=rust%20lifetimes",
);
await Settings.set({ key: "search.engine", value: "nope" });
check("an unknown engine falls back to the default", engine().id === "duckduckgo");

// --- custom engine safety -------------------------------------------------
await Settings.set({ key: "search.custom-url", value: "http://search.example/?q=%s" });
check("a plain-http custom engine is refused", engine().id === "duckduckgo");
await Settings.set({ key: "search.custom-url", value: "javascript:alert('%s')" });
check("a javascript custom engine is refused", engine().id === "duckduckgo");
await Settings.set({ key: "search.custom-url", value: "https://search.example/?q=" });
check("a custom engine without %s is refused", engine().id === "duckduckgo");
await Settings.set({ key: "search.custom-url", value: "https://search.example/?q=%s" });
check("a safe https custom engine is used", engine().id === "custom");
check(
  "and it encodes the query",
  searchUrl("a b") === "https://search.example/?q=a%20b",
);
await Settings.set({ key: "search.custom-url", value: "" });

// --- what a field means ---------------------------------------------------
check("an https address stays an address", resolve("https://example.com/x").kind === "url");
check("an http address stays an address", resolve("http://example.com").kind === "url");
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
check("data: typed by hand is searched", resolve("data:text/html,hi").kind === "search");
check("file: typed by hand is searched", resolve("file:///etc/passwd").kind === "search");
check("chrome: typed by hand is searched", resolve("chrome://astra/content/app").kind === "search");
check(
  "resource: typed by hand is searched",
  resolve("resource://astra/host/HostAPI.sys.mjs").kind === "search",
);
check("a colon that is not a scheme is a search", resolve("10:30 standup").kind === "search");
check("an empty field means nothing", resolve("   ") === null);

// --- the New Tab answer ---------------------------------------------------
const seen = [];
const { addEventListener } = await import(path.join(HOST, "Events.sys.mjs"));
const off = addEventListener((event) => {
  if (event.type === "search-changed") seen.push(event.data);
});
const context = await Search.newtabContext({ tabId: "tab-1" });
check("the New Tab context names its tab", context.session_id === "newtab:tab-1");
check("the New Tab context is complete", !!context.window_id && !!context.profile_id);

await Search.newtabSearch({ query: "hello world", context: { ...context, request_id: "r1" } });
off();
const answer = seen.at(-1);
check("the New Tab answers with one row", answer.results.length === 1);
check("the row is a search", answer.results[0].kind === "search");
check(
  "the row opens the engine URL",
  answer.results[0].action.type === "OpenUrl" &&
    answer.results[0].action.url === "https://duckduckgo.com/?q=hello%20world",
);
check("the answer names the engine", answer.results[0].detail === "Search DuckDuckGo");
check("the answer echoes the query", answer.query === "hello world");
check("the answer echoes the context", answer.context.request_id === "r1");

const refused = await Search.newtabRun({ action: { type: "OpenUrl", url: "javascript:alert(1)" } });
check("a javascript action is never admitted", refused.accepted === false);

console.log(`\nsearch_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
