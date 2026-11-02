/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Work module (v1, wiring slice). The chrome's Work surface asks
// native two things: `work_running` (is anything running now?) and
// `work_call` (the Work product grammar: environments, queries, authoring,
// execution). Both had no host route, so the surface could not tell an empty
// Work from a broken one and said "Work could not confirm this".
//
// This module answers the read-only calls the surface makes when it opens —
// the environment `list`, `open` and `read` family — with honest empty
// projections: no Work is stored natively yet, so the list is empty and every
// Work reads as an environment with no elements, no areas and one revision of
// nothing. It never mints a Work, a title, an element or a revision that the
// request did not already carry, and it never claims a write landed.
//
// Calls that need the Work store or runtime (environment `checkpoint` and
// `command`, and the `query`/`author`/`execute` families) are refused with the
// reply's own `error` variant, which the surface already renders. The store
// this grows into is `crates/astra-store` plus the Work runtime; until then a
// refusal is the honest answer, not a fake success.
//
// Wire shapes are the ones in `ui/app/src/shared/ipc/bindings.ts`
// (`WorkResponseV1`, `WorkReplyV1`, `WorkEnvironmentReply`,
// `WorkEnvironmentSnapshot`, `WorkFailureV1`).
//
// Pure logic, no Firefox internals, no disk.

/** Work grammar version carried by every envelope and snapshot. */
const WORK_VERSION = 1;

/**
 * The Space each profile last listed. An empty environment has to name the
 * Space it belongs to, and the environment `open`/`read` calls carry only an
 * id — the Space came from the page the surface listed just before. Kept per
 * profile so one profile never reads another's Space.
 */
const _spaces = new Map();

function envelope(profile, reply) {
  return { version: WORK_VERSION, profile, reply };
}

/** The reply's own error variant: the surface renders `error` as it is. */
function failure(profile, error) {
  return envelope(profile, { kind: "error", error });
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

/**
 * An environment with nothing in it. The id is the one the request named, the
 * Space is the one it was listed under, and the title stays empty because the
 * host does not know what the person called it — nothing here is invented.
 */
function emptySnapshot(profile, space, id) {
  return {
    version: WORK_VERSION,
    id,
    profile,
    space,
    title: "",
    lifecycle: "active",
    revision: "1",
    elements: [],
    areas: [],
    view: { revision: "1", x: 0, y: 0, zoom_milli: 1000, placements: [] },
  };
}

/** The environment `list` page: no Works, so no next page and no selection. */
function list(profile, request) {
  if (!isText(request.space)) {
    return failure(profile, "invalid");
  }
  _spaces.set(profile, request.space);
  return envelope(profile, {
    kind: "environment",
    reply: { kind: "page", works: [], next: null, selected: null },
  });
}

/** The environment `open`/`read` reply: the Work as it stands, which is empty. */
function read(profile, request) {
  if (!isText(request.id)) {
    return failure(profile, "invalid");
  }
  const space = _spaces.get(profile);
  // Without a listed Space there is no environment to describe. Refusing is
  // honest; inventing a Space (or a Work) would not be.
  if (!space) {
    return failure(profile, "invalid");
  }
  return envelope(profile, {
    kind: "environment",
    reply: { kind: "snapshot", snapshot: emptySnapshot(profile, space, request.id) },
  });
}

function environment(profile, call) {
  if (call.version !== WORK_VERSION) {
    return failure(profile, "invalid");
  }
  const request = call.request;
  if (!request || typeof request !== "object") {
    return failure(profile, "invalid");
  }
  switch (request.kind) {
    case "list":
      return list(profile, request);
    case "open":
    case "read":
      return read(profile, request);
    // Writes need the Work store: a checkpoint saves the arrangement, a
    // command creates, renames, archives or edits a Work. Nothing is stored
    // natively yet, so nothing can be applied.
    case "checkpoint":
    case "command":
      return failure(profile, "unavailable");
    default:
      return failure(profile, "invalid");
  }
}

export const Work = {
  /**
   * Whether turning Work off would stop anything. Nothing runs natively yet,
   * so the answer is false — never a guess about a runtime that is not there.
   */
  async running() {
    return false;
  },

  /**
   * One Work call. The bridge snake-cases the UI's `expectedProfile` into
   * `expected_profile`; `profile` is accepted as the same value so a direct
   * caller (or a test) can pass either name.
   */
  async call(input = {}) {
    const { expected_profile, profile, call } =
      input && typeof input === "object" ? input : {};
    const scope = isText(expected_profile)
      ? expected_profile
      : isText(profile)
        ? profile
        : "";
    if (!scope) {
      return failure("", "invalid");
    }
    if (!call || typeof call !== "object") {
      return failure(scope, "invalid");
    }
    switch (call.kind) {
      case "environment":
        return environment(scope, call);
      // Projections, plan history and evidence come from the Work runtime;
      // authoring and execution need the agent runtime. Neither is wired.
      case "query":
      case "author":
      case "execute":
        return failure(scope, "unavailable");
      default:
        return failure(scope, "invalid");
    }
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetWorkForTests() {
  _spaces.clear();
}
