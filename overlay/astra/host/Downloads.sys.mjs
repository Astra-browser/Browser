/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Downloads module (v1, wiring). The downloads list and the
// Downloads settings panel are projections over `download_call` /
// `download_open_access_settings` (`docs/astra/DOWNLOADS.md`,
// `docs/astra/ipc-surface.md`). Native transfers, paths and durable history
// belong to astra-core; this module is the host-side answer while that
// manager is not connected, so the surfaces render their real state (nothing
// held) instead of failing with `unknown_command`.
//
// What this module will and will not say:
// - `updates` and `list` answer with an empty set. The host holds no
//   transfers and no durable history yet, and it never invents entries.
// - `list` reports `supported: false` so the panel says downloads are not
//   available yet instead of passing an empty page off as the person's whole
//   history.
// - `preferences` answers the documented defaults only: the default saves
//   straight to the system Downloads folder, and no native picker has minted
//   a directory identity.
// - `clear` and `retry_cleanup` are idempotent on that empty set: there is
//   nothing to clear and no failed cleanup to retry, so they answer
//   `accepted` / `applied` without inventing work.
// - Anything that needs a real transfer, file or durable preference
//   (`cancel`, `pause`, `resume`, `keep`, `discard`, `open`, `reveal`,
//   `forget`, `choose_directory`, `set_ask_destination`) answers the reply's
//   own `error` variant `unavailable`. Nothing is reported as applied.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an
//   unknown `kind` is `invalid` too. The call never throws.
// - Every reply echoes the profile the caller asked for. Nothing is stored
//   per profile, so nothing can be read as another profile's state.
//
// Pure logic, no Firefox internals, no Events import: nothing here changes
// state, so there is no `downloads-changed` to announce.

/** Page of entries the UI asks for in one `list` call. */
const MAX_PAGE_LIMIT = 2000;

/** The idle cleanup state: no pass is running and none failed. */
function idleCleanup() {
  return { running: false, error: null };
}

/** Documented defaults; `directory_identity` stays absent until the OS
 *  picker mints one. */
function defaultPreferences() {
  return { ask_destination: false, directory: null };
}

function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function isEntryId(id) {
  return typeof id === "string" && id !== "";
}

/** `{ before: string | null, limit: number }`, exactly as the UI sends it. */
function isPageCall(call) {
  const { before, limit } = call;
  const beforeOk =
    before === null || (typeof before === "string" && before !== "");
  return (
    beforeOk &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= MAX_PAGE_LIMIT
  );
}

function answer(profile, call) {
  if (
    call === null ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    typeof call.kind !== "string"
  ) {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "updates":
      // Nothing is transferring, so there is nothing new and nothing removed.
      return {
        kind: "updates",
        profile,
        entries: [],
        removed: [],
        cleanup: idleCleanup(),
      };

    case "list":
      if (!isPageCall(call)) {
        return error(profile, "invalid");
      }
      return {
        kind: "page",
        profile,
        entries: [],
        next: null,
        // The manager that would answer this is not connected; saying so is
        // honest, claiming an empty history is not.
        supported: false,
        cleanup: idleCleanup(),
      };

    case "preferences":
      return {
        kind: "preferences",
        profile,
        preferences: defaultPreferences(),
        supported: false,
        // No download can be admitted without a manager, so the safe default
        // (a site may not write a file unprompted) stands.
        site_downloads_require_confirmation: true,
      };

    case "clear":
      // Clearing an empty list is a no-op that succeeds; there is nothing to
      // forget and no event to send.
      return { kind: "accepted", profile };

    case "retry_cleanup":
      // The cleanup state is idle, so there is no failed pass to retry.
      return { kind: "applied", profile };

    case "cancel":
    case "pause":
    case "resume":
    case "keep":
    case "discard":
    case "open":
    case "reveal":
    case "forget":
      // These name one transfer or one file; without the manager there is
      // none to act on.
      return isEntryId(call.id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "choose_directory":
      // The native directory picker belongs to the manager.
      return error(profile, "unavailable");

    case "set_ask_destination":
      return typeof call.enabled === "boolean"
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    default:
      return error(profile, "invalid");
  }
}

export const Downloads = {
  /**
   * Answer one `download_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `DownloadResponse` variant plus the echoed `profile`.
   */
  async call({ profile = "", expected_profile = "", call = null } = {}) {
    const asked =
      typeof profile === "string" && profile !== "" ? profile : expected_profile;
    if (typeof asked !== "string" || asked === "") {
      return error("", "invalid");
    }
    try {
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down.
      return error(asked, "runtime");
    }
  },

  /**
   * Where the system grants folder access. There is no native picker or OS
   * access panel to open until the real manager is connected, so this
   * reports `false` instead of pretending a panel opened.
   */
  async openAccessSettings() {
    return false;
  },
};
