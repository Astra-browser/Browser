/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Resources module (v1, wiring). Every resource surface — Tasks
// first, and later notes, objects and media — is a projection over
// `resource_call` (`ResourceCall`, `ResourceResponse` and `ResourceError` in
// `ui/app/src/shared/ipc/bindings.ts`, `docs/astra/ipc-surface.md`).
//
// This is a session store, not durable storage. Tasks and task lists live in
// memory, in one map per profile, for the window session; they are gone when
// the window closes and nothing here claims to be on disk. The shared store,
// its indexes and its write log belong to `crates/astra-store` / astra-core,
// and this module is the host-side answer until that store is wired.
//
// What this module says now:
// - `create` admits a task draft, mints an id and a revision, and answers
//   `applied` with the stored record.
// - `update_task` writes the `set` fields only when every `expect` field still
//   holds, bumps the revision and answers the new record; a stale expectation
//   is `conflict`. A status write to `done` sets `completed` and stamps
//   `completed_at` together, and leaving `done` clears both.
// - `replace` writes a whole task draft under a revision check.
// - `trash` and `restore` change `trashed` under a revision check. The Tasks
//   UI has no permanent delete for a task; the list deletes below are the only
//   removals on the wire.
// - `create_task_list`, `rename_task_list` and `delete_task_list` answer
//   `task_list_applied` with the list. Deleting a list moves its tasks to the
//   inbox rather than dropping them.
// - `list_tasks` computes the real views (`inbox`, `today`, `upcoming`, `all`,
//   `completed`, `trash`) against the caller's `today`, with search, list
//   filter, ordering, paging and the real counts and lists.
// - `task_overview` answers the same counts and lists without a page of rows.
// - `get` answers the record, or `not_found` for an id this profile never had.
// - `acknowledge` answers `acknowledged` and settles the request's receipt, so
//   a replay of that request is no longer kept.
// - `list` answers the stored records of one kind, filtered and paged.
// - `preserve_artifact` still answers `unavailable`: Work identity belongs to
//   the Work track. A `create` or `replace` whose draft is not a task also
//   answers `unavailable`: notes, objects and media wait for the shared store,
//   and this module does not pretend to hold them.
//
// Bounds: a profile holds at most `MAX_RECORDS` tasks and `MAX_LISTS` lists;
// beyond them the answer is `capacity`, which the UI already retries. Settled
// request receipts are bounded too, and the oldest give way. A call never
// throws: a malformed call, an unknown kind, or a payload that throws while
// being read answers `invalid`, and every error stays inside `ResourceError`.
//
// Every reply echoes the profile the caller asked for (`string | null`), and
// nothing stored under one profile is readable as another's. No
// `resource-changed` event is emitted: the Tasks UI already refreshes on its
// own replies, and cross-session announcements belong to the wiring phase
// that connects the shared store.
//
// Pure logic, no Firefox internals, no Events import: Node contract tests
// import this file by path.

/** Largest page the UI may ask for; it asks for 100 while listing tasks. */
const MAX_PAGE_LIMIT = 1000;

/** Longest search string a query may carry, as the UI slices it. */
const MAX_SEARCH = 512;

/** Longest list title the UI can send (`tasks.svelte.ts` slices to 64). */
const MAX_LIST_TITLE = 64;

/** Longest task title the UI can send (`tasks.svelte.ts` slices to 256). */
const MAX_TITLE = 1024;

/** Longest description the UI can send (`tasks.svelte.ts` slices to 4096). */
const MAX_DESCRIPTION = 16384;

/** Longest one step's id and title, and how many steps a task may hold. */
const MAX_STEP_ID = 128;
const MAX_STEP_TITLE = 1024;
const MAX_STEPS = 512;

/** Longest related-resource list and one related id. */
const MAX_RELATED = 64;
const MAX_RELATED_ID = 128;

/** Longest id or request id accepted from the caller. */
const MAX_ID = 128;

/** Longest opaque sort key, Work id and list id a task body may carry. */
const MAX_SORT_KEY = 64;
const MAX_WORK = 128;
const MAX_LIST_ID = 128;

/** Longest task context, and the duration cap (one year in minutes). */
const MAX_CONTEXT_URL = 4096;
const MAX_CONTEXT_TITLE = 512;
const MAX_DURATION = 525600;

/** How many fields one `update_task` may set or expect. */
const MAX_FIELDS = 64;

/** Store bounds. A profile past them is answered `capacity`, not grown. */
const MAX_PROFILES = 128;
const MAX_RECORDS = 10000;
const MAX_LISTS = 512;
const MAX_RECEIPTS = 1024;

/** The task views `TaskQuery` declares. */
const TASK_VIEWS = new Set([
  "inbox",
  "today",
  "upcoming",
  "all",
  "completed",
  "trash",
]);

/** The resource kinds `ResourceQuery` declares. */
const RESOURCE_KINDS = new Set(["note", "task", "object", "media"]);

/** The property names `TaskField` declares. */
const TASK_FIELDS = new Set([
  "title",
  "description",
  "status",
  "schedule",
  "deadline",
  "duration",
  "organization",
  "priority",
  "steps",
  "pinned",
  "position",
]);

/** `TaskStatus`, `TaskPriority` and `TaskActor`, exactly as the wire declares. */
const TASK_STATUSES = new Set(["open", "active", "blocked", "done"]);
const TASK_PRIORITIES = new Set(["none", "low", "medium", "high"]);
const TASK_ACTORS = new Set(["user", "agent"]);

/** How the list draws one task: blocked first, then active, open and done. */
const RANK = { blocked: 0, active: 1, open: 2, done: 3 };

function reply(profile, response) {
  return { profile, response };
}

/** `ResourceResponse`'s error variant; `code` is a declared `ResourceError`. */
function error(profile, code) {
  return reply(profile, { kind: "error", error: code });
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

function isBoundedText(value, max) {
  return typeof value === "string" && value.length <= max;
}

/** A plain object, never null or an array. */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A page cursor: absent, the end (`null`), or a non-empty id. */
function isCursor(value) {
  return value === undefined || value === null || isText(value);
}

/** A bounded page size, as every query on the wire carries. */
function isLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PAGE_LIMIT;
}

/** A search string; empty is the honest "no filter", not a malformed call. */
function isSearch(value) {
  return typeof value === "string" && value.length <= MAX_SEARCH;
}

/** A calendar day, and one the calendar actually has. */
function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1];
}

/** `HH:MM`, as `TaskContent` declares a due time. */
function isTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** A revision is a positive decimal string, never rounded through a number. */
function isRevision(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

/** A stored timestamp: unix seconds, as a decimal string. */
function isTimestamp(value) {
  return typeof value === "string" && /^[0-9]{1,19}$/.test(value);
}

function isStatus(value) {
  return typeof value === "string" && TASK_STATUSES.has(value);
}

function isPriority(value) {
  return typeof value === "string" && TASK_PRIORITIES.has(value);
}

function isActor(value) {
  return typeof value === "string" && TASK_ACTORS.has(value);
}

function isDuration(value) {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION
  );
}

/** The page a task came from: a URL and a title, both bounded. */
function isContext(value) {
  return (
    isObject(value) &&
    isBoundedText(value.url, MAX_CONTEXT_URL) &&
    isBoundedText(value.title, MAX_CONTEXT_TITLE)
  );
}

/** One `TaskStep`, as the subtasks panel writes it. */
function isStep(value) {
  return (
    isObject(value) &&
    isText(value.id) &&
    value.id.length <= MAX_STEP_ID &&
    isBoundedText(value.title, MAX_STEP_TITLE) &&
    typeof value.completed === "boolean"
  );
}

function isSteps(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_STEPS &&
    value.every(isStep)
  );
}

/** `TaskDetails`: every field optional on the wire, defaulted on adoption. */
function isTaskDetails(details) {
  if (!isObject(details)) {
    return false;
  }
  const { list, inbox, priority, steps, completed_at, deadline, duration } =
    details;
  return (
    (list === undefined ||
      list === null ||
      (isText(list) && list.length <= MAX_LIST_ID)) &&
    (inbox === undefined || typeof inbox === "boolean") &&
    (priority === undefined || isPriority(priority)) &&
    (steps === undefined || isSteps(steps)) &&
    (completed_at === undefined ||
      completed_at === null ||
      isTimestamp(completed_at)) &&
    (deadline === undefined || deadline === null || isDay(deadline)) &&
    (duration === undefined || duration === null || isDuration(duration))
  );
}

/** A task body, checked so a stored record can always be drawn and placed. */
function isTaskContent(content) {
  return (
    isObject(content) &&
    isBoundedText(content.description, MAX_DESCRIPTION) &&
    typeof content.completed === "boolean" &&
    (content.status === undefined || isStatus(content.status)) &&
    (content.due_date === undefined ||
      content.due_date === null ||
      isDay(content.due_date)) &&
    (content.due_time === undefined ||
      content.due_time === null ||
      (isTime(content.due_time) &&
        content.due_date !== undefined &&
        content.due_date !== null)) &&
    (content.assignee === undefined || isActor(content.assignee)) &&
    (content.origin === undefined || isActor(content.origin)) &&
    (content.context === undefined ||
      content.context === null ||
      isContext(content.context)) &&
    (content.sort_key === undefined ||
      content.sort_key === null ||
      (isText(content.sort_key) &&
        content.sort_key.length <= MAX_SORT_KEY)) &&
    (content.work === undefined ||
      content.work === null ||
      (isText(content.work) && content.work.length <= MAX_WORK)) &&
    (content.details === undefined || isTaskDetails(content.details))
  );
}

/** A draft carries the four fields `ResourceDraft` declares. Task bodies are
 *  checked in full; the other kinds keep the shared shape, because this module
 *  does not store them yet. */
function isDraft(draft) {
  if (
    !isObject(draft) ||
    !isBoundedText(draft.title, MAX_TITLE) ||
    typeof draft.pinned !== "boolean" ||
    !isObject(draft.content) ||
    !Array.isArray(draft.related) ||
    draft.related.length > MAX_RELATED ||
    !draft.related.every(
      (id) => isText(id) && id.length <= MAX_RELATED_ID,
    )
  ) {
    return false;
  }
  const content = draft.content;
  if (!RESOURCE_KINDS.has(content.kind)) {
    return false;
  }
  switch (content.kind) {
    case "task":
      return isTaskContent(content);
    case "note":
      return isObject(content.document);
    case "object":
      return isObject(content.object);
    case "media":
      return isObject(content.asset);
    default:
      return false;
  }
}

/** One `TaskField`, copied into a plain object with its value checked. The
 *  name is read once, so a payload whose getter changes it cannot be checked
 *  as one property and written as another. */
function snapshotField(field) {
  if (!isObject(field)) {
    return null;
  }
  const name = field.field;
  if (!TASK_FIELDS.has(name)) {
    return null;
  }
  switch (name) {
    case "title":
      return isBoundedText(field.value, MAX_TITLE)
        ? { field: name, value: field.value }
        : null;
    case "description":
      return isBoundedText(field.value, MAX_DESCRIPTION)
        ? { field: name, value: field.value }
        : null;
    case "status":
      return isStatus(field.value)
        ? { field: name, value: field.value }
        : null;
    case "schedule": {
      const date = field.date;
      const time = field.time;
      if (!(date === null || isDay(date))) {
        return null;
      }
      if (!(time === null || isTime(time))) {
        return null;
      }
      if (date === null && time !== null) {
        return null;
      }
      return { field: name, date, time };
    }
    case "deadline":
      return field.date === null || isDay(field.date)
        ? { field: name, date: field.date }
        : null;
    case "duration":
      return field.minutes === null || isDuration(field.minutes)
        ? { field: name, minutes: field.minutes }
        : null;
    case "organization": {
      const list = field.list;
      if (!(list === null || (isText(list) && list.length <= MAX_LIST_ID))) {
        return null;
      }
      if (typeof field.inbox !== "boolean") {
        return null;
      }
      return { field: name, list, inbox: field.inbox };
    }
    case "priority":
      return isPriority(field.value)
        ? { field: name, value: field.value }
        : null;
    case "steps": {
      const steps = field.value;
      if (!isSteps(steps)) {
        return null;
      }
      return {
        field: name,
        value: steps.map((step) => ({
          id: step.id,
          title: step.title,
          completed: step.completed,
        })),
      };
    }
    case "pinned":
      return typeof field.value === "boolean"
        ? { field: name, value: field.value }
        : null;
    case "position":
      return field.sort_key === null ||
        (isText(field.sort_key) && field.sort_key.length <= MAX_SORT_KEY)
        ? { field: name, sort_key: field.sort_key }
        : null;
    default:
      return null;
  }
}

/** One `TaskField`, checked by the name it writes and the value it carries. */
function isTaskField(field) {
  return snapshotField(field) !== null;
}

/** One `ResourceIntent`, checked just far enough to tell a well-formed write
 *  from a malformed one. */
function isIntent(intent) {
  if (!isObject(intent)) {
    return false;
  }
  const kind = intent.kind;
  if (!isText(kind)) {
    return false;
  }
  switch (kind) {
    case "create_task_list":
      return (
        isText(intent.title) && intent.title.length <= MAX_LIST_TITLE
      );

    case "rename_task_list":
      return (
        isText(intent.id) &&
        intent.id.length <= MAX_ID &&
        isRevision(intent.expected_revision) &&
        isText(intent.title) &&
        intent.title.length <= MAX_LIST_TITLE
      );

    case "delete_task_list":
      return (
        isText(intent.id) &&
        intent.id.length <= MAX_ID &&
        isRevision(intent.expected_revision)
      );

    case "create":
      return isDraft(intent.draft);

    case "replace":
      return (
        isText(intent.id) &&
        intent.id.length <= MAX_ID &&
        isRevision(intent.expected_revision) &&
        isDraft(intent.draft)
      );

    case "trash":
    case "restore":
      return (
        isText(intent.id) &&
        intent.id.length <= MAX_ID &&
        isRevision(intent.expected_revision)
      );

    case "update_task":
      // An empty `set` is a write that asks for nothing; it is still applied
      // once its `expect` holds, and changes no revision.
      return (
        isText(intent.id) &&
        intent.id.length <= MAX_ID &&
        Array.isArray(intent.set) &&
        intent.set.length <= MAX_FIELDS &&
        intent.set.every(isTaskField) &&
        (intent.expect === undefined ||
          (Array.isArray(intent.expect) &&
            intent.expect.length <= MAX_FIELDS &&
            intent.expect.every(isTaskField)))
      );

    case "preserve_artifact":
      // Work identity is the Work track's to resolve; this module only sees
      // that a well-formed copy was asked for, and refuses it.
      return (
        isText(intent.objective) &&
        isText(intent.execution) &&
        isText(intent.artifact) &&
        isObject(intent.basis) &&
        (intent.title === undefined ||
          intent.title === null ||
          typeof intent.title === "string")
      );

    default:
      return false;
  }
}

/** `ResourceCommand`: `{ version, request_id, intent }`. */
function isCommand(command) {
  return (
    isObject(command) &&
    Number.isSafeInteger(command.version) &&
    command.version >= 1 &&
    isText(command.request_id) &&
    command.request_id.length <= MAX_ID &&
    isIntent(command.intent)
  );
}

/** `TaskQuery`: `{ list?, view, today, search, after, limit }`. */
function isTaskQuery(query) {
  if (!isObject(query)) {
    return false;
  }
  const { list, view, today, search, after, limit } = query;
  return (
    (list === undefined || list === null || isText(list)) &&
    TASK_VIEWS.has(view) &&
    isDay(today) &&
    isSearch(search) &&
    isCursor(after) &&
    isLimit(limit)
  );
}

/** `ResourceQuery`: `{ kind, search, trashed, completed?, after, limit }`. */
function isResourceQuery(query) {
  if (!isObject(query)) {
    return false;
  }
  const { kind, search, trashed, completed, after, limit } = query;
  return (
    RESOURCE_KINDS.has(kind) &&
    isSearch(search) &&
    typeof trashed === "boolean" &&
    (completed === undefined ||
      completed === null ||
      typeof completed === "boolean") &&
    isCursor(after) &&
    isLimit(limit)
  );
}

// === The session store =====================================================

/** Unix seconds as a decimal string, which is what `created_at`,
 *  `updated_at` and `completed_at` carry. */
function nowSeconds() {
  return String(Math.floor(Date.now() / 1000));
}

/** A 26-digit decimal id, opaque to every caller and sortable as text. */
function mintId(store) {
  let id;
  do {
    id = String(store.next++).padStart(26, "0");
  } while (store.records.has(id) || store.lists.has(id));
  return id;
}

function newStore() {
  return {
    records: new Map(),
    lists: new Map(),
    receipts: new Map(),
    receiptOrder: [],
    next: 1,
  };
}

/** One store per profile, so no profile can read another's state. */
const stores = new Map();

/** A read-only store for a profile past `MAX_PROFILES`: it is empty, and a
 *  write to it is refused with `capacity` rather than retained. */
const EMPTY_STORE = newStore();

function storeFor(profile) {
  let store = stores.get(profile);
  if (store) {
    return store;
  }
  if (stores.size >= MAX_PROFILES) {
    return null;
  }
  store = newStore();
  stores.set(profile, store);
  return store;
}

/** The record's task body; every stored record is a task. */
function taskOf(record) {
  return record.draft.content;
}

/** The day a task is next answerable for: its planned day or its deadline,
 *  whichever comes first. The list places tasks by the same rule. */
function dayDue(task) {
  const deadline = task.details.deadline;
  if (deadline === null) {
    return task.due_date;
  }
  if (task.due_date === null || deadline < task.due_date) {
    return deadline;
  }
  return task.due_date;
}

/** The defaults Rust applies to fields a stored body may predate, so a draft
 *  lands exactly as the shared store would keep it. `completed_at` is native
 *  authority: a caller cannot forge it, and a replace of a finished task keeps
 *  the moment it was finished. */
function adoptDraft(draft, previousTask, now) {
  // Snapshot the caller's object once and re-check every part of it, so a
  // payload whose getters changed since `isIntent` cannot slip a body past
  // validation into the store.
  if (!isObject(draft) || !isObject(draft.content)) {
    return null;
  }
  const task = draft.content;
  const title = draft.title;
  const pinned = draft.pinned;
  const related = draft.related;
  if (
    !isBoundedText(title, MAX_TITLE) ||
    typeof pinned !== "boolean" ||
    !Array.isArray(related) ||
    related.length > MAX_RELATED ||
    !related.every((id) => isText(id) && id.length <= MAX_RELATED_ID) ||
    task.kind !== "task" ||
    !isTaskContent(task)
  ) {
    return null;
  }
  const details = task.details ?? {};
  let status = task.status ?? (task.completed ? "done" : "open");
  const completed = task.completed || status === "done";
  if (completed) {
    status = "done";
  }
  const completedAt =
    completed && previousTask?.completed === true &&
    isTimestamp(previousTask.details.completed_at)
      ? previousTask.details.completed_at
      : completed
        ? now
        : null;
  const dueDate = task.due_date ?? null;
  return {
    title,
    pinned,
    related: [...related],
    content: {
      kind: "task",
      description: task.description,
      completed,
      status,
      assignee: task.assignee ?? "user",
      origin: task.origin ?? "user",
      due_date: dueDate,
      due_time: dueDate === null ? null : (task.due_time ?? null),
      context:
        task.context === null || task.context === undefined
          ? null
          : { url: task.context.url, title: task.context.title },
      sort_key: task.sort_key ?? null,
      work: task.work ?? null,
      details: {
        list: details.list ?? null,
        inbox: details.inbox ?? false,
        priority: details.priority ?? "none",
        steps: (details.steps ?? []).map((step) => ({
          id: step.id,
          title: step.title,
          completed: step.completed,
        })),
        completed_at: completedAt,
        deadline: details.deadline ?? null,
        duration: details.duration ?? null,
      },
    },
  };
}

/** `ResourceSummary`: everything a list row draws, without the body. */
function summaryOf(record) {
  const task = taskOf(record);
  return {
    id: record.id,
    revision: record.revision,
    title: record.draft.title,
    pinned: record.draft.pinned,
    updated_at: record.updated_at,
    completed: task.completed,
    due_date: task.due_date,
    due_time: task.due_time,
    status: task.status,
    assignee: task.assignee,
    origin: task.origin,
    context: task.context,
    sort_key: task.sort_key,
    work: task.work,
  };
}

/** `TaskMetadata`: the task-only fields a row needs but a summary omits. */
function metadataOf(record) {
  const details = taskOf(record).details;
  return {
    id: record.id,
    list: details.list,
    inbox: details.inbox,
    priority: details.priority,
    steps: details.steps.length,
    steps_done: details.steps.filter((step) => step.completed).length,
    completed_at: details.completed_at,
    deadline: details.deadline,
    duration: details.duration,
  };
}

function zeroCounts() {
  return {
    inbox: 0,
    today: 0,
    overdue: 0,
    upcoming: 0,
    all: 0,
    completed: 0,
    trash: 0,
  };
}

/** The navigation counts: active work by place, then finished and trashed. */
function countsOf(store, today) {
  const counts = zeroCounts();
  for (const record of store.records.values()) {
    if (record.trashed) {
      counts.trash += 1;
      continue;
    }
    const task = taskOf(record);
    if (task.completed) {
      counts.completed += 1;
      continue;
    }
    counts.all += 1;
    if (task.details.inbox) {
      counts.inbox += 1;
    }
    const day = dayDue(task);
    if (day === null) {
      continue;
    }
    if (day < today) {
      counts.overdue += 1;
    }
    if (day <= today) {
      counts.today += 1;
    }
    if (day > today) {
      counts.upcoming += 1;
    }
  }
  return counts;
}

/** The profile's lists, each with the active tasks it holds. */
function countOfList(store, listId) {
  let count = 0;
  for (const record of store.records.values()) {
    const task = taskOf(record);
    if (!record.trashed && !task.completed && task.details.list === listId) {
      count += 1;
    }
  }
  return count;
}

function listsOf(store) {
  const counts = new Map();
  for (const record of store.records.values()) {
    const task = taskOf(record);
    if (record.trashed || task.completed) {
      continue;
    }
    const id = task.details.list;
    if (id !== null) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...store.lists.values()]
    .filter((list) => !list.deleted)
    .map((list) => ({
      ...list,
      count: counts.get(list.id) ?? 0,
    }))
    .sort((left, right) =>
      compareText(left.title, right.title) || compareText(left.id, right.id),
    );
}

/** Text order, so two hosts sort the same keys the same way. */
function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

const DAY_MS = 86400000;

/** The UTC stamp of a calendar day, without `Date.UTC`'s 0–99 year quirk. */
function dayNumber(day) {
  const at = new Date(0);
  at.setUTCHours(0, 0, 0, 0);
  at.setUTCFullYear(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  return at.getTime();
}

/** Whole days from `today` to `due`: 0 today, negative overdue. */
function daysUntil(due, today) {
  return Math.round((dayNumber(due) - dayNumber(today)) / DAY_MS);
}

/** The order the list draws its sections in: overdue, today, tomorrow,
 *  upcoming, anytime, completed. Paging follows it so the first page is the
 *  work that needs a person first. */
function sectionRank(record, today) {
  const task = taskOf(record);
  if (task.status === "done") {
    return 5;
  }
  const day = dayDue(task);
  if (day === null) {
    return 4;
  }
  const days = daysUntil(day, today);
  if (days < 0) {
    return 0;
  }
  if (days === 0) {
    return 1;
  }
  return days === 1 ? 2 : 3;
}

/** What decides a row's order, read once per sort rather than per comparison.
 *  This is the list's own rule (`task-sections.ts`), so native paging and the
 *  drawn order agree. */
function placedOf(record) {
  const task = taskOf(record);
  return {
    record,
    rank: RANK[task.status] ?? RANK.open,
    pinned: record.draft.pinned,
    sortKey: task.sort_key,
    day: dayDue(task),
    time: task.due_time,
    finished:
      task.status === "done"
        ? BigInt(task.details.completed_at ?? "0")
        : null,
  };
}

function comparePlaced(left, right) {
  if (left.finished !== null && right.finished !== null) {
    if (left.finished !== right.finished) {
      return left.finished > right.finished ? -1 : 1;
    }
    return compareText(left.record.id, right.record.id);
  }
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  if (left.sortKey !== right.sortKey) {
    if (left.sortKey === null) {
      return 1;
    }
    if (right.sortKey === null) {
      return -1;
    }
    return compareText(left.sortKey, right.sortKey);
  }
  if (left.day !== right.day) {
    if (left.day === null) {
      return 1;
    }
    if (right.day === null) {
      return -1;
    }
    return compareText(left.day, right.day);
  }
  if (left.time !== right.time) {
    if (left.time === null) {
      return 1;
    }
    if (right.time === null) {
      return -1;
    }
    return compareText(left.time, right.time);
  }
  return compareText(left.record.id, right.record.id);
}

/** The records a `TaskQuery` names, filtered and ordered, before paging. */
function filterTasks(store, query) {
  const search = query.search.toLowerCase();
  const list = query.list ?? null;
  const rows = [];
  for (const record of store.records.values()) {
    if (record.trashed !== (query.view === "trash")) {
      continue;
    }
    const task = taskOf(record);
    if (list !== null && task.details.list !== list) {
      continue;
    }
    if (
      search !== "" &&
      !`${record.draft.title}\n${task.description}`
        .toLowerCase()
        .includes(search)
    ) {
      continue;
    }
    switch (query.view) {
      case "inbox":
        if (!(task.details.inbox && !task.completed)) {
          continue;
        }
        break;
      case "today": {
        const day = dayDue(task);
        if (task.completed || day === null || day > query.today) {
          continue;
        }
        break;
      }
      case "upcoming": {
        const day = dayDue(task);
        if (task.completed || day === null || day <= query.today) {
          continue;
        }
        break;
      }
      case "completed":
        if (!task.completed) {
          continue;
        }
        break;
      default:
        // `all` and `trash` carry every row the trashed check kept.
        break;
    }
    rows.push(record);
  }
  return rows
    .map((record) => ({
      ...placedOf(record),
      section: sectionRank(record, query.today),
    }))
    .sort(
      (left, right) => left.section - right.section || comparePlaced(left, right),
    )
    .map((placed) => placed.record);
}

/** The page cursor's place in the ordered rows; `-1` when it is gone. */
function cursorIndex(rows, after) {
  if (after === null || after === undefined) {
    return 0;
  }
  return rows.findIndex((record) => record.id === after);
}

/** One `task_page`, with the real counts and lists on every page. */
function taskPage(store, query) {
  const rows = filterTasks(store, query);
  const lists = listsOf(store);
  const counts = countsOf(store, query.today);
  const at = cursorIndex(rows, query.after);
  if (at < 0) {
    // The row the caller paged from left the view. Starting over would repeat
    // rows it already has, so the honest page is empty and final; the caller
    // reloads instead.
    return {
      kind: "task_page",
      lists,
      metadata: [],
      items: [],
      next: null,
      counts,
    };
  }
  const start = query.after === null || query.after === undefined ? 0 : at + 1;
  const page = rows.slice(start, start + query.limit);
  const next =
    start + query.limit < rows.length ? page[page.length - 1].id : null;
  return {
    kind: "task_page",
    lists,
    metadata: page.map(metadataOf),
    items: page.map(summaryOf),
    next,
    counts,
  };
}

function taskOverview(store, today) {
  return {
    kind: "task_overview",
    lists: listsOf(store),
    counts: countsOf(store, today),
  };
}

/** One `page` of stored records of one kind, filtered and paged. */
function resourcePage(store, query) {
  const search = query.search.toLowerCase();
  const rows = [...store.records.values()]
    .filter((record) => record.draft.content.kind === query.kind)
    .filter((record) => record.trashed === query.trashed)
    .filter(
      (record) =>
        query.completed === undefined ||
        query.completed === null ||
        (record.draft.content.kind === "task" &&
          record.draft.content.completed === query.completed),
    )
    .filter(
      (record) =>
        search === "" || record.draft.title.toLowerCase().includes(search),
    )
    .sort(
      (left, right) =>
        compareText(right.updated_at, left.updated_at) ||
        compareText(left.id, right.id),
    );
  const at = cursorIndex(rows, query.after);
  if (at < 0) {
    return { kind: "page", items: [], next: null };
  }
  const start = query.after === null || query.after === undefined ? 0 : at + 1;
  const page = rows.slice(start, start + query.limit);
  const next =
    start + query.limit < rows.length ? page[page.length - 1].id : null;
  return { kind: "page", items: page.map(summaryOf), next };
}

// === Writes ================================================================

function bump(revision) {
  return String(BigInt(revision) + 1n);
}

function sameSteps(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (step, index) =>
        step.id === right[index].id &&
        step.title === right[index].title &&
        step.completed === right[index].completed,
    )
  );
}

/** Whether a draft still holds the value a `TaskField` expects. */
function holds(draft, field) {
  const task = draft.content;
  const details = task.details;
  switch (field.field) {
    case "title":
      return draft.title === field.value;
    case "description":
      return task.description === field.value;
    case "status":
      return task.status === field.value;
    case "schedule":
      return (
        task.due_date === field.date &&
        (task.due_time ?? null) === field.time
      );
    case "deadline":
      return details.deadline === field.date;
    case "duration":
      return details.duration === field.minutes;
    case "organization":
      return details.list === field.list && details.inbox === field.inbox;
    case "priority":
      return details.priority === field.value;
    case "steps":
      return sameSteps(details.steps, field.value);
    case "pinned":
      return draft.pinned === field.value;
    case "position":
      return task.sort_key === field.sort_key;
    default:
      return false;
  }
}

/** One field written onto a task draft. A status write owns `completed` and
 *  `completed_at` together, so the two can never disagree. */
function writeField(draft, field, now) {
  const task = draft.content;
  const details = task.details;
  switch (field.field) {
    case "title":
      return { ...draft, title: field.value };
    case "description":
      return { ...draft, content: { ...task, description: field.value } };
    case "status": {
      const done = field.value === "done";
      return {
        ...draft,
        content: {
          ...task,
          status: field.value,
          completed: done,
          details: {
            ...details,
            completed_at: done
              ? task.completed && isTimestamp(details.completed_at)
                ? details.completed_at
                : now
              : null,
          },
        },
      };
    }
    case "schedule":
      return {
        ...draft,
        content: {
          ...task,
          due_date: field.date,
          due_time: field.date === null ? null : field.time,
        },
      };
    case "deadline":
      return {
        ...draft,
        content: { ...task, details: { ...details, deadline: field.date } },
      };
    case "duration":
      return {
        ...draft,
        content: {
          ...task,
          details: { ...details, duration: field.minutes },
        },
      };
    case "organization":
      return {
        ...draft,
        content: {
          ...task,
          details: { ...details, list: field.list, inbox: field.inbox },
        },
      };
    case "priority":
      return {
        ...draft,
        content: {
          ...task,
          details: { ...details, priority: field.value },
        },
      };
    case "steps":
      return {
        ...draft,
        content: {
          ...task,
          details: {
            ...details,
            steps: field.value.map((step) => ({
              id: step.id,
              title: step.title,
              completed: step.completed,
            })),
          },
        },
      };
    case "pinned":
      return { ...draft, pinned: field.value };
    case "position":
      return {
        ...draft,
        content: { ...task, sort_key: field.sort_key },
      };
    default:
      return draft;
  }
}

/** A settled write's reply, kept so a replay of its request is answered once
 *  and never applied twice. The oldest receipts give way at the bound. */
function remember(store, response) {
  store.receipts.set(response.request_id, response);
  store.receiptOrder.push(response.request_id);
  while (store.receiptOrder.length > MAX_RECEIPTS) {
    const oldest = store.receiptOrder.shift();
    if (oldest !== undefined) {
      store.receipts.delete(oldest);
    }
  }
  return response;
}

function applied(requestId, record) {
  return {
    kind: "applied",
    request_id: requestId,
    applied_revision: record.revision,
    record: structuredClone(record),
  };
}

function listApplied(store, requestId, list) {
  return {
    kind: "task_list_applied",
    request_id: requestId,
    list: { ...list, count: countOfList(store, list.id) },
  };
}

/** The record's tasks moved to the inbox when their list is deleted. */
function orphanTasks(store, listId, now) {
  for (const [id, record] of store.records) {
    const task = taskOf(record);
    if (task.details.list !== listId) {
      continue;
    }
    store.records.set(id, {
      ...record,
      revision: bump(record.revision),
      updated_at: now,
      draft: {
        ...record.draft,
        content: {
          ...task,
          details: { ...task.details, list: null, inbox: true },
        },
      },
    });
  }
}

/** One well-formed `ResourceCommand`, applied to this profile's store. */
function mutate(store, command, now) {
  const requestId = command.request_id;
  const cached = store.receipts.get(requestId);
  if (cached) {
    return structuredClone(cached);
  }
  const intent = command.intent;
  const kind = intent.kind;
  switch (kind) {
    case "create_task_list": {
      if (store.lists.size >= MAX_LISTS) {
        return { kind: "error", error: "capacity" };
      }
      const list = {
        id: mintId(store),
        title: intent.title,
        revision: "1",
        count: 0,
        deleted: false,
      };
      store.lists.set(list.id, list);
      return remember(store, listApplied(store, requestId, list));
    }

    case "rename_task_list": {
      const current = store.lists.get(intent.id);
      if (!current || current.deleted) {
        return { kind: "error", error: "not_found" };
      }
      if (current.revision !== intent.expected_revision) {
        return { kind: "error", error: "conflict" };
      }
      const list = {
        ...current,
        revision: bump(current.revision),
        title: intent.title,
      };
      store.lists.set(list.id, list);
      return remember(store, listApplied(store, requestId, list));
    }

    case "delete_task_list": {
      const current = store.lists.get(intent.id);
      if (!current || current.deleted) {
        return { kind: "error", error: "not_found" };
      }
      if (current.revision !== intent.expected_revision) {
        return { kind: "error", error: "conflict" };
      }
      const list = {
        ...current,
        revision: bump(current.revision),
        deleted: true,
        count: 0,
      };
      store.lists.set(list.id, list);
      orphanTasks(store, list.id, now);
      return remember(store, listApplied(store, requestId, list));
    }

    case "create": {
      const draft = adoptDraft(intent.draft, null, now);
      if (!draft) {
        // A well-formed note, object or media draft: this store holds tasks.
        return { kind: "error", error: "unavailable" };
      }
      if (store.records.size >= MAX_RECORDS) {
        return { kind: "error", error: "capacity" };
      }
      const record = {
        id: mintId(store),
        revision: "1",
        created_at: now,
        updated_at: now,
        trashed: false,
        draft,
      };
      store.records.set(record.id, record);
      return remember(store, applied(requestId, record));
    }

    case "update_task": {
      const current = store.records.get(intent.id);
      if (!current) {
        return { kind: "error", error: "not_found" };
      }
      // A trashed task is not edited: the state the caller holds is not the
      // state the write assumes.
      if (current.trashed) {
        return { kind: "error", error: "conflict" };
      }
      // Copy the fields out once, so what was checked is what is written.
      const expect = [];
      for (const field of intent.expect ?? []) {
        const snapshot = snapshotField(field);
        if (!snapshot) {
          return { kind: "error", error: "invalid" };
        }
        expect.push(snapshot);
      }
      const set = [];
      for (const field of intent.set) {
        const snapshot = snapshotField(field);
        if (!snapshot) {
          return { kind: "error", error: "invalid" };
        }
        set.push(snapshot);
      }
      if (!expect.every((field) => holds(current.draft, field))) {
        return { kind: "error", error: "conflict" };
      }
      if (set.length === 0) {
        // A write that asks for nothing changes nothing, so no revision is
        // spent on it; its reply still settles the request.
        return remember(store, applied(requestId, current));
      }
      const draft = set.reduce(
        (next, field) => writeField(next, field, now),
        current.draft,
      );
      const record = {
        ...current,
        revision: bump(current.revision),
        updated_at: now,
        draft,
      };
      store.records.set(record.id, record);
      return remember(store, applied(requestId, record));
    }

    case "replace": {
      const current = store.records.get(intent.id);
      if (!current) {
        return { kind: "error", error: "not_found" };
      }
      if (current.revision !== intent.expected_revision) {
        return { kind: "error", error: "conflict" };
      }
      const draft = adoptDraft(intent.draft, taskOf(current), now);
      if (!draft) {
        return { kind: "error", error: "unavailable" };
      }
      const record = {
        ...current,
        revision: bump(current.revision),
        updated_at: now,
        draft,
      };
      store.records.set(record.id, record);
      return remember(store, applied(requestId, record));
    }

    case "trash":
    case "restore": {
      const current = store.records.get(intent.id);
      if (!current) {
        return { kind: "error", error: "not_found" };
      }
      if (current.revision !== intent.expected_revision) {
        return { kind: "error", error: "conflict" };
      }
      const record = {
        ...current,
        revision: bump(current.revision),
        updated_at: now,
        trashed: intent.kind === "trash",
      };
      store.records.set(record.id, record);
      return remember(store, applied(requestId, record));
    }

    case "preserve_artifact":
      // Work identity is the Work track's to resolve; copying an artifact
      // needs the shared store's objects.
      return { kind: "error", error: "unavailable" };

    default:
      return { kind: "error", error: "invalid" };
  }
}

// === Dispatch ==============================================================

function answer(profile, call) {
  if (!isObject(call)) {
    return error(profile, "invalid");
  }
  const kind = call.kind;
  if (!isText(kind)) {
    return error(profile, "invalid");
  }

  switch (kind) {
    case "list_tasks":
      if (!isTaskQuery(call.query)) {
        return error(profile, "invalid");
      }
      return reply(
        profile,
        taskPage(storeFor(profile) ?? EMPTY_STORE, call.query),
      );

    case "task_overview":
      if (!isDay(call.today)) {
        return error(profile, "invalid");
      }
      return reply(
        profile,
        taskOverview(storeFor(profile) ?? EMPTY_STORE, call.today),
      );

    case "list":
      if (!isResourceQuery(call.query)) {
        return error(profile, "invalid");
      }
      return reply(
        profile,
        resourcePage(storeFor(profile) ?? EMPTY_STORE, call.query),
      );

    case "get": {
      if (!isText(call.id) || call.id.length > MAX_ID) {
        return error(profile, "invalid");
      }
      const record = storeFor(profile)?.records.get(call.id);
      return record
        ? reply(profile, { kind: "record", record: structuredClone(record) })
        : error(profile, "not_found");
    }

    case "acknowledge": {
      if (!isText(call.request_id) || call.request_id.length > MAX_ID) {
        return error(profile, "invalid");
      }
      // The caller has the settled reply; the receipt no longer needs to keep
      // a replay of it.
      const store = stores.get(profile);
      if (store) {
        store.receipts.delete(call.request_id);
        const at = store.receiptOrder.indexOf(call.request_id);
        if (at >= 0) {
          store.receiptOrder.splice(at, 1);
        }
      }
      return reply(profile, { kind: "acknowledged" });
    }

    case "mutate": {
      if (!isCommand(call.command)) {
        return error(profile, "invalid");
      }
      const store = storeFor(profile);
      if (!store) {
        return error(profile, "capacity");
      }
      return reply(profile, mutate(store, call.command, nowSeconds()));
    }

    default:
      return error(profile, "invalid");
  }
}

export const Resources = {
  /**
   * Answer one `resource_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `ResourceReply`: the echoed `profile` plus one `ResourceResponse`
   * variant.
   */
  async call({ profile = "", expected_profile = "", call = null } = {}) {
    const asked =
      typeof profile === "string" && profile !== ""
        ? profile
        : typeof expected_profile === "string" && expected_profile !== ""
          ? expected_profile
          : null;
    if (asked === null) {
      return error(null, "invalid");
    }
    try {
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down, and the
      // answer must stay a variant `ResourceError` declares.
      return error(asked, "invalid");
    }
  },
};

/** Test-only reset so contract tests start from an empty store. */
export function __resetResourcesForTests() {
  stores.clear();
}
