/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Migration module: Import browser data and Export browser data.
//
// Import reads another installed browser through the engine's own profile
// migrators (`MigrationUtils`), the same code Firefox's migration wizard
// calls. Astra supplies the surface and the progress snapshots; no Firefox
// window is opened. Export writes a portable file through a native save
// picker: bookmarks as Netscape HTML, history as CSV.
//
// What this module will and will not say:
// - A source is offered only when the engine reports a migrator and it can
//   read that browser now. Nothing is listed from a plausible name.
// - Progress is emitted as whole `ImportJobView` snapshots after each
//   resource; a finished job says so. A cancelled job stops being updated.
// - A private window exports nothing (`private`), as it keeps no bookmarks or
//   history. No chrome (Node) answers `failed`, never a fake `saved`.

import { emit } from "./Events.sys.mjs";

const FILE_SOURCE = "astra-file";
const FILE_PROFILES = [
  { id: "bookmarks", name: "Bookmarks (HTML)" },
  { id: "history", name: "History (CSV)" },
];

const NAMES = {
  chrome: "Google Chrome",
  "chrome-beta": "Google Chrome Beta",
  "chrome-dev": "Google Chrome Dev",
  chromium: "Chromium",
  canary: "Google Chrome Canary",
  brave: "Brave",
  opera: "Opera",
  "opera-gx": "Opera GX",
  vivaldi: "Vivaldi",
  edge: "Microsoft Edge (legacy)",
  "chromium-edge": "Microsoft Edge",
  "chromium-edge-beta": "Microsoft Edge Beta",
  "chromium-360se": "360 Secure Browser",
  safari: "Safari",
  firefox: "Firefox",
};

/** The current import, or null. */
let running = null;

function chromeScope() {
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis)
      scopes.push(globalThis.window);
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      if (scope?.ChromeUtils?.importESModule && (scope.Services || scope.Cc))
        return scope;
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
    };
  } catch {
    return null;
  }
}

/** `IOUtils` is a chrome WebIDL global in this engine, not a JS module. */
function ioutils(scope) {
  try {
    return scope.IOUtils ?? globalThis.IOUtils ?? null;
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

/**
 * A migrator's profile argument is the object `getSourceProfiles()` returned,
 * not the id alone: Chrome reads `aProfile.id` and falls back to the user-data
 * root when it is missing, which finds no bookmarks or history.
 */
function profileArg(profile) {
  if (
    profile === null ||
    profile === undefined ||
    profile === "" ||
    profile === "default"
  ) {
    return null;
  }
  return { id: String(profile), name: String(profile) };
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

/** Places dates are microseconds since the epoch; HTML wants seconds. */
function addedSeconds(dateAdded) {
  const micros = Number(dateAdded);
  return Number.isFinite(micros) && micros > 0
    ? String(Math.floor(micros / 1_000_000))
    : "";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The Netscape bookmark file every other browser can import. */
function bookmarksHtml(node) {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. Do not edit. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const indent = (depth) => "    ".repeat(depth);
  const walk = (entry, depth) => {
    for (const child of entry?.children ?? []) {
      if (child.type === 2) {
        lines.push(
          `${indent(depth)}<DT><H3>${escapeHtml(child.title ?? "")}</H3>`,
        );
        lines.push(`${indent(depth)}<DL><p>`);
        walk(child, depth + 1);
        lines.push(`${indent(depth)}</DL><p>`);
      } else if (child.type === 1 && typeof child.uri === "string") {
        const added = addedSeconds(child.dateAdded);
        const stamp = added === "" ? "" : ` ADD_DATE="${added}"`;
        lines.push(
          `${indent(depth)}<DT><A HREF="${escapeHtml(child.uri)}"${stamp}>` +
            `${escapeHtml(child.title ?? child.uri)}</A>`,
        );
      }
    }
  };
  walk(node, 1);
  lines.push("</DL><p>");
  return lines.join("\n") + "\n";
}

function csvCell(text) {
  const value = String(text ?? "");
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row per visit, with the date, title and address. */
function historyCsv(visits) {
  const lines = ["date,title,address"];
  for (const visit of visits) {
    const micros = Number(visit.visit_date);
    const date =
      Number.isFinite(micros) && micros > 0
        ? new Date(micros / 1000).toISOString()
        : "";
    lines.push(
      `${csvCell(date)},${csvCell(visit.title)},${csvCell(visit.url)}`,
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** RFC 4180 rows, including quoted commas, quotes and newlines. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function historyPages(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const dateAt = header.indexOf("date");
  const titleAt = header.indexOf("title");
  const urlAt = header.indexOf("address");
  if (dateAt < 0 || urlAt < 0) return [];
  const pages = [];
  for (const row of rows.slice(1)) {
    const url = String(row[urlAt] ?? "").trim();
    if (url === "") continue;
    try {
      new URL(url);
    } catch {
      continue;
    }
    const parsed = new Date(String(row[dateAt] ?? ""));
    if (Number.isNaN(parsed.getTime())) continue;
    pages.push({
      url,
      title: titleAt < 0 ? "" : String(row[titleAt] ?? ""),
      visits: [{ date: parsed }],
    });
  }
  return pages;
}

async function chooseFile(
  scope,
  { title, defaultName, defaultExtension, filterLabel },
) {
  try {
    const picker = scope.Cc["@mozilla.org/filepicker;1"].createInstance(
      scope.Ci.nsIFilePicker,
    );
    const win = scope.Services.wm.getMostRecentWindow("navigator:browser");
    const context = win?.browsingContext ?? null;
    if (!context) return "";
    picker.init(context, title, scope.Ci.nsIFilePicker.modeOpen);
    picker.defaultString = defaultName;
    picker.defaultExtension = defaultExtension;
    picker.appendFilter(filterLabel, `*.${defaultExtension}`);
    const result = await new Promise((resolve) => picker.open(resolve));
    if (result !== scope.Ci.nsIFilePicker.returnOK) return "";
    return picker.file?.path ?? "";
  } catch {
    return "";
  }
}

/** Import a file Astra itself exported, so a person can move a profile. */
async function importFile(profile, kinds) {
  if (running) return false;
  const kind =
    profile === "history"
      ? "history"
      : profile === "bookmarks"
        ? "bookmarks"
        : "";
  if (kind === "" || !Array.isArray(kinds) || !kinds.includes(kind))
    return false;
  const scope = chromeScope();
  if (!scope) return false;
  const services = scope.Services;
  const io = ioutils(scope);
  const { PlacesUtils } = modules(scope) ?? {};
  if (!services || !io || !PlacesUtils) return false;

  const context = {
    job: jobOf(FILE_SOURCE, profile, [kind]),
    cancelled: false,
  };
  running = context;
  context.job.kinds[0].state = "running";
  publish(context);

  try {
    const path = await chooseFile(scope, {
      title: kind === "bookmarks" ? "Import bookmarks" : "Import history",
      defaultName: kind === "bookmarks" ? "bookmarks.html" : "history.csv",
      defaultExtension: kind === "bookmarks" ? "html" : "csv",
      filterLabel: kind === "bookmarks" ? "HTML" : "CSV",
    });
    if (path === "") {
      context.job.kinds[0].state = "skipped";
      context.job.finished = true;
      publish(context);
      return true;
    }
    let count = 0;
    if (kind === "bookmarks") {
      const { BookmarkHTMLUtils } = scope.ChromeUtils.importESModule(
        "resource://gre/modules/BookmarkHTMLUtils.sys.mjs",
      );
      count =
        Number(
          await BookmarkHTMLUtils.importFromFile(path, { replace: false }),
        ) || 0;
    } else {
      const text = await io.readUTF8(path);
      const pages = historyPages(text);
      for (let index = 0; index < pages.length; index += 200) {
        await PlacesUtils.history.insertMany(pages.slice(index, index + 200));
      }
      count = pages.length;
    }
    const row = context.job.kinds[0];
    row.state = "done";
    row.done = count;
    row.total = count;
    context.job.finished = true;
    publish(context);
    return true;
  } catch {
    const row = context.job.kinds[0];
    row.state = "failed";
    row.problem = "unreadable";
    context.job.finished = true;
    publish(context);
    return false;
  } finally {
    if (running === context) running = null;
  }
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
      // Migrating the running browser into itself is not a source, and the
      // engine's test-only migrator is never a browser a person can pick.
      if (key === "firefox" || key === "internal-testing") continue;
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
      if (profiles.length === 0)
        profiles = [{ id: "default", name: "Default" }];
      // What this source can actually give: the engine's own per-profile
      // answer, not the global capability bits, so an empty browser is not
      // offered as if it held data. Every readable profile contributes to the
      // kinds, because the picker lets a person choose any one of them.
      let data = 0;
      const readable = [];
      for (const candidate of profiles) {
        let profileData = 0;
        try {
          profileData = Number(
            await migrator.getMigrateData(
              candidate.id === "default" ? null : candidate,
            ),
          );
        } catch {
          profileData = 0;
        }
        if (profileData === 0) continue;
        readable.push(candidate);
        data |= profileData;
      }
      if (readable.length === 0) continue;
      const kinds = [];
      if ((data & bit(mu, "BOOKMARKS")) !== 0) kinds.push("bookmarks");
      if ((data & bit(mu, "HISTORY")) !== 0) kinds.push("history");
      if (kinds.length === 0) continue;
      out.push({
        id: key,
        browser: key,
        name: displayName(key),
        profiles: readable,
        kinds,
        needs_permission: false,
      });
    }
    out.push({
      id: FILE_SOURCE,
      browser: "astra",
      name: "Astra export file",
      profiles: FILE_PROFILES,
      kinds: ["bookmarks", "history"],
      needs_permission: false,
    });
    return out;
  },

  /** Start one migration. Progress arrives on `import-progress`. */
  async importStart({ source = "", profile = "default", kinds = [] } = {}) {
    if (source === FILE_SOURCE) return importFile(profile, kinds);
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
      await migrator.migrate(items, false, profileArg(profile), progress);
      if (!context.cancelled) {
        for (const row of context.job.kinds) {
          if (row.state === "queued" || row.state === "running")
            row.state = "done";
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

  /** Write the profile's bookmarks as HTML or its history as CSV. */
  async exportBrowserData({ kind = "" } = {}) {
    if (kind !== "bookmarks" && kind !== "history") return "failed";
    const scope = chromeScope();
    if (!scope) return "failed";
    const services = scope.Services;
    const { PlacesUtils } = modules(scope) ?? {};
    const io = ioutils(scope);
    if (!services || !PlacesUtils || !io) return "failed";

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

    let text;
    try {
      if (kind === "bookmarks") {
        const tree = await PlacesUtils.promiseBookmarksTree("", {
          includeItemIds: false,
        });
        text = bookmarksHtml(tree);
      } else {
        const db = await PlacesUtils.promiseDBConnection();
        const rows = await db.executeCached(
          `SELECT p.url AS url, p.title AS title, v.visit_date AS visit_date
             FROM moz_historyvisits v
             JOIN moz_places p ON p.id = v.place_id
            WHERE p.hidden = 0
            ORDER BY v.visit_date DESC
            LIMIT 100000`,
        );
        text = historyCsv(
          rows.map((row) => ({
            url: row.getResultByName("url"),
            title: row.getResultByName("title") ?? "",
            visit_date: row.getResultByName("visit_date"),
          })),
        );
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
      picker.init(
        context,
        "Export browser data",
        scope.Ci.nsIFilePicker.modeSave,
      );
      const extension = kind === "bookmarks" ? "html" : "csv";
      picker.defaultString = `astra-${kind}.${extension}`;
      picker.defaultExtension = extension;
      picker.appendFilter(
        kind === "bookmarks" ? "HTML" : "CSV",
        `*.${extension}`,
      );
      const result = await new Promise((resolve) => picker.open(resolve));
      if (
        result !== scope.Ci.nsIFilePicker.returnOK &&
        result !== scope.Ci.nsIFilePicker.returnReplace
      ) {
        return "cancelled";
      }
      target = picker.file?.path ?? "";
    } catch {
      return "failed";
    }
    if (target === "") return "failed";
    try {
      await io.writeUTF8(target, text);
      return "saved";
    } catch {
      return "failed";
    }
  },
};
