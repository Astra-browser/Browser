#!/usr/bin/env node
// Downloads module contract (wiring): `download_call` answers the UI's
// DownloadSession projection natively instead of failing with
// `unknown_command`.
//
//   - the reads the UI makes (`updates`, `list`, `preferences`) answer
//     well-formed replies with no entries: the host holds nothing, and it
//     never invents a download
//   - `list` reports `supported: false` instead of passing an empty page off
//     as the person's whole history
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
//   - `clear` and `retry_cleanup` are idempotent on the empty set
//   - every call that needs a real transfer, file or durable preference
//     answers the reply's own `error: "unavailable"` — never a fake success
//   - a malformed or unknown call answers `error: "invalid"` and never throws
//
// Usage: node tests/contract/downloads_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Downloads } = await import(path.join(HOST, "Downloads.sys.mjs"));

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
const ENTRY = "0000000000000000000000000a";

const idleCleanup = (cleanup) =>
  !!cleanup && cleanup.running === false && cleanup.error === null;

const call = (profile, call_) => Downloads.call({ profile, call: call_ });

// === Read-only calls: well-formed, empty, honest =============================
{
  const res = await call(P, { kind: "updates" });
  check("updates is an updates reply", res.kind === "updates");
  check("updates echoes the profile", res.profile === P);
  check("updates holds no entries", Array.isArray(res.entries) && res.entries.length === 0);
  check("updates removes nothing", Array.isArray(res.removed) && res.removed.length === 0);
  check("updates cleanup is idle", idleCleanup(res.cleanup));
}

{
  const res = await call(P, { kind: "list", before: null, limit: 50 });
  check("list is a page reply", res.kind === "page");
  check("list echoes the profile", res.profile === P);
  check("list holds no entries", Array.isArray(res.entries) && res.entries.length === 0);
  check("list has no next page", res.next === null);
  check("list reports downloads unsupported", res.supported === false);
  check("list cleanup is idle", idleCleanup(res.cleanup));
}

{
  const res = await call(P, { kind: "list", before: "0000000000000000000000000b", limit: 10 });
  check("list accepts a cursor", res.kind === "page" && res.entries.length === 0);
}

{
  const res = await call(P, { kind: "preferences" });
  check("preferences is a preferences reply", res.kind === "preferences");
  check("preferences echoes the profile", res.profile === P);
  check("preferences are the documented defaults",
    res.preferences.ask_destination === false && res.preferences.directory === null);
  check("preferences report downloads unsupported", res.supported === false);
  check("preferences keep site confirmation on", res.site_downloads_require_confirmation === true);
}

// === Empty honesty: repeated reads never invent an entry =====================
{
  const first = await call(P, { kind: "updates" });
  const second = await call(P, { kind: "updates" });
  check("repeated updates stay empty",
    JSON.stringify(first) === JSON.stringify(second) && first.entries.length === 0);
  const page = await call(P, { kind: "list", before: null, limit: 50 });
  check("updates and list agree on an empty set", page.entries.length === first.entries.length);
  check("no entry-shaped object is returned",
    [...first.entries, ...page.entries].every((entry) => entry === undefined || entry === null));
}

// === Profile scoping ========================================================
{
  const mine = await call(P, { kind: "updates" });
  const theirs = await call(OTHER, { kind: "list", before: null, limit: 50 });
  check("each reply echoes its own profile", mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits entries", mine.entries.length === 0 && theirs.entries.length === 0);
  const alias = await Downloads.call({ expected_profile: P, call: { kind: "updates" } });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
}

// === Idempotent state-clearing ==============================================
{
  const cleared = await call(P, { kind: "clear" });
  check("clear answers accepted", cleared.kind === "accepted");
  check("clear echoes the profile", cleared.profile === P);
  const retried = await call(P, { kind: "retry_cleanup" });
  check("retry_cleanup answers applied", retried.kind === "applied");
  check("retry_cleanup echoes the profile", retried.profile === P);
}

// === Calls that need the real manager: error, never a fake success ==========
for (const kind of ["cancel", "pause", "resume", "keep", "discard", "open", "reveal", "forget"]) {
  const res = await call(P, { kind, id: ENTRY });
  check(`${kind} answers error unavailable`, res.kind === "error" && res.error === "unavailable");
  check(`${kind} never claims success`, res.kind !== "accepted" && res.kind !== "applied");
  check(`${kind} echoes the profile`, res.profile === P);
}

for (const kind of ["cancel", "pause", "resume", "keep", "discard", "open", "reveal", "forget"]) {
  const missing = await call(P, { kind });
  check(`${kind} without an id is invalid`, missing.kind === "error" && missing.error === "invalid");
  const empty = await call(P, { kind, id: "" });
  check(`${kind} with an empty id is invalid`, empty.kind === "error" && empty.error === "invalid");
}

{
  const res = await call(P, { kind: "choose_directory" });
  check("choose_directory answers error unavailable", res.kind === "error" && res.error === "unavailable");

  const on = await call(P, { kind: "set_ask_destination", enabled: true });
  const off = await call(P, { kind: "set_ask_destination", enabled: false });
  check("set_ask_destination cannot persist yet",
    on.kind === "error" && off.kind === "error" && on.error === "unavailable" && off.error === "unavailable");
  const bogus = await call(P, { kind: "set_ask_destination", enabled: "yes" });
  check("set_ask_destination needs a boolean", bogus.kind === "error" && bogus.error === "invalid");
}

// === Malformed and unknown calls: the reply's own error, no crash ===========
for (const kind of ["entries", "teleport", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, res.kind === "error" && res.error === "invalid");
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: ENTRY });
  check("a call without a kind is invalid", noKind.kind === "error" && noKind.error === "invalid");

  const nullCall = await call(P, null);
  check("a null call is invalid", nullCall.kind === "error" && nullCall.error === "invalid");

  const arrayCall = await call(P, []);
  check("an array call is invalid", arrayCall.kind === "error" && arrayCall.error === "invalid");

  const badLimit = await call(P, { kind: "list", before: null, limit: 0 });
  check("a zero limit is invalid", badLimit.kind === "error" && badLimit.error === "invalid");

  const fractional = await call(P, { kind: "list", before: null, limit: 1.5 });
  check("a fractional limit is invalid", fractional.kind === "error" && fractional.error === "invalid");

  const stringLimit = await call(P, { kind: "list", before: null, limit: "50" });
  check("a string limit is invalid", stringLimit.kind === "error" && stringLimit.error === "invalid");

  const emptyBefore = await call(P, { kind: "list", before: "", limit: 50 });
  check("an empty cursor is invalid", emptyBefore.kind === "error" && emptyBefore.error === "invalid");

  const noProfile = await Downloads.call({ call: { kind: "updates" } });
  check("a call without a profile is invalid",
    noProfile.kind === "error" && noProfile.error === "invalid" && noProfile.profile === "");

  const badProfile = await Downloads.call({ profile: 42, call: { kind: "updates" } });
  check("a non-string profile is invalid", badProfile.kind === "error" && badProfile.error === "invalid");

  const nothing = await Downloads.call();
  check("no arguments is invalid, not a throw",
    nothing.kind === "error" && nothing.error === "invalid");
}

// === Access settings =======================================================
{
  const res = await Downloads.openAccessSettings();
  check("openAccessSettings answers a boolean", typeof res === "boolean");
  check("openAccessSettings reports no panel yet", res === false);
}

// === The module never throws ===============================================
{
  let threw = false;
  const hostile = [
    { kind: "updates", extra: () => {} },
    Object.create(null),
    { kind: "list", before: {}, limit: 50 },
    { kind: "cancel", id: { toString: () => ENTRY } },
  ];
  for (const bad of hostile) {
    try {
      const res = await call(P, bad);
      if (!res || typeof res.kind !== "string") threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);
}

console.log(`\ndownloads_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
