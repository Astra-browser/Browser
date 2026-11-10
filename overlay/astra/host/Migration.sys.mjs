/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Migration module: Import browser data and Export browser data.
//
// Import reads another installed browser through the engine's own profile
// migrators (`MigrationUtils`), the same code Firefox's migration wizard
// calls. Astra supplies the surface and the progress snapshots; no Firefox
// window is opened. Export writes a portable JSON file through a native save
// picker: the profile's bookmarks tree or its Places history.
//
// What this module will and will not say:
// - A source is offered only when the engine reports a migrator and it can
//   read that browser now. Nothing is listed from a plausible name.
// - Progress is emitted as whole `ImportJobView` snapshots after each
//   resource; a finished job says so. A cancelled job stops being updated.
// - A private window exports nothing (`private`), as it keeps no bookmarks or
//   history. No chrome (Node) answers `failed`, never a fake `saved`.

import { emit } from "./Events.sys.mjs";

const NAMES = {
  chrome: "Chrome",
  chromium: "Chromium",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  edge: "Edge",
  safari: "Safari",
  firefox: "Firefox",
};

/** The current import, or null. */
let running = null;

function chromeScope() {
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) scopes.push(globalThis.window);
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      if (scope?.ChromeUtils?.importESModule && (scope.Services || scope.Cc)) return scope;
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

function modules(scope) {
  try {
    return {
      MigrationUtils: scope.ChromeUtils.importESModule(
        "resource:///modules/MigrationUtils.sys.mjs",
      ).MigrationUtils,
      PlacesUtils: scope.ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs",
      ).PlacesUtils,
      IOUtils: scope.ChromeUtils.importESModule(
        "resource://gre/modules/IOUtils.sys.mjs",
      ).IOUtils,
    };
  } catch {
    return null;
  }
}

function jobOf(source, profile, kinds) {
  return {
    source,
    profile,
    kinds: kinds.map((kind) => ({
      kind,
      state: "queued",
      done: 0,
      total: null,
      problem: null,
    })),
    finished: false,
    cancelled: false,
  };
}

function publish(context) {
  if (context.cancelled) {
    context.job.cancelled = true;
    context.job.finished = true;
  }
  emit("import-progress", context.job);
}

function bit(mu, name) {
  return Number(mu.resourceTypes?.[name] ?? 0);
}

function kindOf(mu, type) {
  if (type === bit(mu, "BOOKMARKS")) return "bookmarks";
  if (type === bit(mu, "HISTORY")) return "history";
  return "";
}

/** The imported item's name for a browser key. */
function displayName(key) {
  return NAMES[key] ?? key;
}

export const Migration = {
  /** The installed browsers the engine can read right now. */
  async importSources() {
    const scope = chromeScope();
    if (!scope) return [];
    const loaded = modules(scope);
    const mu = loaded?.MigrationUtils;
    if (!mu) return [];
    const out = [];
    let keys = [];
    try {
      keys = [...(mu.availableMigratorKeys ?? [])];
    } catch {
      keys = [];
    }
    for (const key of keys) {
      // Migrating the running browser into itself is not a source.
      if (key === "firefox") continue;
      let migrator = null;
      try {
        migrator = await mu.getMigrator(key);
      } catch {
        migrator = null;
      }
      if (!migrator) continue;
      let profiles = [];
      try {
        const listed = await migrator.getSourceProfiles();
        if (Array.isArray(listed)) {
          profiles = listed
            .map((profile) => ({
              id: String(profile.id ?? ""),
              name: String(profile.name ?? "Default"),
            }))
            .filter((profile) => profile.id !== "");
        }
      } catch {
        profiles = [];
      }
      if (profiles.length === 0) profiles = [{ id: "default", name: "Default" }];
      const kinds = [];
      if (bit(mu, "BOOKMARKS") !== 0) kinds.push("bookmarks");
      if (bit(mu, "HISTORY") !== 0) kinds.push("history");
      if (kinds.length === 0) continue;
      out.push({
        id: key,
        browser: key,
        name: displayName(key),
        profiles,
        kinds,
        needs_permission: false,
      });
    }
    return out;
  },

  /** Start one migration. Progress arrives on `import-progress`. */
  async importStart({ source = "", profile = "default", kinds = [] } = {}) {
    const scope = chromeScope();
    const loaded = scope ? modules(scope) : null;
    const mu = loaded?.MigrationUtils;
    if (!mu || typeof source !== "string" || source === "") return false;
    if (!Array.isArray(kinds) || kinds.length === 0) return false;
    let migrator = null;
    try {
      migrator = await mu.getMigrator(source);
    } catch {
      migrator = null;
    }
    if (!migrator || typeof migrator.migrate !== "function") return false;

    const context = {
      job: jobOf(source, profile, kinds),
      cancelled: false,
    };
    running = context;
    publish(context);

    const items =
      (kinds.includes("bookmarks") ? bit(mu, "BOOKMARKS") : 0) |
      (kinds.includes("history") ? bit(mu, "HISTORY") : 0);

    const progress = (type, success, details = null) => {
      if (context.cancelled) return;
      const kind = kindOf(mu, Number(type));
      if (kind === "") return;
      const row = context.job.kinds.find((entry) => entry.kind === kind);
      if (!row) return;
      row.state = success === false ? "failed" : "done";
      if (typeof details?.count === "number") row.done = details.count;
      if (success === false) {
        row.problem = String(details?.problem ?? "unreadable");
      }
      publish(context);
    };

    try {
      await migrator.migrate(items, false, profile === "default" ? null : profile, progress);
      if (!context.cancelled) {
        for (const row of context.job.kinds) {
          if (row.state === "queued" || row.state === "running") row.state = "done";
        }
        context.job.finished = true;
        publish(context);
      }
      return true;
    } catch {
      if (!context.cancelled) {
        for (const row of context.job.kinds) {
          if (row.state === "queued" || row.state === "running") {
            row.state = "failed";
            row.problem = "unreadable";
          }
        }
        context.job.finished = true;
        publish(context);
      }
      return false;
    } finally {
      if (running === context) running = null;
    }
  },

  /** Stop publishing; the engine's own migration cannot be interrupted. */
  async importCancel() {
    if (!running) return false;
    running.cancelled = true;
    publish(running);
    return true;
  },

  /** No platform here gates a browser behind an OS permission panel. */
  async importOpenPermission() {
    return false;
  },

  /** Write the profile's bookmarks or history to a JSON file the person picks. */
  async exportBrowserData({ kind = "" } = {}) {
    if (kind !== "bookmarks" && kind !== "history") return "failed";
    const scope = chromeScope();
    if (!scope) return "failed";
    const services = scope.Services;
    const { PlacesUtils, IOUtils } = modules(scope) ?? {};
    if (!services || !PlacesUtils || !IOUtils) return "failed";

    let isPrivate = false;
    try {
      const { PrivateBrowsingUtils } = scope.ChromeUtils.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      const win = services.wm.getMostRecentWindow("navigator:browser");
      isPrivate = PrivateBrowsingUtils.isWindowPrivate(win) === true;
    } catch {
      isPrivate = false;
    }
    if (isPrivate) return "private";

    let data;
    try {
      if (kind === "bookmarks") {
        data = {
          format: "astra-bookmarks-v1",
          exported_at: new Date().toISOString(),
          bookmarks: await PlacesUtils.promiseBookmarksTree("", {
            includeItemIds: false,
          }),
        };
      } else {
        const db = await PlacesUtils.promiseDBConnection();
        const rows = await db.executeCached(
          `SELECT url, title, visit_count, last_visit_date
             FROM moz_places
            WHERE hidden = 0 AND last_visit_date IS NOT NULL
            ORDER BY last_visit_date DESC
            LIMIT 100000`,
        );
        data = {
          format: "astra-history-v1",
          exported_at: new Date().toISOString(),
          visits: rows.map((row) => ({
            url: row.getResultByName("url"),
            title: row.getResultByName("title") ?? "",
            visit_count: row.getResultByName("visit_count") ?? 0,
            last_visit:
              Number(row.getResultByName("last_visit_date") ?? 0) / 1000,
          })),
        };
      }
    } catch {
      return "failed";
    }

    let target = "";
    try {
      const picker = scope.Cc["@mozilla.org/filepicker;1"].createInstance(
        scope.Ci.nsIFilePicker,
      );
      const win = services.wm.getMostRecentWindow("navigator:browser");
      const context = win?.browsingContext ?? null;
      if (!context) return "failed";
      picker.init(context, "Export browser data", scope.Ci.nsIFilePicker.modeSave);
      picker.defaultString = `astra-${kind}.json`;
      picker.defaultExtension = "json";
      picker.appendFilter("JSON", "*.json");
      const result = await new Promise((resolve) => picker.open(resolve));
      if (result !== scope.Ci.nsIFilePicker.returnOK &&
          result !== scope.Ci.nsIFilePicker.returnReplace) {
        return "cancelled";
      }
      target = picker.file?.path ?? "";
    } catch {
      return "failed";
    }
    if (target === "") return "failed";
    try {
      await IOUtils.writeUTF8(target, JSON.stringify(data, null, 2));
      return "saved";
    } catch {
      return "failed";
    }
  },
};
