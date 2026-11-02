/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Resources module (v1, wiring). Every resource surface — Tasks
// first, and later notes, objects and media — is a projection over
// `resource_call` (`ResourceCall`, `ResourceResponse` and `ResourceError` in
// `ui/app/src/shared/ipc/bindings.ts`, `docs/astra/ipc-surface.md`). The
// shared store, its indexes and its write log belong to astra-core; this
// module is the host-side answer while that store is not connected, so the
// Tasks UI renders its real state (nothing held) instead of failing with
// `unknown_command`.
//
// What this module will and will not say:
// - The reads the Tasks UI makes (`list_tasks`, `task_overview`) answer
//   well-formed replies with no rows, no lists and zero counts. The host
//   holds no tasks, and it never invents one.
// - The generic listing (`list`) answers an empty final page for every
//   resource kind. Nothing is stored, so nothing matches.
// - `get` answers `not_found`. The listings are authoritative and empty, so
//   an id cannot name a record; that is a different statement from
//   `unavailable`, which would claim a store that exists but cannot answer.
// - `acknowledge` answers `acknowledged`: there is no applied write to
//   settle, so settling one is a no-op that succeeds.
// - Every mutation — task create/update/trash/restore and the task-list
//   create/rename/delete, plus the object and artifact writes — answers the
//   reply's own `error: "unavailable"`. Nothing is reported as `applied` or
//   `task_list_applied`, and no id or revision is minted.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an
//   unknown `kind` is `invalid` too. The call never throws.
// - Every reply echoes the profile the caller asked for, as `ResourceReply`
//   allows (`string | null`). Nothing is stored per profile, so nothing can
//   be read as another profile's state; a call without a profile answers with
//   `profile: null`.
//
// Pure logic, no Firefox internals, no Events import: nothing here changes
// state, so there is no `resource-changed` to announce.

/** Largest page the UI may ask for; it asks for 100 while listing tasks. */
const MAX_PAGE_LIMIT = 1000;

/** Longest search string a query may carry, as the UI slices it. */
const MAX_SEARCH = 512;

/** Longest list title the UI can send (`tasks.svelte.ts` slices to 64). */
const MAX_LIST_TITLE = 64;

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

/** The caller's local calendar day, as `tasks.svelte.ts` builds it. */
function isDay(value) {
  return (
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
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

/** A draft carries the four fields `ResourceDraft` declares; the body of its
 *  content is the store's to validate, so only the shape every kind shares is
 *  checked. A title may be empty: the wire allows it even when no UI sends it. */
function isDraft(draft) {
  return (
    isObject(draft) &&
    typeof draft.title === "string" &&
    typeof draft.pinned === "boolean" &&
    isObject(draft.content) &&
    RESOURCE_KINDS.has(draft.content.kind) &&
    Array.isArray(draft.related)
  );
}

/** One `TaskField`, checked by the name it writes. */
function isTaskField(field) {
  return isObject(field) && TASK_FIELDS.has(field.field);
}

/** One `ResourceIntent`, checked just far enough to tell a well-formed write
 *  from a malformed one. A valid intent is then refused, never applied. */
function isIntent(intent) {
  if (!isObject(intent) || !isText(intent.kind)) {
    return false;
  }
  switch (intent.kind) {
    case "create_task_list":
      return (
        isText(intent.title) && intent.title.length <= MAX_LIST_TITLE
      );

    case "rename_task_list":
      return (
        isText(intent.id) &&
        isText(intent.expected_revision) &&
        isText(intent.title) &&
        intent.title.length <= MAX_LIST_TITLE
      );

    case "delete_task_list":
      return isText(intent.id) && isText(intent.expected_revision);

    case "create":
      return isDraft(intent.draft);

    case "replace":
      return (
        isText(intent.id) &&
        isText(intent.expected_revision) &&
        isDraft(intent.draft)
      );

    case "trash":
    case "restore":
      return isText(intent.id) && isText(intent.expected_revision);

    case "update_task":
      // An empty `set` is a write that asks for nothing, but the wire allows
      // it; it is still a write this module refuses rather than malformed.
      return (
        isText(intent.id) &&
        Array.isArray(intent.set) &&
        intent.set.every(isTaskField) &&
        (intent.expect === undefined ||
          (Array.isArray(intent.expect) && intent.expect.every(isTaskField)))
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
    isIntent(command.intent)
  );
}

/** Nothing is held, so every navigation count is zero. */
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

/** The empty task page: no rows, no lists, no metadata, no next cursor. */
function emptyTaskPage() {
  return {
    kind: "task_page",
    lists: [],
    metadata: [],
    items: [],
    next: null,
    counts: zeroCounts(),
  };
}

function answer(profile, call) {
  if (!isObject(call) || !isText(call.kind)) {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "list_tasks":
      if (!isTaskQuery(call.query)) {
        return error(profile, "invalid");
      }
      // The store holds nothing, so the honest page is empty and final, and
      // every count it reports is zero.
      return reply(profile, emptyTaskPage());

    case "task_overview":
      if (!isDay(call.today)) {
        return error(profile, "invalid");
      }
      // Counts and lists only; both are empty because nothing is stored.
      return reply(profile, {
        kind: "task_overview",
        lists: [],
        counts: zeroCounts(),
      });

    case "list":
      if (!isResourceQuery(call.query)) {
        return error(profile, "invalid");
      }
      return reply(profile, { kind: "page", items: [], next: null });

    case "get":
      // An id cannot name a record in an empty store. `not_found` is true;
      // `unavailable` would claim a store that merely cannot answer.
      return isText(call.id)
        ? error(profile, "not_found")
        : error(profile, "invalid");

    case "acknowledge":
      // There is no applied write to settle, so settling one changes nothing.
      return isText(call.request_id)
        ? reply(profile, { kind: "acknowledged" })
        : error(profile, "invalid");

    case "mutate":
      // A well-formed write is refused in the reply's own vocabulary; a
      // malformed one is not a write at all.
      return isCommand(call.command)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

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
