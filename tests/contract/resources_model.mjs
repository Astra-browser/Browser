#!/usr/bin/env node
// Resources module contract (wiring): `resource_call` answers the UI's Tasks
// surface natively instead of failing with `unknown_command`, and now saves.
//
//   - `create` admits a task draft and answers `applied` with the stored
//     record; a second read finds it
//   - `list_tasks` computes the real views (`inbox`, `today`, `upcoming`,
//     `all`, `completed`, `trash`) against the caller's `today`, with search,
//     list filter, ordering, paging and the real counts and lists
//   - `task_overview` agrees with the page: the same counts and lists
//   - `update_task` writes the `set` fields only when every `expect` holds,
//     bumps the revision and answers the new record; a stale expectation is
//     `conflict`
//   - completing a task moves it between views and moves the counts; leaving
//     `done` puts it back
//   - `trash` and `restore` change `trashed` under a revision check
//   - task-list create/rename/delete answer `task_list_applied`, and deleting
//     a list moves its tasks to the inbox instead of dropping them
//   - `get` answers the record or `not_found`; `acknowledge` settles a request
//   - a replayed request id is answered once and never applied twice while its
//     receipt is kept; `acknowledge` settles that receipt
//   - every reply echoes the profile, so no profile's state is another's
//   - malformed or hostile calls answer `error: "invalid"`, every error stays
//     inside `ResourceError`, and nothing throws
//
// Usage: node tests/contract/resources_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, UI, check, passed, failed } from "./lib/harness.mjs";

const { Resources, __resetResourcesForTests } = await import(pathToFileURL(path.join(HOST, "Resources.sys.mjs")).href);

const P = "00000000000000000000000001";
const OTHER = "00000000000000000000000002";
const MISSING = "0000000000000000000000000a";
const TODAY = "2026-11-03";
const YESTERDAY = "2026-11-02";
const TOMORROW = "2026-11-04";

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

const call = (profile, body) => Resources.call({ profile, call: body });

const isError = (res, code) =>
  !!res &&
  !!res.response &&
  res.response.kind === "error" &&
  res.response.error === code;

const countsShape = (counts) =>
  !!counts &&
  typeof counts === "object" &&
  Object.keys(counts).length === 7 &&
  ["inbox", "today", "overdue", "upcoming", "all", "completed", "trash"].every(
    (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
  );

const zeroCounts = (counts) =>
  countsShape(counts) && Object.values(counts).every((value) => value === 0);

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

let serial = 0;
const request = () => `request-${++serial}`;

/** A task draft exactly as `TaskSession.create` builds one, with overrides. */
function taskDraft({ title = "Write the plan", pinned = false, related = [], ...content } = {}) {
  const { details = {}, ...rest } = content;
  return {
    title,
    pinned,
    related,
    content: {
      kind: "task",
      description: rest.description ?? "",
      completed: rest.completed ?? false,
      status: rest.status ?? "open",
      assignee: rest.assignee ?? "user",
      origin: rest.origin ?? "user",
      due_date: rest.due_date ?? null,
      due_time: rest.due_time ?? null,
      context: rest.context ?? null,
      sort_key: rest.sort_key ?? null,
      work: rest.work ?? null,
      details: {
        list: null,
        inbox: true,
        priority: "none",
        steps: [],
        completed_at: null,
        deadline: null,
        duration: null,
        ...details,
      },
    },
  };
}

const command = (intent, over = {}) => ({
  version: 1,
  request_id: request(),
  intent,
  ...over,
});

async function create(profile, over = {}, id = request()) {
  return call(profile, {
    kind: "mutate",
    command: {
      version: 1,
      request_id: id,
      intent: { kind: "create", draft: taskDraft(over) },
    },
  });
}

async function update(profile, id, set, expect = [], requestId = request()) {
  return call(profile, {
    kind: "mutate",
    command: {
      version: 1,
      request_id: requestId,
      intent: { kind: "update_task", id, set, expect },
    },
  });
}

async function setTrashed(profile, id, revision, kind = "trash", requestId = request()) {
  return call(profile, {
    kind: "mutate",
    command: {
      version: 1,
      request_id: requestId,
      intent: { kind, id, expected_revision: revision },
    },
  });
}

const listTasks = (profile, over = {}) =>
  call(profile, { kind: "list_tasks", query: taskQuery(over) });

const overview = (profile, today = TODAY) =>
  call(profile, { kind: "task_overview", today });

const get = (profile, id) => call(profile, { kind: "get", id });

const itemsOf = (res) => res.response.items ?? [];
const idsOf = (res) => itemsOf(res).map((item) => item.id);
const metaOf = (res, id) => res.response.metadata.find((meta) => meta.id === id);

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

function taskPageShape(res) {
  return (
    res.response.kind === "task_page" &&
    Array.isArray(res.response.items) &&
    Array.isArray(res.response.metadata) &&
    Array.isArray(res.response.lists) &&
    countsShape(res.response.counts) &&
    (res.response.next === null || typeof res.response.next === "string")
  );
}

__resetResourcesForTests();

// === A task is created, stored and read back ===============================
{
  const created = await create(P, { title: "Write the plan" });
  const response = created.response;
  const record = response.record;
  check("create is an applied reply", response.kind === "applied");
  check("create echoes the profile", created.profile === P);
  check("create echoes the request id", response.request_id !== undefined);
  check("create reports the revision it applied", response.applied_revision === "1");
  check("create mints an opaque 26-digit id", /^\d{26}$/.test(record.id));
  check("create starts at revision 1", record.revision === "1");
  check("create stores a task draft", record.draft.content.kind === "task");
  check("create keeps the title", record.draft.title === "Write the plan");
  check("create starts unpinned", record.draft.pinned === false);
  check("create starts untrashed", record.trashed === false);
  check("create starts open", record.draft.content.status === "open");
  check("create starts incomplete", record.draft.content.completed === false);
  check("create stamps a decimal creation time", /^\d+$/.test(record.created_at));
  check("create stamps a decimal update time", /^\d+$/.test(record.updated_at));
  check("create defaults the list to none", record.draft.content.details.list === null);
  check("create defaults the priority to none", record.draft.content.details.priority === "none");
  check("create defaults the steps to none", record.draft.content.details.steps.length === 0);
  check("create defaults the assignee to the person", record.draft.content.assignee === "user");
  check("create defaults the origin to the person", record.draft.content.origin === "user");

  const all = await listTasks(P);
  check("list_tasks answers a task_page", taskPageShape(all));
  check("list_tasks finds the created task", idsOf(all).includes(record.id));
  check("list_tasks reports it once", idsOf(all).length === 1);
  check("list_tasks carries its metadata", metaOf(all, record.id)?.inbox === true);
  check("list_tasks reports one active task", all.response.counts.all === 1);
  check("list_tasks reports one inbox task", all.response.counts.inbox === 1);
  check("list_tasks has no further page", all.response.next === null);

  const found = await get(P, record.id);
  check("get answers a record", found.response.kind === "record");
  check("get returns the same id", found.response.record?.id === record.id);
  check("get returns the same revision", found.response.record?.revision === "1");

  const missing = await get(P, MISSING);
  check("get of an unknown id is not_found", isError(missing, "not_found"));
  check("get echoes the profile", missing.profile === P);
  check("get mints no revision", missing.response.revision === undefined);
}

// === Views and counts place a task by its day ==============================
{
  const profile = "00000000000000000000000010";
  const today = (await create(profile, { title: "Today", due_date: TODAY, details: { inbox: false } })).response.record.id;
  const overdue = (await create(profile, { title: "Overdue", due_date: YESTERDAY, details: { inbox: false } })).response.record.id;
  const tomorrow = (await create(profile, { title: "Tomorrow", due_date: TOMORROW, details: { inbox: false } })).response.record.id;
  const deadline = (await create(profile, { title: "Deadline today", details: { inbox: false, deadline: TODAY } })).response.record.id;
  const deadlineFirst = (await create(profile, { title: "Deadline first", due_date: "2026-11-05", details: { inbox: false, deadline: TODAY } })).response.record.id;

  const todayPage = await listTasks(profile, { view: "today" });
  check("today carries what is due today", idsOf(todayPage).includes(today));
  check("today carries what is overdue", idsOf(todayPage).includes(overdue));
  check("today carries a deadline due today", idsOf(todayPage).includes(deadline));
  check("today carries the earlier of a day and a deadline", idsOf(todayPage).includes(deadlineFirst));
  check("today leaves tomorrow out", !idsOf(todayPage).includes(tomorrow));
  check("today counts four rows", todayPage.response.counts.today === 4);
  check("today counts the overdue row", todayPage.response.counts.overdue === 1);
  check("today counts one upcoming row", todayPage.response.counts.upcoming === 1);
  check("today counts five active rows", todayPage.response.counts.all === 5);

  const upcomingPage = await listTasks(profile, { view: "upcoming" });
  check("upcoming carries only the later day", idsOf(upcomingPage).length === 1 && idsOf(upcomingPage)[0] === tomorrow);

  const inboxPage = await listTasks(profile, { view: "inbox" });
  check("inbox is empty when every task is in a list-less place", idsOf(inboxPage).length === 0);

  const completedPage = await listTasks(profile, { view: "completed" });
  check("completed is empty before anything is done", idsOf(completedPage).length === 0);

  const trashPage = await listTasks(profile, { view: "trash" });
  check("trash is empty before anything is trashed", idsOf(trashPage).length === 0);

  const searched = await listTasks(profile, { search: "overdue" });
  check("search narrows the rows", idsOf(searched).length === 1 && idsOf(searched)[0] === overdue);
  check("search leaves the navigation counts alone", searched.response.counts.all === 5);

  const upper = await listTasks(profile, { search: "TOMORROW" });
  check("search ignores case", idsOf(upper).length === 1 && idsOf(upper)[0] === tomorrow);
}

// === update_task: expect, revision, and every field =======================
{
  const profile = "00000000000000000000000011";
  const id = (await create(profile, { title: "Write the plan", due_date: TODAY })).response.record.id;

  const renamed = await update(
    profile,
    id,
    [{ field: "title", value: "Renamed" }],
    [{ field: "title", value: "Write the plan" }],
  );
  check("update_task with a matching expect is applied", renamed.response.kind === "applied");
  check("update_task bumps the revision", renamed.response.applied_revision === "2");
  check("update_task returns the new title", renamed.response.record?.draft.title === "Renamed");

  const reread = await get(profile, id);
  check("get sees the applied title", reread.response.record?.draft.title === "Renamed");
  check("get sees the applied revision", reread.response.record?.revision === "2");

  const stale = await update(
    profile,
    id,
    [{ field: "title", value: "Lost" }],
    [{ field: "title", value: "Write the plan" }],
  );
  check("a stale expect is conflict", isError(stale, "conflict"));
  check("a conflict changes nothing", (await get(profile, id)).response.record?.draft.title === "Renamed");
  check("a conflict spends no revision", (await get(profile, id)).response.record?.revision === "2");

  const steps = [
    { id: "step-0000000000000001", title: "Socks", completed: true },
    { id: "step-0000000000000002", title: "Shoes", completed: false },
  ];
  const every = await update(profile, id, [
    { field: "description", value: "Pack for the trip" },
    { field: "schedule", date: TOMORROW, time: "09:30" },
    { field: "deadline", date: TOMORROW },
    { field: "duration", minutes: 90 },
    { field: "organization", list: null, inbox: false },
    { field: "priority", value: "high" },
    { field: "steps", value: steps },
    { field: "pinned", value: true },
    { field: "position", sort_key: "000000001000" },
  ]);
  const record = every.response.record;
  check("update_task writes every field", every.response.kind === "applied");
  check("update_task writes the description", record?.draft.content.description === "Pack for the trip");
  check("update_task writes the day and time", record?.draft.content.due_date === TOMORROW && record?.draft.content.due_time === "09:30");
  check("update_task writes the deadline", record?.draft.content.details.deadline === TOMORROW);
  check("update_task writes the duration", record?.draft.content.details.duration === 90);
  check("update_task writes the organization", record?.draft.content.details.list === null && record?.draft.content.details.inbox === false);
  check("update_task writes the priority", record?.draft.content.details.priority === "high");
  check("update_task writes the steps", record?.draft.content.details.steps.length === 2);
  check("update_task writes the pin", record?.draft.pinned === true);
  check("update_task writes the position", record?.draft.content.sort_key === "000000001000");
  check("update_task advances one revision per write", record?.revision === "3");

  const page = await listTasks(profile, { view: "upcoming" });
  const meta = metaOf(page, id);
  check("the listing carries the new priority", meta?.priority === "high");
  check("the listing counts the steps", meta?.steps === 2 && meta?.steps_done === 1);
  check("the listing carries the deadline and duration", meta?.deadline === TOMORROW && meta?.duration === 90);
  check("the listing carries the pin", itemsOf(page)[0]?.pinned === true);
  check("the listing carries the position", itemsOf(page)[0]?.sort_key === "000000001000");

  const emptySet = await update(profile, id, [], [{ field: "priority", value: "high" }]);
  check("an empty set with a matching expect is applied", emptySet.response.kind === "applied");
  check("an empty set spends no revision", emptySet.response.applied_revision === "3" && emptySet.response.record?.revision === "3");

  const unknown = await update(profile, MISSING, [{ field: "title", value: "Nowhere" }]);
  check("update_task of an unknown id is not_found", isError(unknown, "not_found"));
}

// === Completing a task moves it between views and counts ==================
{
  const profile = "00000000000000000000000012";
  const id = (await create(profile, { title: "Finish me", due_date: TODAY, details: { inbox: false } })).response.record.id;

  const before = await listTasks(profile, { view: "today" });
  check("an open task is in today", idsOf(before).includes(id));
  check("an open task counts as today", before.response.counts.today === 1);
  check("an open task counts as active", before.response.counts.all === 1);
  check("an open task does not count as completed", before.response.counts.completed === 0);

  const done = await update(profile, id, [{ field: "status", value: "done" }], [{ field: "status", value: "open" }]);
  check("marking done is applied", done.response.kind === "applied");
  check("marking done sets completed", done.response.record?.draft.content.completed === true);
  check("marking done sets the status", done.response.record?.draft.content.status === "done");
  check("marking done stamps completed_at", /^\d+$/.test(done.response.record?.draft.content.details.completed_at ?? ""));

  const afterToday = await listTasks(profile, { view: "today" });
  const afterDone = await listTasks(profile, { view: "completed" });
  check("a done task leaves today", !idsOf(afterToday).includes(id));
  check("a done task enters completed", idsOf(afterDone).includes(id));
  check("a done task stops counting as today", afterToday.response.counts.today === 0);
  check("a done task stops counting as active", afterToday.response.counts.all === 0);
  check("a done task counts as completed", afterToday.response.counts.completed === 1);

  const overviewAfter = await overview(profile);
  check("task_overview agrees a task is done", overviewAfter.response.counts.completed === 1 && overviewAfter.response.counts.all === 0);
  check("task_overview carries no rows", overviewAfter.response.items === undefined);

  const reopened = await update(profile, id, [{ field: "status", value: "open" }], [{ field: "status", value: "done" }]);
  check("reopening is applied", reopened.response.kind === "applied");
  check("reopening clears completed", reopened.response.record?.draft.content.completed === false);
  check("reopening clears completed_at", reopened.response.record?.draft.content.details.completed_at === null);
  check("reopening puts the task back in today", idsOf(await listTasks(profile, { view: "today" })).includes(id));
}

// === Trash and restore are real state changes =============================
{
  const profile = "00000000000000000000000013";
  const id = (await create(profile, { title: "Throw me away" })).response.record.id;

  const trashed = await setTrashed(profile, id, "1");
  check("trash is applied", trashed.response.kind === "applied");
  check("trash sets trashed", trashed.response.record?.trashed === true);
  check("trash bumps the revision", trashed.response.applied_revision === "2");

  check("a trashed task leaves all", idsOf(await listTasks(profile)).length === 0);
  const trashPage = await listTasks(profile, { view: "trash" });
  check("a trashed task enters trash", idsOf(trashPage).includes(id));
  check("trash counts one task", trashPage.response.counts.trash === 1);
  check("a trashed task stops counting as active", trashPage.response.counts.all === 0);
  check("get still reads a trashed task", (await get(profile, id)).response.record?.trashed === true);

  const editTrashed = await update(profile, id, [{ field: "title", value: "Nope" }]);
  check("editing a trashed task is conflict", isError(editTrashed, "conflict"));

  const staleTrash = await setTrashed(profile, id, "1");
  check("trashing with a stale revision is conflict", isError(staleTrash, "conflict"));

  const restored = await setTrashed(profile, id, "2", "restore");
  check("restore is applied", restored.response.kind === "applied");
  check("restore clears trashed", restored.response.record?.trashed === false);
  check("restore bumps the revision", restored.response.applied_revision === "3");
  check("a restored task returns to all", idsOf(await listTasks(profile)).includes(id));
  check("a restored task leaves trash", idsOf(await listTasks(profile, { view: "trash" })).length === 0);

  const unknown = await setTrashed(profile, MISSING, "1");
  check("trashing an unknown id is not_found", isError(unknown, "not_found"));
}

// === Task lists: create, count, rename, delete ============================
{
  const profile = "00000000000000000000000014";
  const createdList = await call(profile, {
    kind: "mutate",
    command: command({ kind: "create_task_list", title: "Reading" }),
  });
  const list = createdList.response.list;
  check("create_task_list is a task_list_applied reply", createdList.response.kind === "task_list_applied");
  check("create_task_list mints an id", /^\d{26}$/.test(list.id));
  check("create_task_list starts at revision 1", list.revision === "1");
  check("create_task_list keeps the title", list.title === "Reading");
  check("create_task_list starts empty", list.count === 0);
  check("create_task_list starts undeleted", list.deleted === false);

  const withList = await overview(profile);
  check("task_overview lists the new list", withList.response.lists.some((entry) => entry.id === list.id));

  const id = (await create(profile, { title: "Read a book", details: { list: list.id, inbox: false } })).response.record.id;

  const counted = await overview(profile);
  check("a list counts its active tasks", counted.response.lists.find((entry) => entry.id === list.id)?.count === 1);

  const filtered = await listTasks(profile, { list: list.id });
  check("a list filter keeps its task", idsOf(filtered).length === 1 && idsOf(filtered)[0] === id);
  const elsewhere = await listTasks(profile, { list: MISSING });
  check("a list filter excludes other tasks", idsOf(elsewhere).length === 0);

  const renamed = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "rename_task_list",
      id: list.id,
      expected_revision: "1",
      title: "Reading list",
    }),
  });
  check("rename_task_list is applied", renamed.response.kind === "task_list_applied");
  check("rename_task_list bumps the revision", renamed.response.list?.revision === "2");
  check("rename_task_list writes the title", renamed.response.list?.title === "Reading list");
  check("rename_task_list reports the live count", renamed.response.list?.count === 1);

  const staleRename = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "rename_task_list",
      id: list.id,
      expected_revision: "1",
      title: "Lost",
    }),
  });
  check("a stale list rename is conflict", isError(staleRename, "conflict"));

  const missingRename = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "rename_task_list",
      id: MISSING,
      expected_revision: "1",
      title: "Nowhere",
    }),
  });
  check("renaming an unknown list is not_found", isError(missingRename, "not_found"));

  const deleted = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "delete_task_list",
      id: list.id,
      expected_revision: "2",
    }),
  });
  check("delete_task_list is applied", deleted.response.kind === "task_list_applied");
  check("delete_task_list marks the list deleted", deleted.response.list?.deleted === true);
  check("delete_task_list bumps the revision", deleted.response.list?.revision === "3");

  const afterDelete = await overview(profile);
  check("a deleted list leaves the overview", afterDelete.response.lists.length === 0);

  const moved = await get(profile, id);
  check("deleting a list moves its task to the inbox", moved.response.record?.draft.content.details.list === null && moved.response.record?.draft.content.details.inbox === true);
  check("moving a task bumps its revision", moved.response.record?.revision === "2");
  check("a moved task appears in the inbox view", idsOf(await listTasks(profile, { view: "inbox" })).includes(id));

  const again = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "delete_task_list",
      id: list.id,
      expected_revision: "3",
    }),
  });
  check("deleting a deleted list is not_found", isError(again, "not_found"));
}

// === Paging and search over a real page ===================================
{
  const profile = "00000000000000000000000015";
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  const ids = [];
  for (const name of names) {
    ids.push((await create(profile, { title: name, details: { inbox: false } })).response.record.id);
  }

  const first = await listTasks(profile, { limit: 2 });
  check("the first page holds two rows", itemsOf(first).length === 2);
  check("the first page points at the next cursor", first.response.next === ids[1]);

  const second = await listTasks(profile, { limit: 2, after: first.response.next });
  check("the second page holds two rows", itemsOf(second).length === 2);
  check("the second page points at the next cursor", second.response.next === ids[3]);

  const third = await listTasks(profile, { limit: 2, after: second.response.next });
  check("the third page holds the last row", itemsOf(third).length === 1 && idsOf(third)[0] === ids[4]);
  check("the third page is final", third.response.next === null);

  const seen = [...idsOf(first), ...idsOf(second), ...idsOf(third)];
  check("paging returns every row once", seen.length === 5 && new Set(seen).size === 5);
  check("paging keeps the stored order", JSON.stringify(seen) === JSON.stringify(ids));

  const afterLast = await listTasks(profile, { limit: 2, after: ids[4] });
  check("a cursor at the last row is a final empty page", itemsOf(afterLast).length === 0 && afterLast.response.next === null);

  const lostCursor = await listTasks(profile, { limit: 2, after: MISSING });
  check("a cursor the view no longer holds is a final empty page", itemsOf(lostCursor).length === 0 && lostCursor.response.next === null);

  const searched = await listTasks(profile, { search: "charlie" });
  check("search finds one row", idsOf(searched).length === 1 && idsOf(searched)[0] === ids[2]);

  const one = await listTasks(profile, { limit: 1 });
  check("a one-row page has one row", itemsOf(one).length === 1);
  check("a one-row page has a cursor", one.response.next === ids[0]);
}

// === Paging follows the list's section order ==============================
{
  const profile = "00000000000000000000000024";
  const anytime = (await create(profile, { title: "Anytime", details: { inbox: false } })).response.record.id;
  const later = (await create(profile, { title: "Tomorrow", due_date: TOMORROW, details: { inbox: false } })).response.record.id;
  const overdue = (await create(profile, { title: "Overdue", due_date: YESTERDAY, details: { inbox: false } })).response.record.id;

  const first = await listTasks(profile, { limit: 1 });
  check("paging starts with the overdue section", idsOf(first)[0] === overdue);
  const second = await listTasks(profile, { limit: 1, after: first.response.next });
  check("paging follows with the dated section", idsOf(second)[0] === later);
  const third = await listTasks(profile, { limit: 1, after: second.response.next });
  check("paging puts an undated task last", idsOf(third)[0] === anytime);
  check("the section order is final", third.response.next === null);
}

// === A replayed request is answered once ==================================
{
  const profile = "00000000000000000000000016";
  const first = await create(profile, { title: "First" }, "same-create");
  const replay = await create(profile, { title: "Second" }, "same-create");
  check("a replayed create returns the same record", replay.response.record?.id === first.response.record?.id);
  check("a replayed create keeps the first title", replay.response.record?.draft.title === "First");
  check("a replayed create stores one task", idsOf(await listTasks(profile)).length === 1);

  const acked = await call(profile, { kind: "acknowledge", request_id: "same-create" });
  check("acknowledge is an acknowledged reply", acked.response.kind === "acknowledged");
  check("acknowledge echoes the profile", acked.profile === profile);

  const id = first.response.record.id;
  const applied = await update(
    profile,
    id,
    [{ field: "title", value: "Third" }],
    [{ field: "title", value: "First" }],
    "same-update",
  );
  check("the first update is applied", applied.response.kind === "applied" && applied.response.applied_revision === "2");
  const again = await update(
    profile,
    id,
    [{ field: "title", value: "Third" }],
    [{ field: "title", value: "First" }],
    "same-update",
  );
  check("a replayed update returns the same revision", again.response.kind === "applied" && again.response.applied_revision === "2");
  check("a replayed update does not write twice", (await get(profile, id)).response.record?.revision === "2");
}

// === Profiles never see each other ========================================
{
  const mine = await listTasks(P);
  const theirs = await listTasks(OTHER);
  const theirOverview = await overview(OTHER);
  check("each profile has its own page", mine.profile === P && theirs.profile === OTHER);
  check("the other profile holds no rows", idsOf(theirs).length === 0);
  check("the other profile counts nothing", zeroCounts(theirOverview.response.counts));
  check("the other profile holds no lists", theirOverview.response.lists.length === 0);

  const id = idsOf(mine)[0];
  const stolen = await get(OTHER, id);
  check("another profile cannot read a task by id", isError(stolen, "not_found"));

  const alias = await Resources.call({
    expected_profile: OTHER,
    call: { kind: "list_tasks", query: taskQuery() },
  });
  check("the wire field expected_profile scopes the same way", alias.profile === OTHER && idsOf(alias).length === 0);
}

// === The generic resource listing sees the same records ===================
{
  const page = await call(P, { kind: "list", query: resourceQuery() });
  check("list is a page reply", page.response.kind === "page");
  check("list finds the stored task", itemsOf(page).length === 1);
  check("list carries a summary, not a body", itemsOf(page)[0]?.id !== undefined && itemsOf(page)[0]?.draft === undefined);

  const trashed = await call(P, { kind: "list", query: resourceQuery({ trashed: true }) });
  check("list honours the trashed filter", itemsOf(trashed).length === 0);

  const incomplete = await call(P, { kind: "list", query: resourceQuery({ completed: false }) });
  check("list honours the completed filter", itemsOf(incomplete).length === 1);
  const complete = await call(P, { kind: "list", query: resourceQuery({ completed: true }) });
  check("list honours a completed filter with no match", itemsOf(complete).length === 0);

  const notes = await call(P, { kind: "list", query: resourceQuery({ kind: "note" }) });
  check("list of notes is empty: this store holds tasks", itemsOf(notes).length === 0);

  const found = await call(P, { kind: "list", query: resourceQuery({ search: "plan" }) });
  check("list search matches the title", itemsOf(found).length === 1);
}

// === Every mutation answers in its own vocabulary =========================
{
  const profile = "00000000000000000000000017";
  const id = (await create(profile, { title: "Vocabulary" })).response.record.id;
  const list = (await call(profile, {
    kind: "mutate",
    command: command({ kind: "create_task_list", title: "Words" }),
  })).response.list;

  const applied = await update(profile, id, [{ field: "pinned", value: true }]);
  check("an update answers applied with its record", applied.response.kind === "applied" && applied.response.record?.id === id);
  check("an applied reply names its request", applied.response.request_id !== undefined);
  check("an applied reply names its revision", applied.response.applied_revision === applied.response.record?.revision);

  const replaced = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "replace",
      id,
      expected_revision: applied.response.record.revision,
      draft: taskDraft({ title: "Replaced", due_date: TODAY }),
    }),
  });
  check("replace is applied", replaced.response.kind === "applied");
  check("replace writes the whole record", replaced.response.record?.draft.title === "Replaced" && replaced.response.record?.draft.content.due_date === TODAY);
  check("replace bumps the revision", replaced.response.record?.revision === "3");

  const staleReplace = await call(profile, {
    kind: "mutate",
    command: command({
      kind: "replace",
      id,
      expected_revision: "1",
      draft: taskDraft({ title: "Lost" }),
    }),
  });
  check("a stale replace is conflict", isError(staleReplace, "conflict"));

  const listRename = await call(profile, {
    kind: "mutate",
    command: command({ kind: "rename_task_list", id: list.id, expected_revision: list.revision, title: "More words" }),
  });
  check("a list rename answers task_list_applied", listRename.response.kind === "task_list_applied" && listRename.response.list?.id === list.id);
}

// === Malformed writes: invalid, not unavailable ===========================
const noteDraft = {
  title: "A note",
  pinned: false,
  related: [],
  content: { kind: "note", document: { markdown: "" } },
};
const objectDraft = {
  title: "An object",
  pinned: false,
  related: [],
  content: { kind: "object", object: { version: 1, data: {}, evidence: [] } },
};

const MALFORMED_MUTATIONS = [
  ["mutate without a command", { kind: "mutate" }],
  [
    "mutate without a version",
    { kind: "mutate", command: { request_id: request(), intent: { kind: "trash", id: MISSING, expected_revision: "1" } } },
  ],
  [
    "mutate without a request_id",
    { kind: "mutate", command: { version: 1, intent: { kind: "trash", id: MISSING, expected_revision: "1" } } },
  ],
  [
    "mutate without an intent",
    { kind: "mutate", command: { version: 1, request_id: request() } },
  ],
  [
    "an unknown intent",
    { kind: "mutate", command: command({ kind: "teleport", id: MISSING }) },
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
    "rename_task_list with a non-decimal revision",
    { kind: "mutate", command: command({ kind: "rename_task_list", id: MISSING, expected_revision: "abc", title: "Reading" }) },
  ],
  [
    "delete_task_list without an expected revision",
    { kind: "mutate", command: command({ kind: "delete_task_list", id: MISSING }) },
  ],
  ["create without a draft", { kind: "mutate", command: command({ kind: "create" }) }],
  [
    "create with a draft missing its content",
    { kind: "mutate", command: command({ kind: "create", draft: { title: "x", pinned: false, related: [] } }) },
  ],
  [
    "create with an unknown content kind",
    { kind: "mutate", command: command({ kind: "create", draft: { title: "x", pinned: false, related: [], content: { kind: "album" } } }) },
  ],
  [
    "create with a task body missing its description",
    { kind: "mutate", command: command({ kind: "create", draft: { ...taskDraft(), content: { ...taskDraft().content, description: undefined } } }) },
  ],
  [
    "create with an unknown status",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ status: "finished" }) }) },
  ],
  [
    "create with an impossible due date",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ due_date: "2026-02-30" }) }) },
  ],
  [
    "create with a time but no day",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ due_time: "09:00" }) }) },
  ],
  [
    "create with a malformed context",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ context: { url: 7, title: "x" } }) }) },
  ],
  [
    "create with an over-long title",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ title: "a".repeat(1025) }) }) },
  ],
  [
    "create with a step missing completed",
    { kind: "mutate", command: command({ kind: "create", draft: taskDraft({ details: { steps: [{ id: "s1", title: "x" }] } }) }) },
  ],
  [
    "trash without a revision",
    { kind: "mutate", command: command({ kind: "trash", id: MISSING }) },
  ],
  [
    "trash with revision 0",
    { kind: "mutate", command: command({ kind: "trash", id: MISSING, expected_revision: "0" }) },
  ],
  [
    "update_task without a set",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING }) },
  ],
  [
    "update_task with a non-array set",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: "title" }) },
  ],
  [
    "update_task with an unknown field",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "colour", value: "red" }] }) },
  ],
  [
    "update_task with a non-array expect",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "title", value: "x" }], expect: "none" }) },
  ],
  [
    "update_task with an unknown status",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "status", value: "finished" }] }) },
  ],
  [
    "update_task with a time but no day",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "schedule", date: null, time: "09:00" }] }) },
  ],
  [
    "update_task with a negative duration",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "duration", minutes: -1 }] }) },
  ],
  [
    "update_task with an unknown priority",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "priority", value: "urgent" }] }) },
  ],
  [
    "update_task with a non-boolean pin",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "pinned", value: "yes" }] }) },
  ],
  [
    "update_task with a numeric position",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "position", sort_key: 5 }] }) },
  ],
  [
    "update_task with a non-array steps",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "steps", value: "none" }] }) },
  ],
  [
    "update_task with a step missing completed",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "steps", value: [{ id: "s1", title: "x" }] }] }) },
  ],
  [
    "update_task with an over-long title",
    { kind: "mutate", command: command({ kind: "update_task", id: MISSING, set: [{ field: "title", value: "a".repeat(1025) }] }) },
  ],
  [
    "preserve_artifact without a basis",
    { kind: "mutate", command: command({ kind: "preserve_artifact", objective: MISSING, execution: MISSING, artifact: MISSING }) },
  ],
];
for (const [name, body] of MALFORMED_MUTATIONS) {
  const res = await call("00000000000000000000000018", body);
  check(`${name} is invalid`, isError(res, "invalid"));
  check(`${name} never claims an applied record`, res.response.kind !== "applied" && res.response.kind !== "task_list_applied");
}

// === Well-formed writes this store does not take ==========================
{
  const profile = "00000000000000000000000019";
  const note = await call(profile, { kind: "mutate", command: command({ kind: "create", draft: noteDraft }) });
  check("a well-formed note draft is unavailable", isError(note, "unavailable"));
  const object = await call(profile, { kind: "mutate", command: command({ kind: "create", draft: objectDraft }) });
  check("a well-formed object draft is unavailable", isError(object, "unavailable"));
  const artifact = await call(profile, {
    kind: "mutate",
    command: command({ kind: "preserve_artifact", objective: MISSING, execution: MISSING, artifact: MISSING, basis: {} }),
  });
  check("preserve_artifact is unavailable", isError(artifact, "unavailable"));

  const task = (await create(profile, { title: "A task" })).response.record;
  const replaced = await call(profile, {
    kind: "mutate",
    command: command({ kind: "replace", id: task.id, expected_revision: task.revision, draft: noteDraft }),
  });
  check("replacing a task with a note is unavailable", isError(replaced, "unavailable"));
  check("a refused replace leaves the task alone", (await get(profile, task.id)).response.record?.draft.title === "A task");
}

// === Malformed reads: invalid, not a guess ================================
const MALFORMED_READS = [
  ["list_tasks without a query", { kind: "list_tasks" }],
  ["list_tasks with a non-object query", { kind: "list_tasks", query: [] }],
  ["list_tasks with an unknown view", { kind: "list_tasks", query: taskQuery({ view: "later" }) }],
  ["list_tasks without a today", { kind: "list_tasks", query: taskQuery({ today: undefined }) }],
  ["list_tasks with a numeric today", { kind: "list_tasks", query: taskQuery({ today: 7 }) }],
  ["list_tasks with a malformed today", { kind: "list_tasks", query: taskQuery({ today: "03/11/2026" }) }],
  ["list_tasks with an impossible today", { kind: "list_tasks", query: taskQuery({ today: "2026-02-30" }) }],
  ["list_tasks with a numeric list", { kind: "list_tasks", query: taskQuery({ list: 7 }) }],
  ["list_tasks with a numeric search", { kind: "list_tasks", query: taskQuery({ search: 7 }) }],
  ["list_tasks with an over-long search", { kind: "list_tasks", query: taskQuery({ search: "a".repeat(513) }) }],
  ["list_tasks with an empty after", { kind: "list_tasks", query: taskQuery({ after: "" }) }],
  ["list_tasks with a zero limit", { kind: "list_tasks", query: taskQuery({ limit: 0 }) }],
  ["list_tasks with a fractional limit", { kind: "list_tasks", query: taskQuery({ limit: 1.5 }) }],
  ["list_tasks past the page cap", { kind: "list_tasks", query: taskQuery({ limit: 1001 }) }],
  ["task_overview without a today", { kind: "task_overview" }],
  ["task_overview with a numeric today", { kind: "task_overview", today: 7 }],
  ["task_overview with an impossible today", { kind: "task_overview", today: "2026-02-30" }],
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
  ["get with an over-long id", { kind: "get", id: "a".repeat(129) }],
  ["acknowledge without a request_id", { kind: "acknowledge" }],
  ["acknowledge with an empty request_id", { kind: "acknowledge", request_id: "" }],
  ["acknowledge with an over-long request_id", { kind: "acknowledge", request_id: "a".repeat(129) }],
];
for (const [name, body] of MALFORMED_READS) {
  const res = await call("00000000000000000000000020", body);
  check(`${name} is invalid`, isError(res, "invalid"));
  check(`${name} echoes the profile`, res.profile === "00000000000000000000000020");
}

{
  const longest = await listTasks("00000000000000000000000021", {
    search: "a".repeat(512),
    limit: 1000,
  });
  check("a query at the caps is accepted", taskPageShape(longest));
}

// === Malformed and unknown calls: the reply's own error, no crash =========
for (const kind of ["resource", "teleport", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isError(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: MISSING });
  check("a call without a kind is invalid", isError(noKind, "invalid"));

  const nullCall = await call(P, null);
  check("a null call is invalid", isError(nullCall, "invalid"));

  const arrayCall = await call(P, []);
  check("an array call is invalid", isError(arrayCall, "invalid"));

  const noProfile = await Resources.call({
    call: { kind: "task_overview", today: TODAY },
  });
  check("a call without a profile is invalid", isError(noProfile, "invalid") && noProfile.profile === null);

  const badProfile = await Resources.call({
    profile: 42,
    call: { kind: "task_overview", today: TODAY },
  });
  check("a non-string profile is invalid", isError(badProfile, "invalid") && badProfile.profile === null);

  const emptyProfile = await Resources.call({
    profile: "",
    expected_profile: "",
    call: { kind: "task_overview", today: TODAY },
  });
  check("an empty profile is invalid", isError(emptyProfile, "invalid"));

  const nothing = await Resources.call();
  check("no arguments is invalid, not a throw", isError(nothing, "invalid"));
}

// === Hostile payloads answer instead of throwing ==========================
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
    { kind: "get", id: { toString: () => MISSING } },
    {
      kind: "mutate",
      command: {
        version: 1,
        request_id: request(),
        intent: {
          get kind() {
            throw new Error("hostile payload");
          },
        },
      },
    },
    {
      kind: "mutate",
      command: {
        version: 1,
        request_id: request(),
        intent: {
          kind: "create",
          draft: {
            get title() {
              throw new Error("hostile payload");
            },
          },
        },
      },
    },
    {
      kind: "mutate",
      command: {
        version: 1,
        request_id: request(),
        intent: {
          kind: "update_task",
          id: MISSING,
          set: [
            {
              get field() {
                throw new Error("hostile payload");
              },
            },
          ],
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
      const res = await call("00000000000000000000000022", bad);
      if (!wellFormed(res, "00000000000000000000000022")) threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);
}

// === Every reply stays inside the wire vocabulary =========================
{
  const profile = "00000000000000000000000023";
  const id = (await create(profile, { title: "Shapes" })).response.record.id;
  const list = (await call(profile, {
    kind: "mutate",
    command: command({ kind: "create_task_list", title: "Shapes" }),
  })).response.list;
  const replies = [
    await create(profile, { title: "Another" }),
    await call(profile, {
      kind: "mutate",
      command: command({ kind: "rename_task_list", id: list.id, expected_revision: list.revision, title: "Shape" }),
    }),
    await listTasks(profile),
    await overview(profile),
    await get(profile, id),
    await call(profile, { kind: "acknowledge", request_id: request() }),
    await call(profile, { kind: "list", query: resourceQuery() }),
    await get(profile, MISSING),
    await call(profile, { kind: "nope" }),
  ];
  check("every reply is a ResourceResponse variant", replies.every((res) => wellFormed(res, profile)));
  check(
    "every error code is a ResourceError",
    replies
      .filter((res) => res.response.kind === "error")
      .every((res) => RESOURCE_ERRORS.has(res.response.error)),
  );

  const applied = replies[0].response;
  check("applied carries a request id, revision and record",
    typeof applied.request_id === "string" &&
      /^[1-9][0-9]*$/.test(applied.applied_revision) &&
      applied.record?.id !== undefined);
  const listApplied = replies[1].response;
  check("task_list_applied carries a request id and a list",
    typeof listApplied.request_id === "string" && listApplied.list?.id !== undefined);
  const page = replies[2].response;
  check("task_page carries lists, metadata, items, next and counts",
    Array.isArray(page.lists) &&
      Array.isArray(page.metadata) &&
      Array.isArray(page.items) &&
      (page.next === null || typeof page.next === "string") &&
      countsShape(page.counts));
  const counts = replies[3].response;
  check("task_overview carries lists and counts",
    Array.isArray(counts.lists) && countsShape(counts.counts));
  check("record carries the record", replies[4].response.record?.id === id);
  check("acknowledged carries nothing else", replies[5].response.kind === "acknowledged");
  check("page carries items and a cursor",
    Array.isArray(replies[6].response.items) &&
      (replies[6].response.next === null || typeof replies[6].response.next === "string"));
}

console.log(`\nresources_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
