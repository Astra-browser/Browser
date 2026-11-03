#!/usr/bin/env node
// HistoryCall contract for a connected visit store.
//
// The Node-only contract (`history_model.mjs`) pins the answers when there is
// no store. This suite pins the same call surface once a store is injected:
// the host API must page newest-first by id, apply the range and the search
// before paging, and report removals honestly without ever throwing.
//
// The live Places backend is exercised on the wire in the shell; here the
// seam is the injectable backend, so the reply logic can be tested without a
// Places database.
//
// Usage: node tests/contract/history_places.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { HistoryCall, __setHistoryCallBackend } = await import(
  path.join(HOST, "HistoryCall.sys.mjs")
);

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

const P = "00000000000000000000000001";
const call = (body) => HistoryCall.call({ profile: P, call: body });
const pageCall = (overrides = {}) => ({
  kind: "page",
  query: "",
  range: "everything",
  before: null,
  limit: 100,
  ...overrides,
});

/**
 * A store of 250 visits, newest id first, one per second. The backend mirrors
 * what Places would answer: newest-first, bounded to `limit`, honouring the
 * id cursor, the range and the search.
 */
function makeStore() {
  const now = Date.now();
  const rows = [];
  for (let id = 250; id >= 1; id -= 1) {
    rows.push({
      id: String(id),
      url: id % 2 === 0 ? `https://even.example/${id}` : `https://odd.example/${id}`,
      title: id % 3 === 0 ? `Report ${id}` : `Page ${id}`,
      // One visit per second, so a 100-row page spans under a minute.
      visited_at: Math.floor(now / 1000) - (250 - id),
    });
  }
  const seen = [];
  return {
    rows,
    calls: seen,
    async list({ beginTime, before, limit, search }) {
      seen.push({ beginTime, before, limit, search });
      const at = rows
        .filter((row) => row.visited_at * 1000 >= beginTime)
        .filter((row) => !before || Number(row.id) < before)
        .filter((row) => {
          if (!search) return true;
          const needle = search.toLowerCase();
          return (
            row.url.toLowerCase().includes(needle) ||
            row.title.toLowerCase().includes(needle)
          );
        })
        .slice(0, limit);
      // Places hands rows back newest-first; the reply must not re-order.
      return at;
    },
    async forget(urls) {
      const targets = new Set(urls);
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (targets.has(rows[i].url)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    async clear(range) {
      const begin = range === "everything" ? 0 : Date.now() - 7 * 24 * 60 * 60 * 1000;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].visited_at * 1000 >= begin) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
}

// === Default (no store): documented empty / unavailable answers ============
{
  const page = await call(pageCall());
  check("no store answers an empty page", page.kind === "page" && page.visits.length === 0 && page.next === null);
  check("no store still refuses a deletion", (await call({ kind: "forget", urls: ["https://x.example/"] })).error === "unavailable");
}

const store = makeStore();
const reset = __setHistoryCallBackend(store);

// === First page: newest first, bounded, cursor set =========================
{
  store.calls.length = 0;
  const page = await call(pageCall({ limit: 100 }));
  check("first page is a page reply", page.kind === "page");
  check("first page holds the requested rows", page.visits.length === 100);
  check("first page is newest first", page.visits[0].id === "250" && page.visits[99].id === "151");
  check("next is the last id of the page", page.next === "151");
  check("the reader asked for one row more than the page", store.calls[0].limit === 101);
  check("the reader asked from the start", store.calls[0].before === 0);
  check("every visit carries the wire shape", page.visits.every((visit) =>
    typeof visit.id === "string" &&
    typeof visit.url === "string" &&
    typeof visit.title === "string" &&
    typeof visit.visited_at === "string" &&
    visit.icon === null));
  check("visited_at is unix seconds", Number(page.visits[0].visited_at) < 10_000_000_000);
}

// === Following pages: no overlap, no gap, final page has no cursor =========
{
  const ids = [];
  let before = null;
  let pages = 0;
  for (;;) {
    const page = await call(pageCall({ limit: 100, before }));
    ids.push(...page.visits.map((visit) => Number(visit.id)));
    pages += 1;
    if (page.next === null) break;
    before = page.next;
    if (pages > 10) break;
  }
  check("the whole store is reachable", ids.length === 250);
  check("no id is repeated across pages", new Set(ids).size === ids.length);
  check("ids stay strictly newest-first across pages", ids.every((id, i) => i === 0 || id === ids[i - 1] - 1));
  check("the walk ends on a final page", pages === 3);
}

// === Search and range are applied before paging ===========================
{
  store.calls.length = 0;
  const page = await call(pageCall({ query: "Report", limit: 10 }));
  check("search filters rows", page.visits.length > 0 && page.visits.every((visit) => visit.title.startsWith("Report")));
  check("search is trimmed before reaching the store", store.calls[0].search === "Report");
  check("a blank search filters nothing", store.calls[0].search === "Report");

  const blank = await call(pageCall({ query: "   ", limit: 5 }));
  check("a blank search is no search", blank.visits.length === 5);
  check("a blank search reaches the store empty", store.calls[1].search === "");

  store.calls.length = 0;
  await call(pageCall({ range: "hour" }));
  check("the hour range starts an hour back", Math.abs(Date.now() - store.calls.at(-1).beginTime - 3_600_000) < 5_000);
  await call(pageCall({ range: "day" }));
  check("the day range starts a day back", Math.abs(Date.now() - store.calls.at(-1).beginTime - 86_400_000) < 5_000);
  await call(pageCall({ range: "week" }));
  check("the week range starts a week back", Math.abs(Date.now() - store.calls.at(-1).beginTime - 604_800_000) < 5_000);
  await call(pageCall({ range: "everything" }));
  check("everything reaches the epoch", store.calls.at(-1).beginTime === 0);

  const odd = await call(pageCall({ query: "odd.example", limit: 100 }));
  check("a host search matches the address", odd.visits.every((visit) => visit.url.includes("odd.example")));
}

// === Removals: counted, then absent from the next page ====================
{
  const page = await call(pageCall({ limit: 3 }));
  const urls = page.visits.map((visit) => visit.url);
  const removed = await call({ kind: "forget", urls });
  check("forget is a removed reply", removed.kind === "removed");
  check("forget counts what went", removed.count === urls.length);
  check("forget echoes the profile", removed.profile === P);

  const after = await call(pageCall({ limit: 1000 }));
  check("forgotten addresses leave the list", after.visits.every((visit) => !urls.includes(visit.url)));

  const cleared = await call({ kind: "clear", range: "everything" });
  check("clear is a removed reply", cleared.kind === "removed");
  check("clear counts the visits it removed", cleared.count === after.visits.length);
  check("the store is empty afterwards", (await call(pageCall())).visits.length === 0);
}

// === Backend failures never escape the reply's vocabulary =================
{
  const failing = __setHistoryCallBackend({
    list: async () => {
      throw new Error("database is locked");
    },
    forget: async () => {
      throw new Error("database is locked");
    },
    clear: async () => {
      throw new Error("database is locked");
    },
  });
  check("a failing read answers unavailable", (await call(pageCall())).error === "unavailable");
  check("a failing forget answers unavailable", (await call({ kind: "forget", urls: ["https://x.example/"] })).error === "unavailable");
  check("a failing clear answers unavailable", (await call({ kind: "clear", range: "day" })).error === "unavailable");
  failing();
}

// === Malformed calls never reach the backend =============================
{
  let asked = 0;
  const counting = __setHistoryCallBackend({
    list: async () => {
      asked += 1;
      return [];
    },
    forget: async () => {
      asked += 1;
      return 0;
    },
    clear: async () => {
      asked += 1;
      return 0;
    },
  });
  check("a malformed page is invalid", (await call(pageCall({ range: "month" }))).error === "invalid");
  check("an unknown kind is invalid", (await call({ kind: "nope" })).error === "invalid");
  check("the backend saw no malformed call", asked === 0);
  counting();
}

reset();
console.log(`\nhistory_places: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
