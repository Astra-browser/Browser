#!/usr/bin/env node
// History module contract (wiring): `history_call` answers the History page
// and panel natively instead of failing with `unknown_command`.
//
//   - the paged list and the search answer a well-formed empty page with
//     `next: null`: the host holds no visits and never invents one
//   - every `range`, `query`, cursor and page size the panel sends is accepted,
//     and day grouping is the client's job, so no grouping field comes back
//   - `closed_tabs` answers an empty list; nothing is borrowed from Session
//   - every destructive call (`forget`, `clear`, `reopen_closed`) answers the
//     reply's own `error: "unavailable"` — never a claimed `removed` or
//     `reopened`
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
//   - a malformed or unknown call answers `error: "invalid"` and never throws
//
// Usage: node tests/contract/history_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { HistoryCall } = await import(path.join(HOST, "HistoryCall.sys.mjs"));

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
const OTHER = "00000000000000000000000002";
const URL = "https://astra.example/docs";
const OTHER_URL = "https://astra.example/release-notes";

/** The reply kinds `HistoryResponse` allows. */
const KINDS = new Set(["page", "removed", "closed_tabs", "reopened", "error"]);
/** The codes `HistoryError` allows. */
const ERRORS = new Set(["invalid", "unavailable", "capacity"]);
/** The scopes `HistoryRange` allows. */
const RANGES = ["hour", "day", "week", "everything"];

const call = (profile, body) => HistoryCall.call({ profile, call: body });
const isRefusal = (res, code) =>
  !!res && res.kind === "error" && res.error === code;

/** The panel's first-page request (`history-session.svelte.ts`). */
const pageCall = (overrides = {}) => ({
  kind: "page",
  query: "",
  range: "everything",
  before: null,
  limit: 100,
  ...overrides,
});

/** Every reply is one `HistoryResponse` variant with the profile echoed. */
function wellFormed(res, profile) {
  return (
    !!res &&
    typeof res === "object" &&
    KINDS.has(res.kind) &&
    res.profile === profile
  );
}

/** An empty page, exactly: no rows, no cursor, no grouping. */
function isEmptyPage(res) {
  return (
    res.kind === "page" &&
    Array.isArray(res.visits) &&
    res.visits.length === 0 &&
    res.next === null &&
    res.days === undefined &&
    res.grouping === undefined
  );
}

// === The paged list and the search: well-formed, empty, honest =============
{
  const res = await call(P, pageCall());
  check("the first page is a page reply", res.kind === "page");
  check("the first page echoes the profile", res.profile === P);
  check("the first page holds no visits", isEmptyPage(res));
  check("the first page is final", res.next === null);
  check("no day grouping is sent (the panel groups by visited_at)",
    res.days === undefined && res.grouping === undefined);
}

for (const range of RANGES) {
  const res = await call(P, pageCall({ range }));
  check(`range ${range} is an empty page`, isEmptyPage(res));
  check(`range ${range} echoes the profile`, res.profile === P);
}

{
  const queries = [
    ["a search", "astra"],
    ["a blank search", "   "],
    ["a unicode search", "İstanbul"],
    ["the longest search", "a".repeat(512)],
  ];
  for (const [name, query] of queries) {
    const res = await call(P, pageCall({ query }));
    check(`${name} matches nothing in an empty store`, isEmptyPage(res));
  }
}

{
  for (const before of ["0", "1", "1717171717", "9223372036854775807"]) {
    const res = await call(P, pageCall({ before }));
    check(`cursor ${before} has no following page`, isEmptyPage(res));
  }
}

{
  for (const limit of [1, 100, 1000]) {
    const res = await call(P, pageCall({ limit }));
    check(`a page of ${limit} is empty`, isEmptyPage(res));
  }
}

// === Empty honesty: repeated reads never invent a visit ====================
{
  const first = await call(P, pageCall());
  const second = await call(P, pageCall());
  check("repeated pages are identical",
    JSON.stringify(first) === JSON.stringify(second));

  const searched = await call(P, pageCall({ query: "astra", range: "week" }));
  check("list and search agree on an empty set",
    searched.visits.length === first.visits.length);
  check("no visit-shaped object is returned",
    [...first.visits, ...searched.visits].every((item) => item === undefined || item === null));
  check("nothing is ever removed by a read",
    [first, second, searched].every((res) => res.kind !== "removed"));

  // A refused deletion must leave the list as empty as it found it.
  await call(P, { kind: "forget", urls: [URL] });
  const after = await call(P, pageCall());
  check("a refused forget leaves the page empty", isEmptyPage(after));
}

// === Profile scoping =======================================================
{
  const mine = await call(P, pageCall());
  const theirs = await call(OTHER, pageCall({ query: "astra" }));
  check("each reply echoes its own profile",
    mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits visits",
    mine.visits.length === 0 && theirs.visits.length === 0);

  const alias = await HistoryCall.call({
    expected_profile: P,
    call: pageCall(),
  });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
  check("a scoped reply is still well formed", wellFormed(alias, P));
}

// === Closed tabs: an empty list, never a borrowed record ===================
{
  const res = await call(P, { kind: "closed_tabs" });
  check("closed_tabs is a closed_tabs reply", res.kind === "closed_tabs");
  check("closed_tabs echoes the profile", res.profile === P);
  check("closed_tabs holds no tabs",
    Array.isArray(res.tabs) && res.tabs.length === 0);
  check("closed_tabs mints no id", res.id === undefined);
}

// === Destructive calls: the reply's own refusal, never a claimed delete ====
const DESTRUCTIVE = [
  ["forget one address", { kind: "forget", urls: [URL] }],
  ["forget several addresses", { kind: "forget", urls: [URL, OTHER_URL, "https://astra.example/a"] }],
  ["forget a very long address", { kind: "forget", urls: [`https://astra.example/${"a".repeat(2048)}`] }],
  ...RANGES.map((range) => [`clear ${range}`, { kind: "clear", range }]),
  ["reopen a closed tab", { kind: "reopen_closed", id: "closed-1" }],
];
for (const [name, body] of DESTRUCTIVE) {
  const res = await call(P, body);
  check(`${name} answers error unavailable`, isRefusal(res, "unavailable"));
  check(`${name} never claims a deletion`, res.kind !== "removed");
  check(`${name} never claims a reopen`, res.kind !== "reopened");
  check(`${name} reports no count`, res.count === undefined);
  check(`${name} echoes the profile`, res.profile === P);
}

// === Malformed reads: invalid, not a guess =================================
const MALFORMED_READS = [
  ["page without a query", { kind: "page", range: "day", before: null, limit: 100 }],
  ["page with a numeric query", pageCall({ query: 7 })],
  ["page with a null query", pageCall({ query: null })],
  ["page past the panel's search cap", pageCall({ query: "a".repeat(513) })],
  ["page without a range", { kind: "page", query: "", before: null, limit: 100 }],
  ["page with an unknown range", pageCall({ range: "month" })],
  ["page with a numeric range", pageCall({ range: 7 })],
  ["page without a cursor", { kind: "page", query: "", range: "day", limit: 100 }],
  ["page with an empty cursor", pageCall({ before: "" })],
  ["page with a numeric cursor", pageCall({ before: 12 })],
  ["page with an oversized cursor", pageCall({ before: "1".repeat(65) })],
  ["page without a limit", { kind: "page", query: "", range: "day", before: null }],
  ["page with a zero limit", pageCall({ limit: 0 })],
  ["page with a negative limit", pageCall({ limit: -1 })],
  ["page with a fractional limit", pageCall({ limit: 1.5 })],
  ["page with a string limit", pageCall({ limit: "100" })],
  ["page past the host's page cap", pageCall({ limit: 1001 })],
  ["page with an unsafe limit", pageCall({ limit: 2 ** 53 })],
];
for (const [name, body] of MALFORMED_READS) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} echoes the profile`, res.profile === P);
}

// === Malformed writes: invalid, not unavailable ============================
const MALFORMED_WRITES = [
  ["forget without urls", { kind: "forget" }],
  ["forget with urls not an array", { kind: "forget", urls: URL }],
  ["forget of nothing", { kind: "forget", urls: [] }],
  ["forget with an empty address", { kind: "forget", urls: [""] }],
  ["forget with a numeric address", { kind: "forget", urls: [7] }],
  ["forget with a null address", { kind: "forget", urls: [null] }],
  ["forget past the address cap",
    { kind: "forget", urls: Array.from({ length: 1025 }, (_, i) => `https://astra.example/${i}`) }],
  ["clear without a range", { kind: "clear" }],
  ["clear with an unknown range", { kind: "clear", range: "month" }],
  ["clear with a numeric range", { kind: "clear", range: 7 }],
  ["reopen without an id", { kind: "reopen_closed" }],
  ["reopen with an empty id", { kind: "reopen_closed", id: "" }],
  ["reopen with a numeric id", { kind: "reopen_closed", id: 7 }],
];
for (const [name, body] of MALFORMED_WRITES) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} never claims a deletion`, res.kind !== "removed");
  check(`${name} echoes the profile`, res.profile === P);
}

// === Malformed and unknown calls: the reply's own error, no crash ==========
for (const kind of ["history", "menu", "list", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isRefusal(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { query: "", range: "day", before: null, limit: 100 });
  check("a call without a kind is invalid", isRefusal(noKind, "invalid"));

  const nullCall = await call(P, null);
  check("a null call is invalid", isRefusal(nullCall, "invalid"));

  const arrayCall = await call(P, []);
  check("an array call is invalid", isRefusal(arrayCall, "invalid"));

  const textCall = await call(P, "page");
  check("a string call is invalid", isRefusal(textCall, "invalid"));

  const noProfile = await HistoryCall.call({ call: pageCall() });
  check("a call without a profile is invalid",
    isRefusal(noProfile, "invalid") && noProfile.profile === "");

  const badProfile = await HistoryCall.call({ profile: 42, call: pageCall() });
  check("a non-string profile is invalid", isRefusal(badProfile, "invalid"));

  const emptyProfile = await HistoryCall.call({
    profile: "",
    expected_profile: "",
    call: pageCall(),
  });
  check("an empty profile is invalid", isRefusal(emptyProfile, "invalid"));

  const nothing = await HistoryCall.call();
  check("no arguments is invalid, not a throw", isRefusal(nothing, "invalid"));

  const nullArgs = await HistoryCall.call(null);
  check("null arguments is invalid, not a throw", isRefusal(nullArgs, "invalid"));
}

// === Every refusal stays inside HistoryError ===============================
{
  const replies = [
    await call(P, pageCall()),
    await call(P, { kind: "closed_tabs" }),
    await call(P, { kind: "forget", urls: [URL] }),
    await call(P, { kind: "clear", range: "day" }),
    await call(P, { kind: "reopen_closed", id: "closed-1" }),
    await call(P, { kind: "nope" }),
  ];
  check("every reply is a HistoryResponse variant",
    replies.every((res) => wellFormed(res, P)));
  check("every error code is a HistoryError",
    replies
      .filter((res) => res.kind === "error")
      .every((res) => ERRORS.has(res.error)));
}

// === The module never throws ===============================================
{
  let threw = false;
  const hostile = [
    pageCall({ extra: () => {} }),
    Object.create(null),
    { kind: "page", query: { toString: () => "astra" }, range: "day", before: null, limit: 100 },
    { kind: "forget", urls: [{ toString: () => URL }] },
    { kind: "reopen_closed", id: { toString: () => "closed-1" } },
    {
      get kind() {
        throw new Error("hostile payload");
      },
    },
  ];
  for (const bad of hostile) {
    try {
      const res = await call(P, bad);
      if (!wellFormed(res, P)) threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);

  let scopeThrew = false;
  try {
    const res = await HistoryCall.call({
      get profile() {
        throw new Error("hostile scope");
      },
      call: pageCall(),
    });
    if (!wellFormed(res, "")) scopeThrew = true;
  } catch {
    scopeThrew = true;
  }
  check("a scope whose profile getter throws answers instead", scopeThrew === false);
}

console.log(`\nhistory_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
