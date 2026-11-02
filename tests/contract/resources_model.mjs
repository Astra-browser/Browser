#!/usr/bin/env node
// Resources module contract (wiring): `resource_call` answers the UI's Tasks
// surface natively instead of failing with `unknown_command`.
//
//   - the reads the Tasks UI makes (`list_tasks`, `task_overview`) answer
//     well-formed `ResourceResponse` variants: the host holds no tasks and no
//     lists, and it never invents either
//   - `list_tasks` answers an empty final page with zero counts and no
//     metadata, so the panel shows its empty state instead of failing
//   - `task_overview` answers no lists and zero counts
//   - the generic `list` answers an empty final page for every resource kind
//   - `get` answers `not_found`, not a record: the listings are authoritative
//     and empty
//   - `acknowledge` answers `acknowledged`: there is no applied write to
//     settle
//   - every mutation (task create/update/trash/restore, task-list
//     create/rename/delete, and the object/artifact writes) answers the
//     reply's own `error: "unavailable"` — never `applied`, never
//     `task_list_applied`, never a minted id or revision
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
//   - a malformed or unknown call answers `error: "invalid"`, every error code
//     stays inside `ResourceError`, and nothing throws
//
// Usage: node tests/contract/resources_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Resources } = await import(path.join(HOST, "Resources.sys.mjs"));

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
const ID = "0000000000000000000000000a";
const LIST = "0000000000000000000000000b";
const REQUEST = "0000000000000000000000000c";
const TODAY = "2026-11-03";

/** `ResourceError`, exactly as the wire declares it. */
const RESOURCE_ERRORS = new Set([
  "invalid",
  "not_found",
  "conflict",
  "capacity",
  "unavailable",
  "outcome_unknown",
]);

/** `ResourceResponse` discriminants, exactly as the wire declares them. */
const RESPONSE_KINDS = new Set([
  "acknowledged",
  "record",
  "page",
  "task_list_applied",
  "task_page",
  "task_overview",
  "applied",
  "error",
]);

/** `TaskView`, exactly as the wire declares it. */
const VIEWS = ["inbox", "today", "upcoming", "all", "completed", "trash"];

/** `ResourceKind`, exactly as the wire declares it. */
const KINDS = ["note", "task", "object", "media"];

const call = (profile, body) => Resources.call({ profile, call: body });

const isError = (res, code) =>
  !!res && !!res.response && res.response.kind === "error" &&
  res.response.error === code;

const isTaskPage = (res) =>
  !!res && !!res.response && res.response.kind === "task_page" &&
  Array.isArray(res.response.items) && res.response.items.length === 0 &&
  Array.isArray(res.response.metadata) && res.response.metadata.length === 0 &&
  Array.isArray(res.response.lists) && res.response.lists.length === 0 &&
  res.response.next === null;

const isPage = (res) =>
  !!res && !!res.response && res.response.kind === "page" &&
  Array.isArray(res.response.items) && res.response.items.length === 0 &&
  res.response.next === null;

const zeroCounts = (counts) =>
  !!counts && typeof counts === "object" &&
  Object.keys(counts).length === 7 &&
  Object.values(counts).every((value) => value === 0);

const taskQuery = (over = {}) => ({
  list: null,
  view: "all",
  today: TODAY,
  search: "",
  after: null,
  limit: 100,
  ...over,
});

const resourceQuery = (over = {}) => ({
  kind: "task",
  search: "",
  trashed: false,
  after: null,
  limit: 100,
  ...over,
});

const draft = (over = {}) => ({
  title: "Write the plan",
  pinned: false,
  related: [],
  content: { kind: "note", document: { markdown: "" } },
  ...over,
});

const command = (intent, over = {}) => ({
  version: 1,
  request_id: REQUEST,
  intent,
  ...over,
});

/** Every reply is one `ResourceResponse` variant with the profile echoed. */
function wellFormed(res, profile) {
  return (
    !!res &&
    typeof res === "object" &&
    res.profile === profile &&
    !!res.response &&
    typeof res.response === "object" &&
    RESPONSE_KINDS.has(res.response.kind)
  );
}

// === The reads the Tasks UI makes: empty, honest, well formed ==============
for (const view of VIEWS) {
  const res = await call(P, { kind: "list_tasks", query: taskQuery({ view }) });
  check(`list_tasks (${view}) is a task_page reply`, res.response.kind === "task_page");
  check(`list_tasks (${view}) echoes the profile`, res.profile === P);
  check(`list_tasks (${view}) holds no tasks`, isTaskPage(res));
  check(`list_tasks (${view}) has no next page`, res.response.next === null);
  check(`list_tasks (${view}) reports zero counts`, zeroCounts(res.response.counts));
  check(`list_tasks (${view}) names no list`, res.response.lists.length === 0);
  check(`list_tasks (${view}) is not an error`, res.response.kind !== "error");
}

{
  const res = await call(P, {
    kind: "list_tasks",
    query: taskQuery({ view: "today", search: "plan", limit: 200 }),
  });
  check("a searching list_tasks is still an empty task_page", isTaskPage(res));
  check("a searching list_tasks still reports zero counts",
    zeroCounts(res.response.counts));
}

{
  const res = await call(P, { kind: "task_overview", today: TODAY });
  check("task_overview is a task_overview reply", res.response.kind === "task_overview");
  check("task_overview echoes the profile", res.profile === P);
  check("task_overview holds no lists",
    Array.isArray(res.response.lists) && res.response.lists.length === 0);
  check("task_overview reports zero counts", zeroCounts(res.response.counts));
  check("task_overview carries no rows", res.response.items === undefined);
  check("task_overview is not an error", res.response.kind !== "error");
}

for (const kind of KINDS) {
  const res = await call(P, { kind: "list", query: resourceQuery({ kind }) });
  check(`list (${kind}) is a page reply`, res.response.kind === "page");
  check(`list (${kind}) echoes the profile`, res.profile === P);
  check(`list (${kind}) holds no records`, isPage(res));
  check(`list (${kind}) is not an error`, res.response.kind !== "error");
}

{
  const res = await call(P, {
    kind: "list",
    query: resourceQuery({ kind: "task", trashed: true, completed: false }),
  });
  check("a filtered list is still an empty page", isPage(res));
}

// === Reads that name one record: not_found, not a guess ====================
{
  const res = await call(P, { kind: "get", id: ID });
  check("get of an unknown id is not_found", isError(res, "not_found"));
  check("get echoes the profile", res.profile === P);
  check("get never returns a record", res.response.kind !== "record");
  check("get mints no revision", res.response.revision === undefined);
}

{
  const res = await call(P, { kind: "acknowledge", request_id: REQUEST });
  check("acknowledge is an acknowledged reply", res.response.kind === "acknowledged");
  check("acknowledge echoes the profile", res.profile === P);
  check("acknowledge claims no applied revision",
    res.response.applied_revision === undefined);
}

// === Empty honesty: repeated reads never invent a row ======================
{
  const first = await call(P, { kind: "list_tasks", query: taskQuery() });
  const second = await call(P, { kind: "list_tasks", query: taskQuery() });
  check("repeated task listings stay empty",
    JSON.stringify(first) === JSON.stringify(second) && first.response.items.length === 0);

  const overview = await call(P, { kind: "task_overview", today: TODAY });
  check("the overview agrees with the empty page",
    overview.response.counts.all === 0 && overview.response.lists.length === 0);
  check("the overview counts every bucket, all zero",
    zeroCounts(overview.response.counts));

  const page = await call(P, { kind: "list", query: resourceQuery() });
  check("task and generic listings agree on an empty set",
    page.response.items.length === first.response.items.length);
  check("no task-shaped object is returned",
    first.response.items.length === 0 && first.response.metadata.length === 0);
  check("no list-shaped object is returned",
    first.response.lists.length === 0 && overview.response.lists.length === 0);

  const get = await call(P, { kind: "get", id: ID });
  check("get agrees with the empty listings", isError(get, "not_found"));
  check("nothing is ever applied by a read",
    [first, second, overview, page, get].every((res) =>
      res.response.kind !== "applied" && res.response.kind !== "task_list_applied"));
}

// === Profile scoping =======================================================
{
  const mine = await call(P, { kind: "list_tasks", query: taskQuery() });
  const theirs = await call(OTHER, { kind: "task_overview", today: TODAY });
  check("each reply echoes its own profile",
    mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits rows",
    mine.response.items.length === 0 && theirs.response.lists.length === 0);

  const alias = await Resources.call({
    expected_profile: P,
    call: { kind: "task_overview", today: TODAY },
  });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
  check("a scoped reply is still well formed", wellFormed(alias, P));
}

// === Mutations: the reply's own refusal, never a fake success ==============
const MUTATIONS = [
  ["create_task_list", command({ kind: "create_task_list", title: "Reading" })],
  [
    "rename_task_list",
    command({
      kind: "rename_task_list",
      id: LIST,
      expected_revision: "1",
      title: "Reading",
    }),
  ],
  [
    "delete_task_list",
    command({ kind: "delete_task_list", id: LIST, expected_revision: "1" }),
  ],
  ["create a task", command({ kind: "create", draft: draft() })],
  [
    "replace",
    command({ kind: "replace", id: ID, expected_revision: "1", draft: draft() }),
  ],
  ["trash", command({ kind: "trash", id: ID, expected_revision: "1" })],
  ["restore", command({ kind: "restore", id: ID, expected_revision: "1" })],
  [
    "update_task",
    command({
      kind: "update_task",
      id: ID,
      set: [{ field: "title", value: "Renamed" }],
      expect: [],
    }),
  ],
  [
    "update_task with an empty set",
    command({ kind: "update_task", id: ID, set: [], expect: [] }),
  ],
  [
    "preserve_artifact",
    command({
      kind: "preserve_artifact",
      objective: ID,
      execution: LIST,
      artifact: REQUEST,
      basis: {},
      title: null,
    }),
  ],
];
for (const [name, body] of MUTATIONS) {
  const res = await call(P, { kind: "mutate", command: body });
  check(`${name} answers error unavailable`, isError(res, "unavailable"));
  check(`${name} never claims an applied record`,
    res.response.kind !== "applied" && res.response.kind !== "task_list_applied");
  check(`${name} mints no id`, res.response.id === undefined &&
    res.response.record === undefined && res.response.list === undefined);
  check(`${name} echoes the profile`, res.profile === P);
}

{
  // The panel reads back after a write; a refused write must leave the store
  // empty rather than half-applied.
  await call(P, {
    kind: "mutate",
    command: command({ kind: "create_task_list", title: "Reading" }),
  });
  const after = await call(P, { kind: "task_overview", today: TODAY });
  check("a refused write leaves no list behind",
    after.response.kind === "task_overview" && after.response.lists.length === 0);

  // `create` through a read-shaped kind is not a write this module accepts.
  const shaped = await call(P, { kind: "create", draft: draft() });
  check("a read-shaped create is refused, not applied",
    isError(shaped, "invalid") && shaped.response.kind !== "applied");
}

// === Malformed writes: invalid, not unavailable ============================
const MALFORMED_MUTATIONS = [
  [
    "mutate without a command",
    { kind: "mutate" },
  ],
  [
    "mutate without a version",
    { kind: "mutate", command: { request_id: REQUEST, intent: { kind: "trash", id: ID, expected_revision: "1" } } },
  ],
  [
    "mutate without a request_id",
    { kind: "mutate", command: { version: 1, intent: { kind: "trash", id: ID, expected_revision: "1" } } },
  ],
  [
    "mutate without an intent",
    { kind: "mutate", command: { version: 1, request_id: REQUEST } },
  ],
  [
    "an unknown intent",
    { kind: "mutate", command: command({ kind: "teleport", id: ID }) },
  ],
  [
    "create_task_list without a title",
    { kind: "mutate", command: command({ kind: "create_task_list" }) },
  ],
  [
    "create_task_list with an empty title",
    { kind: "mutate", command: command({ kind: "create_task_list", title: "" }) },
  ],
  [
    "create_task_list past the UI's cap",
    { kind: "mutate", command: command({ kind: "create_task_list", title: "a".repeat(65) }) },
  ],
  [
    "rename_task_list without an id",
    { kind: "mutate", command: command({ kind: "rename_task_list", expected_revision: "1", title: "Reading" }) },
  ],
  [
    "delete_task_list without an expected revision",
    { kind: "mutate", command: command({ kind: "delete_task_list", id: LIST }) },
  ],
  [
    "create without a draft",
    { kind: "mutate", command: command({ kind: "create" }) },
  ],
  [
    "create with a draft missing its content",
    { kind: "mutate", command: command({ kind: "create", draft: { title: "x", pinned: false, related: [] } }) },
  ],
  [
    "trash without a revision",
    { kind: "mutate", command: command({ kind: "trash", id: ID }) },
  ],
  [
    "update_task without a set",
    { kind: "mutate", command: command({ kind: "update_task", id: ID }) },
  ],
  [
    "update_task with a non-array set",
    { kind: "mutate", command: command({ kind: "update_task", id: ID, set: "title" }) },
  ],
  [
    "update_task with an unknown field",
    { kind: "mutate", command: command({ kind: "update_task", id: ID, set: [{ field: "colour", value: "red" }] }) },
  ],
  [
    "update_task with a non-array expect",
    { kind: "mutate", command: command({ kind: "update_task", id: ID, set: [{ field: "title", value: "x" }], expect: "none" }) },
  ],
  [
    "preserve_artifact without a basis",
    { kind: "mutate", command: command({ kind: "preserve_artifact", objective: ID, execution: LIST, artifact: REQUEST }) },
  ],
];
for (const [name, body] of MALFORMED_MUTATIONS) {
  const res = await call(P, body);
  check(`${name} is invalid`, isError(res, "invalid"));
  check(`${name} never claims an applied record`,
    res.response.kind !== "applied" && res.response.kind !== "task_list_applied");
}

// === Malformed reads: invalid, not a guess =================================
const MALFORMED_READS = [
  ["list_tasks without a query", { kind: "list_tasks" }],
  ["list_tasks with a non-object query", { kind: "list_tasks", query: [] }],
  ["list_tasks with an unknown view", { kind: "list_tasks", query: taskQuery({ view: "later" }) }],
  ["list_tasks without a today", { kind: "list_tasks", query: taskQuery({ today: undefined }) }],
  ["list_tasks with a numeric today", { kind: "list_tasks", query: taskQuery({ today: 7 }) }],
  ["list_tasks with a malformed today", { kind: "list_tasks", query: taskQuery({ today: "03/11/2026" }) }],
  ["list_tasks with a numeric list", { kind: "list_tasks", query: taskQuery({ list: 7 }) }],
  ["list_tasks with a numeric search", { kind: "list_tasks", query: taskQuery({ search: 7 }) }],
  ["list_tasks with an over-long search", { kind: "list_tasks", query: taskQuery({ search: "a".repeat(513) }) }],
  ["list_tasks with an empty after", { kind: "list_tasks", query: taskQuery({ after: "" }) }],
  ["list_tasks with a zero limit", { kind: "list_tasks", query: taskQuery({ limit: 0 }) }],
  ["list_tasks with a fractional limit", { kind: "list_tasks", query: taskQuery({ limit: 1.5 }) }],
  ["list_tasks past the page cap", { kind: "list_tasks", query: taskQuery({ limit: 1001 }) }],
  ["task_overview without a today", { kind: "task_overview" }],
  ["task_overview with a numeric today", { kind: "task_overview", today: 7 }],
  ["list without a query", { kind: "list" }],
  ["list with an unknown kind", { kind: "list", query: resourceQuery({ kind: "album" }) }],
  ["list with a non-boolean trashed", { kind: "list", query: resourceQuery({ trashed: "no" }) }],
  ["list with a non-boolean completed", { kind: "list", query: resourceQuery({ completed: "yes" }) }],
  ["list with a numeric search", { kind: "list", query: resourceQuery({ search: 7 }) }],
  ["list with an empty after", { kind: "list", query: resourceQuery({ after: "" }) }],
  ["list with a zero limit", { kind: "list", query: resourceQuery({ limit: 0 }) }],
  ["get without an id", { kind: "get" }],
  ["get with an empty id", { kind: "get", id: "" }],
  ["get with a numeric id", { kind: "get", id: 7 }],
  ["acknowledge without a request_id", { kind: "acknowledge" }],
  ["acknowledge with an empty request_id", { kind: "acknowledge", request_id: "" }],
];
for (const [name, body] of MALFORMED_READS) {
  const res = await call(P, body);
  check(`${name} is invalid`, isError(res, "invalid"));
  check(`${name} echoes the profile`, res.profile === P);
}

{
  const longest = await call(P, {
    kind: "list_tasks",
    query: taskQuery({ search: "a".repeat(512), limit: 1000 }),
  });
  check("a query at the caps is accepted", isTaskPage(longest));
}

// === Malformed and unknown calls: the reply's own error, no crash ==========
for (const kind of ["resource", "teleport", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isError(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: ID });
  check("a call without a kind is invalid", isError(noKind, "invalid"));

  const nullCall = await call(P, null);
  check("a null call is invalid", isError(nullCall, "invalid"));

  const arrayCall = await call(P, []);
  check("an array call is invalid", isError(arrayCall, "invalid"));

  const noProfile = await Resources.call({
    call: { kind: "task_overview", today: TODAY },
  });
  check("a call without a profile is invalid",
    isError(noProfile, "invalid") && noProfile.profile === null);

  const badProfile = await Resources.call({
    profile: 42,
    call: { kind: "task_overview", today: TODAY },
  });
  check("a non-string profile is invalid",
    isError(badProfile, "invalid") && badProfile.profile === null);

  const emptyProfile = await Resources.call({
    profile: "",
    expected_profile: "",
    call: { kind: "task_overview", today: TODAY },
  });
  check("an empty profile is invalid", isError(emptyProfile, "invalid"));

  const nothing = await Resources.call();
  check("no arguments is invalid, not a throw", isError(nothing, "invalid"));
}

// === Every reply stays inside the wire vocabulary ==========================
{
  const replies = [
    await call(P, { kind: "list_tasks", query: taskQuery() }),
    await call(P, { kind: "task_overview", today: TODAY }),
    await call(P, { kind: "list", query: resourceQuery() }),
    await call(P, { kind: "get", id: ID }),
    await call(P, { kind: "acknowledge", request_id: REQUEST }),
    await call(P, {
      kind: "mutate",
      command: command({ kind: "trash", id: ID, expected_revision: "1" }),
    }),
    await call(P, { kind: "nope" }),
  ];
  check("every reply is a ResourceResponse variant",
    replies.every((res) => wellFormed(res, P)));
  check("every error code is a ResourceError",
    replies
      .filter((res) => res.response.kind === "error")
      .every((res) => RESOURCE_ERRORS.has(res.response.error)));
}

// === The module never throws ===============================================
{
  let threw = false;
  const hostile = [
    { kind: "task_overview", today: TODAY, extra: () => {} },
    Object.create(null),
    {
      kind: "list_tasks",
      query: {
        get view() {
          throw new Error("hostile payload");
        },
      },
    },
    { kind: "get", id: { toString: () => ID } },
    {
      kind: "mutate",
      command: {
        version: 1,
        request_id: REQUEST,
        intent: {
          get kind() {
            throw new Error("hostile payload");
          },
        },
      },
    },
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
}

console.log(`\nresources_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
