#!/usr/bin/env node
// Work module contract (wiring slice): `work_running` and `work_call` answer
// the Work surface natively instead of failing with `unknown_command`.
//
//   - running() is false: nothing runs natively yet
//   - the read-only calls the surface makes at open (`environment list`,
//     `open`, `read`) return well-formed replies with the profile echoed
//   - a listed Space is empty and every Work reads as an empty environment:
//     no elements, no areas, no invented title, id or revision
//   - calls that need the Work store or runtime (`checkpoint`, `command`,
//     `query`, `author`, `execute`) return the reply's own error variant,
//     never a crash and never `{ ok: true }`
//   - an unknown or malformed call is refused as `invalid`
//
// Usage: node tests/contract/work_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Work, __resetWorkForTests } = await import(path.join(HOST, "Work.sys.mjs"));

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

const PROFILE = "00000000000000000000000001";
const OTHER = "00000000000000000000000009";
const SPACE = "00000000000000000000000003";
const WORK = "00000000000000000000000002";

/** The revision rule the surface enforces (`validRevision` in work-model.ts). */
const REVISION = /^[1-9][0-9]{0,19}$/u;

/** Call with the wire name the bridge sends (camelCase -> snake_case). */
function call(profile, body) {
  return Work.call({ expected_profile: profile, call: body });
}
function environment(profile, request) {
  return call(profile, { kind: "environment", version: 1, request });
}
function listed(profile = PROFILE, space = SPACE) {
  return environment(profile, { kind: "list", space, after: null, limit: 32 });
}
/** Every reply is an envelope the surface can admit: version, profile, reply. */
function wellFormed(res, profile) {
  return (
    !!res &&
    typeof res === "object" &&
    res.version === 1 &&
    res.profile === profile &&
    !!res.reply &&
    typeof res.reply === "object" &&
    typeof res.reply.kind === "string"
  );
}
function snapshotOf(res) {
  return res?.reply?.kind === "environment" && res.reply.reply.kind === "snapshot"
    ? res.reply.reply.snapshot
    : null;
}

__resetWorkForTests();

// === Running ===
{
  const running = await Work.running();
  check("running() answers a boolean", typeof running === "boolean");
  check("running() is false: nothing runs natively", running === false);
  check("running() ignores a request id", (await Work.running({ request_id: "r-1" })) === false);
}

// === The empty list at open ===
{
  const res = await listed();
  check("list is well formed", wellFormed(res, PROFILE));
  check("list is an environment reply", res.reply.kind === "environment");
  check("list is a page", res.reply.reply.kind === "page");
  check("list has no works", Array.isArray(res.reply.reply.works) && res.reply.reply.works.length === 0);
  check("list has no next page", res.reply.reply.next === null);
  check("list selects nothing", res.reply.reply.selected === null);
  check(
    "list invents no summary",
    res.reply.reply.works.every((work) => !!work && typeof work.id === "string"),
  );
  check("list is JSON-safe", JSON.parse(JSON.stringify(res)).reply.reply.works.length === 0);
}

// === Opening a Work: an empty environment, never an invented one ===
{
  const opened = await environment(PROFILE, { kind: "open", id: WORK });
  check("open is well formed", wellFormed(opened, PROFILE));
  check("open is an environment reply", opened.reply.kind === "environment");
  check("open is a snapshot", opened.reply.reply.kind === "snapshot");
  const snapshot = snapshotOf(opened);
  check("open carries a snapshot", !!snapshot);
  check("snapshot version is 1", snapshot?.version === 1);
  check("snapshot echoes the profile", snapshot?.profile === PROFILE);
  check("snapshot echoes the id", snapshot?.id === WORK);
  check("snapshot names the listed Space", snapshot?.space === SPACE);
  check("snapshot is active", snapshot?.lifecycle === "active");
  check("snapshot revision is a revision", REVISION.test(snapshot?.revision ?? ""));
  check("snapshot has no elements", Array.isArray(snapshot?.elements) && snapshot.elements.length === 0);
  check("snapshot has no areas", Array.isArray(snapshot?.areas) && snapshot.areas.length === 0);
  check("snapshot has no relations", !("relations" in (snapshot ?? {})));
  check("snapshot has no decisions", !("decisions" in (snapshot ?? {})));
  check("snapshot view revision is a revision", REVISION.test(snapshot?.view?.revision ?? ""));
  check("snapshot view has no placements", Array.isArray(snapshot?.view?.placements) && snapshot.view.placements.length === 0);
  check("snapshot view is at the origin", snapshot?.view?.x === 0 && snapshot?.view?.y === 0);
  check("snapshot view is unzoomed", snapshot?.view?.zoom_milli === 1000);
  check("snapshot title is not invented", snapshot?.title === "");
  check(
    "open is JSON-safe",
    JSON.stringify(JSON.parse(JSON.stringify(opened))) === JSON.stringify(opened),
  );
}

// === Reading a Work is the same empty environment ===
{
  const read = await environment(PROFILE, { kind: "read", id: WORK });
  const opened = await environment(PROFILE, { kind: "open", id: WORK });
  check("read is well formed", wellFormed(read, PROFILE));
  check("read is a snapshot", read.reply.kind === "environment" && read.reply.reply.kind === "snapshot");
  check("read matches open", JSON.stringify(read) === JSON.stringify(opened));
}

// === Nothing is invented: reads never grow the list ===
{
  const res = await listed();
  check("reading a Work does not add one to the list", res.reply.reply.works.length === 0);
  const snapshot = snapshotOf(await environment(PROFILE, { kind: "read", id: WORK }));
  check("reading invents no element", snapshot.elements.length === 0);
  check("reading invents no area", snapshot.areas.length === 0);
}

// === Writes are refused with the reply's error variant ===
{
  const create = await environment(PROFILE, {
    kind: "command",
    command: "00000000000000000000000004",
    intent: { kind: "create", space: SPACE, title: "A Work" },
  });
  check("create is well formed", wellFormed(create, PROFILE));
  check("create is refused", create.reply.kind === "error");
  check("create refuses as unavailable", create.reply.error === "unavailable");

  const checkpoint = await environment(PROFILE, {
    kind: "checkpoint",
    id: WORK,
    expected: "1",
    view: { revision: "1", x: 10, y: 20, zoom_milli: 1500, placements: [] },
  });
  check("checkpoint is refused", checkpoint.reply.kind === "error");
  check("checkpoint refuses as unavailable", checkpoint.reply.error === "unavailable");
  check("checkpoint echoes the profile", checkpoint.profile === PROFILE);
}

// === Queries and runs need the runtime ===
{
  const projection = await call(PROFILE, {
    kind: "query",
    request: { version: 1, query: { kind: "projection", work: WORK } },
  });
  check("query is well formed", wellFormed(projection, PROFILE));
  check("query is refused", projection.reply.kind === "error");
  check("query refuses as unavailable", projection.reply.error === "unavailable");

  const list = await call(PROFILE, {
    kind: "query",
    request: { version: 1, query: { kind: "list", after: null, limit: 32 } },
  });
  check("query list is refused", list.reply.kind === "error" && list.reply.error === "unavailable");

  const author = await call(PROFILE, { kind: "author", command: { kind: "ask" } });
  check("author is refused", author.reply.kind === "error" && author.reply.error === "unavailable");

  const execute = await call(PROFILE, { kind: "execute", command: { kind: "run" } });
  check("execute is refused", execute.reply.kind === "error" && execute.reply.error === "unavailable");
}

// === Unknown and malformed calls are refused, never thrown ===
{
  const unknown = await call(PROFILE, { kind: "teleport" });
  check("an unknown call is well formed", wellFormed(unknown, PROFILE));
  check("an unknown call is an error", unknown.reply.kind === "error");
  check("an unknown call is invalid", unknown.reply.error === "invalid");

  const unknownRequest = await environment(PROFILE, { kind: "rewind" });
  check("an unknown environment request is invalid", unknownRequest.reply.kind === "error" && unknownRequest.reply.error === "invalid");

  const wrongVersion = await call(PROFILE, {
    kind: "environment",
    version: 2,
    request: { kind: "list", space: SPACE, after: null, limit: 32 },
  });
  check("a future grammar version is invalid", wrongVersion.reply.kind === "error" && wrongVersion.reply.error === "invalid");

  const missingSpace = await environment(PROFILE, { kind: "list", after: null, limit: 32 });
  check("a list without a Space is invalid", missingSpace.reply.kind === "error" && missingSpace.reply.error === "invalid");

  const missingId = await environment(PROFILE, { kind: "open" });
  check("an open without an id is invalid", missingId.reply.kind === "error" && missingId.reply.error === "invalid");

  const noRequest = await call(PROFILE, { kind: "environment", version: 1 });
  check("an environment call without a request is invalid", noRequest.reply.kind === "error" && noRequest.reply.error === "invalid");

  const junk = [null, undefined, "work", 7, {}, { call: null }, { expected_profile: 5, call: { kind: "environment" } }];
  let threw = false;
  const replies = [];
  for (const input of junk) {
    try {
      replies.push(await Work.call(input));
    } catch {
      threw = true;
    }
  }
  check("no input throws", !threw);
  check("every junk input answers an envelope", replies.every((res) => res?.version === 1 && res.reply.kind === "error"));
  check("a missing profile echoes an empty profile", replies[0].profile === "");
  check("a missing profile is invalid", replies[0].reply.error === "invalid");
}

// === Profile scoping ===
{
  __resetWorkForTests();
  await listed(PROFILE);
  const other = await environment(OTHER, { kind: "open", id: WORK });
  check("another profile does not inherit the Space", other.reply.kind === "error" && other.reply.error === "invalid");
  check("another profile is still echoed", other.profile === OTHER);

  const mine = await environment(PROFILE, { kind: "open", id: WORK });
  check("the listed profile keeps its Space", snapshotOf(mine)?.space === SPACE);

  __resetWorkForTests();
  const cold = await environment(PROFILE, { kind: "open", id: WORK });
  check("an open before any list invents no Space", cold.reply.kind === "error" && cold.reply.error === "invalid");
}

// === The wire name the UI sends ===
{
  __resetWorkForTests();
  const res = await Work.call({
    expected_profile: PROFILE,
    profile: OTHER,
    call: { kind: "environment", version: 1, request: { kind: "list", space: SPACE, after: null, limit: 32 } },
    request_id: "r-2",
  });
  check("expected_profile wins over profile", res.profile === PROFILE);
  const direct = await Work.call({
    profile: PROFILE,
    call: { kind: "environment", version: 1, request: { kind: "list", space: SPACE, after: null, limit: 32 } },
  });
  check("a direct caller may pass profile", direct.profile === PROFILE && wellFormed(direct, PROFILE));
}

// === No reply ever claims success for an unwired call ===
{
  const replies = [
    await environment(PROFILE, { kind: "checkpoint", id: WORK, expected: "1", view: { revision: "1", x: 0, y: 0, zoom_milli: 1000, placements: [] } }),
    await environment(PROFILE, { kind: "command", command: "c", intent: { kind: "create", space: SPACE, title: "x" } }),
    await call(PROFILE, { kind: "query", request: { version: 1, query: { kind: "list", after: null, limit: 32 } } }),
  ];
  check(
    "no refused call is a fake success",
    replies.every((res) => res.reply.kind === "error" && !("ok" in res)),
  );
  check(
    "no refused call carries a snapshot",
    replies.every((res) => !snapshotOf(res)),
  );
  assert.ok(replies.every((res) => res.reply.kind === "error"));
}

console.log(`\nwork_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
