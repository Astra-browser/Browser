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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, UI, check, passed, failed } from "./lib/harness.mjs";

const { Downloads, __downloadsInternals } = await import(
  pathToFileURL(path.join(HOST, "Downloads.sys.mjs")).href
);
const { viewOf, timeMs } = __downloadsInternals;

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

// === Completed and history views carry the target and its presence ==========
{
  const completed = {
    startTime: new Date("2026-11-20T10:00:00.000Z"),
    stopped: true,
    succeeded: true,
    source: { url: "https://example.test/file.zip" },
    target: { path: "C:\\Users\\me\\Downloads\\file.zip", exists: true, size: 4096 },
    currentBytes: 4096,
    totalBytes: 4096,
  };
  const present = viewOf(completed, true);
  check("a completed view names its target", present.target === completed.target.path);
  check("a present file is not deleted", present.exists === true && present.deleted === false);
  check("a completed view keeps its byte total", present.total === "4096" && present.received === "4096");
  const missing = viewOf(completed, false);
  check("a missing target is marked deleted", missing.exists === false && missing.deleted === true);
  const explicit = viewOf({ ...completed, deleted: true }, true);
  check("a browser-deleted file stays deleted", explicit.exists === false && explicit.deleted === true);

  const history = {
    stopped: true,
    succeeded: true,
    source: { url: "https://example.test/old.zip" },
    target: { path: "C:\\Users\\me\\Downloads\\old.zip", exists: true, size: 2048 },
    endTime: 1_700_000_000,
  };
  const old = viewOf(history, true);
  check("history end time becomes a created_at", old.created_at === new Date(1_700_000_000_000).toISOString());
  check("history size fills total and received", old.total === "2048" && old.received === "2048");
  check("seconds and milliseconds are both accepted", timeMs(1_700_000_000) === timeMs(1_700_000_000_000));
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

// === Native seam: the list, preferences and writes are the engine's ========
{
  const { __setDownloadsNative, __resetDownloadsForTests } = await import(pathToFileURL(path.join(HOST, "Downloads.sys.mjs")).href);
  const reset = () => {
    __resetDownloadsForTests();
  };
  const view = (id, state = "completed", extra = {}) => ({
    id,
    revision: "9000000000000001",
    created_at: "2026-11-05T10:00:00.000Z",
    filename: `${id}.zip`,
    source: `https://example.test/${id}.zip`,
    state,
    received: "100",
    total: "100",
    error: null,
    ...extra,
  });

  // The newest id sorts first, as the UI expects.
  let store = [
    view("0000000000000001-0", "completed"),
    view("0000000000000002-0", "receiving", { total: null, received: "40" }),
    view("0000000000000003-0", "failed", { error: "network" }),
  ];
  let preferences = {
    ask_destination: false,
    directory: "/home/person/Downloads",
    site_downloads_require_confirmation: false,
  };
  let calls = [];
  let cancelled = false;
  const native = {
    async list() {
      return store.map((entry) => ({ ...entry }));
    },
    async preferences() {
      return { ...preferences };
    },
    async setAskDestination(enabled) {
      calls.push(["ask", enabled]);
      preferences = { ...preferences, ask_destination: enabled };
      return true;
    },
    async chooseDirectory() {
      calls.push(["choose"]);
      if (cancelled) return { cancelled: true };
      preferences = { ...preferences, directory: "/home/person/Save here" };
      return { cancelled: false };
    },
    async cancel(id) {
      calls.push(["cancel", id]);
      return store.some((entry) => entry.id === id);
    },
    async open(id) {
      calls.push(["open", id]);
      return store.some((entry) => entry.id === id);
    },
    async reveal(id) {
      calls.push(["reveal", id]);
      return store.some((entry) => entry.id === id);
    },
    async forget(id) {
      calls.push(["forget", id]);
      const before = store.length;
      store = store.filter((entry) => entry.id !== id);
      return store.length !== before;
    },
    async clear() {
      calls.push(["clear"]);
      store = store.filter((entry) => entry.state === "receiving");
      return true;
    },
    async pause(id) {
      calls.push(["pause", id]);
      return store.some((entry) => entry.id === id && entry.state === "receiving");
    },
    async resume(id) {
      calls.push(["resume", id]);
      return store.some((entry) => entry.id === id && entry.state === "paused");
    },
    async keep(id) {
      calls.push(["keep", id]);
      return store.some((entry) => entry.id === id && entry.state === "held");
    },
    async discard(id) {
      calls.push(["discard", id]);
      return store.some((entry) => entry.id === id && entry.state === "held");
    },
  };

  reset();
  __setDownloadsNative(native);

  const page = await call(P, { kind: "list", before: null, limit: 2 });
  check("native list is a supported page", page.kind === "page" && page.supported === true);
  check("native list reflects the transfer count", page.entries.length === 2);
  check("native list is newest first", page.entries[0].id === "0000000000000003-0");
  check("native list carries a next cursor", page.next === "0000000000000002-0");
  const more = await call(P, { kind: "list", before: page.next, limit: 2 });
  check("native pagination returns the rest", more.kind === "page" && more.entries.length === 1);
  check("native pagination ends", more.next === null);
  check(
    "native entries keep the wire shape",
    more.entries.every(
      (entry) =>
        typeof entry.id === "string" &&
        typeof entry.revision === "string" &&
        typeof entry.state === "string" &&
        typeof entry.received === "string" &&
        (entry.total === null || typeof entry.total === "string"),
    ),
  );

  const prefs = await call(P, { kind: "preferences" });
  check("native preferences are supported", prefs.kind === "preferences" && prefs.supported === true);
  check("native preferences carry the resolved folder", prefs.preferences.directory === "/home/person/Downloads");
  check("ask is the inverse of useDownloadDir", prefs.preferences.ask_destination === false);
  check(
    "preferences carry only the wire fields",
    Object.keys(prefs.preferences).sort().join(",") === "ask_destination,directory",
  );
  check("profile is echoed", prefs.profile === P);

  const asked = await call(P, { kind: "set_ask_destination", enabled: true });
  check("asking first lands as preferences", asked.kind === "preferences" && asked.preferences.ask_destination === true);
  check("asking first reached the native seam", calls.some((call_) => call_[0] === "ask" && call_[1] === true));

  const chosen = await call(P, { kind: "choose_directory" });
  check("choosing a folder answers the new preferences", chosen.kind === "preferences");
  check("the chosen folder is the picker's", chosen.preferences.directory === "/home/person/Save here");

  cancelled = true;
  const cancelledChoice = await call(P, { kind: "choose_directory" });
  check("a cancelled picker is not an error", cancelledChoice.kind === "preferences");
  check("a cancelled picker leaves the folder alone", cancelledChoice.preferences.directory === "/home/person/Save here");

  const cancel = await call(P, { kind: "cancel", id: "0000000000000002-0" });
  check("cancel reaches the native transfer", cancel.kind === "applied");
  const unknown = await call(P, { kind: "cancel", id: "00000000000000ff-0" });
  check("an unknown transfer is unavailable, not applied", unknown.kind === "error" && unknown.error === "unavailable");
  const paused = await call(P, { kind: "pause", id: "0000000000000002-0" });
  check("pause reaches the native transfer", paused.kind === "applied");
  const pausedAgain = await call(P, { kind: "pause", id: "0000000000000001-0" });
  check("pause refuses a finished transfer", pausedAgain.kind === "error" && pausedAgain.error === "unavailable");
  const resumed = await call(P, { kind: "resume", id: "0000000000000002-0" });
  check("resume is refused for a transfer that is not paused", resumed.kind === "error" && resumed.error === "unavailable");
  const pausedEntry = await call(P, { kind: "pause", id: "0000000000000002-0" });
  check("pause is accepted for a receiving transfer", pausedEntry.kind === "applied");
  check("pause named the native transfer", calls.some((call_) => call_[0] === "pause" && call_[1] === "0000000000000002-0"));
  const kept = await call(P, { kind: "keep", id: "0000000000000003-0" });
  check("keep is unavailable for data the engine did not hold", kept.kind === "error" && kept.error === "unavailable");
  const discarded = await call(P, { kind: "discard", id: "0000000000000003-0" });
  check("discard is unavailable for data the engine did not hold", discarded.kind === "error" && discarded.error === "unavailable");

  const removedBefore = await call(P, { kind: "list", before: null, limit: 50 });
  check("the snapshot saw three transfers", removedBefore.entries.length === 3);
  store = store.filter((entry) => entry.id !== "0000000000000003-0");
  const updates = await call(P, { kind: "updates" });
  check("updates names the removed transfer", updates.removed.includes("0000000000000003-0"));
  check("updates still carries the remaining transfers", updates.entries.length === 2);

  const cleared = await call(P, { kind: "clear" });
  check("clear is accepted", cleared.kind === "accepted");
  const afterClear = await call(P, { kind: "list", before: null, limit: 50 });
  check("clear removed the finished transfer", afterClear.entries.length === 1);
  check("clear kept the transfer in progress", afterClear.entries[0].state === "receiving");

  // A native seam that refuses a write must not be reported as applied.
  __setDownloadsNative({
    ...native,
    async setAskDestination() {
      return false;
    },
  });
  const refused = await call(P, { kind: "set_ask_destination", enabled: false });
  check("a refused native write is unavailable", refused.kind === "error" && refused.error === "unavailable");

  reset();

  // A held (reputation-blocked) entry is the one case keep/discard accept.
  __setDownloadsNative({
    async list() {
      return [view("0000000000000004-0", "held", { error: "protection" })];
    },
    async preferences() {
      return { ...preferences };
    },
    async pause() {
      return false;
    },
    async resume() {
      return false;
    },
    async keep(id) {
      calls.push(["keep", id]);
      return id === "0000000000000004-0";
    },
    async discard(id) {
      calls.push(["discard", id]);
      return id === "0000000000000004-0";
    },
    async cancel() {
      return false;
    },
    async open() {
      return false;
    },
    async reveal() {
      return false;
    },
    async forget() {
      return false;
    },
    async clear() {
      return true;
    },
    async setAskDestination() {
      return true;
    },
    async chooseDirectory() {
      return { cancelled: true };
    },
  });
  const keptHeld = await call(P, { kind: "keep", id: "0000000000000004-0" });
  check("keep reaches a held transfer", keptHeld.kind === "applied");
  const droppedHeld = await call(P, { kind: "discard", id: "0000000000000004-0" });
  check("discard reaches a held transfer", droppedHeld.kind === "applied");
  const heldElsewhere = await call(P, { kind: "keep", id: "0000000000000005-0" });
  check("keep of an unknown held transfer is unavailable", heldElsewhere.kind === "error" && heldElsewhere.error === "unavailable");

  reset();
}

// --- Pause -> resume keeps a monotonic revision (2026-11-20) ----------------
// A resume used to return to the "receiving" rank, which sorted *below* the
// "paused" revision it replaced; the app drops a frame whose revision is not
// higher, so the row stayed paused and its progress froze.
{
  const { __revisionOf, __idOf } = await import(
    pathToFileURL(path.join(HOST, "Downloads.sys.mjs")).href
  );
  const transfer = { currentBytes: 1000, startTime: 1, stopped: false, succeeded: false };
  const receiving = __revisionOf(transfer, "d1");
  transfer.canceled = true;
  transfer.stopped = true;
  const paused = __revisionOf(transfer, "d1");
  check("the paused revision is higher than the receiving one", paused > receiving);
  transfer.canceled = false;
  transfer.stopped = false;
  transfer.currentBytes = 1000;
  const resumed = __revisionOf(transfer, "d1");
  check("a resume with no new bytes is still a higher revision", resumed > paused);
  transfer.currentBytes = 2000;
  const progress = __revisionOf(transfer, "d1");
  check("progress after a resume is higher again", progress > resumed);
  const stable = __revisionOf(transfer, "d1");
  check("an unchanged frame keeps its revision", stable === progress);

  // A resume rewrites `startTime`; the wire id must stay with the transfer or
  // the panel shows a second 0 B row whose Cancel cannot reach anything.
  const native = {
    startTime: new Date(1000),
    source: { url: "https://example.test/a.zip" },
    target: { path: "C:/Downloads/a.zip" },
  };
  const first = __idOf(native);
  native.startTime = new Date(9999);
  check("a resumed transfer keeps its wire id", __idOf(native) === first);
  const other = { ...native, target: { path: "C:/Downloads/b.zip" } };
  check("a different transfer gets a different id", __idOf(other) !== first);
}

console.log(`\ndownloads_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

