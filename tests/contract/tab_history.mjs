#!/usr/bin/env node
// Back/Forward history menu contract: the app reads the engine's session
// history through TabHistory and jumps an exact index through Navigation.
//
//   - a missing driver, an unknown tab, a throwing driver or junk answers an
//     empty list; a result is sanitised, index-clamped and capped
//   - Navigation.goToHistory steps the model, refuses the current index and
//     emits nav.committed with `history` + `history_index`
//   - both wire routes exist and HostModules includes TabHistory
//
// Usage: node tests/contract/tab_history.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { TabHistory, __resetTabHistoryForTests } = await import(
  path.join(HOST, "TabHistory.sys.mjs")
);
const { Tabs, Navigation, addEventListener, __resetForTests } = HostAPI;

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

// --- TabHistory.list -------------------------------------------------------

__resetTabHistoryForTests();
const empty = await TabHistory.list({ astra_tab_id: "tab-1" });
check("a missing driver answers an empty list", Array.isArray(empty.entries) && empty.entries.length === 0);

TabHistory.setDriver({
  list: (id) => ({ index: 1, entries: [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/", title: "B" }] }),
});
const two = await TabHistory.list({ astra_tab_id: "tab-1" });
check("a driver result keeps the index", two.index === 1);
check("a driver result keeps its entries", two.entries.length === 2);
check("an entry keeps its url", two.entries[0].url === "https://a.example/");
check("an entry keeps its title", two.entries[0].title === "A");

TabHistory.setDriver({
  list: () => ({ index: 9, entries: [{ url: 7, title: null }, { url: "https://ok.example/", title: 42 }] }),
});
const odd = await TabHistory.list({ astra_tab_id: "tab-1" });
check("a non-string url becomes empty", odd.entries[0].url === "");
check("a non-string title becomes empty", odd.entries[0].title === "");
check("a high index is clamped", odd.index === 1);

TabHistory.setDriver({ list: () => ({ index: -4, entries: [{ url: "https://a.example/" }] }) });
check("a negative index is clamped", (await TabHistory.list({ astra_tab_id: "tab-1" })).index === 0);

const many = Array.from({ length: 120 }, (_, i) => ({
  url: `https://page.example/${i}`,
  title: `Page ${i}`,
}));
TabHistory.setDriver({ list: () => ({ index: 99, entries: many }) });
const capped = await TabHistory.list({ astra_tab_id: "tab-1" });
check("entries are capped", capped.entries.length === 50);
check("the cap keeps the current page", capped.entries[capped.index]?.url === "https://page.example/99");
check("the cap keeps the newest entries", capped.entries.at(-1)?.url === "https://page.example/119");

TabHistory.setDriver({ list: () => null });
check("a null driver result is empty", (await TabHistory.list({ astra_tab_id: "tab-1" })).entries.length === 0);
TabHistory.setDriver({ list: () => Promise.reject(new Error("no tab")) });
check("a rejecting driver is empty", (await TabHistory.list({ astra_tab_id: "tab-1" })).entries.length === 0);
TabHistory.setDriver({ list: () => ({ index: 0, entries: "not a list" }) });
check("a malformed result is empty", (await TabHistory.list({ astra_tab_id: "tab-1" })).entries.length === 0);
TabHistory.setDriver("not a driver");
check("a non-driver is ignored", (await TabHistory.list({ astra_tab_id: "tab-1" })).entries.length === 0);
TabHistory.setDriver({ list: () => ({ index: 0, entries: [{ url: "https://a.example/" }] }) });
check("an empty tab id is refused", (await TabHistory.list({ astra_tab_id: "" })).entries.length === 0);
check("no args is refused", (await TabHistory.list()).entries.length === 0);
check("Host API exports TabHistory", HostAPI.TabHistory === TabHistory);
__resetTabHistoryForTests();

// --- Navigation.goToHistory ------------------------------------------------

__resetForTests();
const made = await Tabs.create({ request_id: "hist-new", url: "https://a.example/" });
const id = made.astra_tab_id;
await Navigation.loadURL({ request_id: "hist-b", astra_tab_id: id, url: "https://b.example/" });
await Navigation.loadURL({ request_id: "hist-c", astra_tab_id: id, url: "https://c.example/" });

function capture(fn) {
  const seen = [];
  const off = addEventListener((event) => seen.push(event));
  return Promise.resolve(fn()).then((result) => {
    off();
    return { seen, result };
  });
}

const jump = await capture(() =>
  Navigation.goToHistory({ request_id: "hist-go", astra_tab_id: id, index: 0 }),
);
check("a jump is accepted", !jump.result.error);
check("a jump reports movement", jump.result.moved === true);
check("a jump reports its index", jump.result.index === 0);
check("a jump reports the target url", jump.result.url === "about:blank");
const jumpCommit = jump.seen.find((event) => event.type === "nav.committed" && event.data.history_index === 0);
check("a jump emits nav.committed", jumpCommit !== undefined);
check("a backward jump names its direction", jumpCommit?.data.history === "back");
check("a jump carries the index", jumpCommit?.data.history_index === 0);

const stay = await capture(() =>
  Navigation.goToHistory({ request_id: "hist-stay", astra_tab_id: id, index: 0 }),
);
check("the current index does not move", stay.result.moved === false);
check("the current index emits no commit", stay.seen.every((event) => event.type !== "nav.committed"));

const ahead = await capture(() =>
  Navigation.goToHistory({ request_id: "hist-ahead", astra_tab_id: id, index: 99 }),
);
check("an out-of-range index is clamped", ahead.result.moved === true && ahead.result.index === 3);
check("a forward jump names its direction", ahead.seen.find((event) => event.type === "nav.committed")?.data.history === "forward");
check("a forward jump carries the index", ahead.seen.find((event) => event.type === "nav.committed")?.data.history_index === 3);

const unknown = await Navigation.goToHistory({
  request_id: "hist-unknown",
  astra_tab_id: "tab-missing",
  index: 0,
});
check("an unknown tab is refused", unknown.error?.code === "no_such_tab");

// --- wire routing ----------------------------------------------------------

const transport = await readFile(
  path.join(ROOT, "ui", "packages", "bridge", "src", "host-transport.ts"),
  "utf8",
);
check("tabs_history is routed to TabHistory", /\btabs_history: \["TabHistory", "list", TAB_ARG\]/u.test(transport));
check(
  "tabs_history_go is routed to Navigation",
  /\btabs_history_go: \["Navigation", "goToHistory", TAB_ARG\]/u.test(transport),
);
check(
  "HostModules includes TabHistory",
  /TabHistory: Record<string, \(args: Record<string, unknown>\) => Promise<unknown>>;/u.test(transport),
);
const jar = await readFile(path.join(ROOT, "overlay", "astra", "jar.mn"), "utf8");
check("TabHistory is packaged in jar.mn", jar.includes("host/TabHistory.sys.mjs"));

console.log(`\ntab_history: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
