#!/usr/bin/env node
// Migration contract: Import browser data and Export browser data answer
// natively instead of `unknown_command`.
//
//   - sources are the engine's own migrators, never a hard-coded browser list
//   - a migration emits whole ImportJobView snapshots and finishes
//   - export writes the profile's data through a save picker
//   - a private window exports nothing
//
// Usage: node tests/contract/migration_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const BOOKMARKS = 0x20;
const HISTORY = 0x04;
const writes = [];
const pickerCalls = [];

const migrator = {
  async getSourceProfiles() {
    return [{ id: "Default", name: "Default" }];
  },
  async getMigrateData() {
    return BOOKMARKS | HISTORY;
  },
  async migrate(items, _startup, _profile, progress) {
    if (items & BOOKMARKS) progress(BOOKMARKS, true, { count: 3 });
    if (items & HISTORY) progress(HISTORY, true, { count: 5 });
  },
};

let privateWindow = false;
const historyRows = [
  {
    getResultByName(name) {
      return {
        url: "https://a.example/one",
        title: 'A, "quoted" page',
        visit_date: 1_700_000_000_000_000,
      }[name];
    },
  },
  {
    getResultByName(name) {
      return {
        url: "https://b.example/two",
        title: "Second visit",
        visit_date: 1_700_000_060_000_000,
      }[name];
    },
  },
];
globalThis.Ci = {
  nsIFilePicker: { modeSave: 1, returnOK: 0, returnReplace: 2 },
};
globalThis.Services = {
  wm: {
    getMostRecentWindow: () => ({
      browsingContext: { id: "bc" },
    }),
  },
};
globalThis.ChromeUtils = {
  importESModule: (uri) => {
    if (uri.includes("MigrationUtils")) {
      return {
        MigrationUtils: {
          availableMigratorKeys: ["chrome", "firefox", "empty", "internal-testing"],
          resourceTypes: { BOOKMARKS, HISTORY, ALL: 0 },
          getMigrator: async (key) =>
            key === "chrome"
              ? migrator
              : key === "empty"
                ? { ...migrator, getMigrateData: async () => 0 }
                : null,
        },
      };
    }
    if (uri.includes("PlacesUtils")) {
      return {
        PlacesUtils: {
          promiseBookmarksTree: async () => ({
            title: "",
            type: 2,
            children: [
              {
                title: "Work",
                type: 2,
                children: [
                  {
                    title: "A & B",
                    type: 1,
                    uri: "https://a.example/?a=1&b=2",
                    dateAdded: 1_700_000_000_000_000,
                  },
                ],
              },
              {
                title: 'Quote "page"',
                type: 1,
                uri: "https://b.example/",
                dateAdded: 1_700_000_100_000_000,
              },
            ],
          }),
          promiseDBConnection: async () => ({
            executeCached: async () => historyRows,
          }),
        },
      };
    }
    if (uri.includes("PrivateBrowsingUtils")) {
      return {
        PrivateBrowsingUtils: {
          isWindowPrivate: () => privateWindow,
        },
      };
    }
    return {};
  },
};
globalThis.IOUtils = {
  writeUTF8: async (target, text) => {
    writes.push({ target, text });
  },
};
const picker = {
  init(...args) {
    pickerCalls.push(args);
    picker.filters = [];
  },
  appendFilter(label, pattern) {
    picker.filters.push([label, pattern]);
  },
  open(callback) {
    callback(0);
  },
  file: { path: "/tmp/astra-export" },
  filters: [],
  defaultString: "",
  defaultExtension: "",
};
globalThis.Cc = {
  "@mozilla.org/filepicker;1": { createInstance: () => picker },
};

const { Migration } = await import(pathToFileURL(path.join(HOST, "Migration.sys.mjs")).href);
const { addEventListener, __resetEventsForTests } = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs"),).href);
__resetEventsForTests();
const jobs = [];
const off = addEventListener((event) => {
  if (event.type === "import-progress") jobs.push(event.data);
});

const sources = await Migration.importSources();
check("only migrators with readable data are offered", sources.length === 1);
check("the running browser is not a source", !sources.some((s) => s.id === "firefox"));
check("the test-only migrator is not a source", !sources.some((s) => s.id === "internal-testing"));
check("an empty browser is not offered", !sources.some((s) => s.id === "empty"));
check("the source names its profiles", sources[0]?.profiles?.[0]?.name === "Default");
check(
  "the source offers the resources it has",
  sources[0]?.kinds.join(",") === "bookmarks,history",
);

const started = await Migration.importStart({
  source: "chrome",
  profile: "Default",
  kinds: ["bookmarks", "history"],
});
check("a migration starts", started === true);
check("progress was emitted", jobs.length >= 2);
const final = jobs.at(-1);
check("the job finishes", final?.finished === true && final?.cancelled === false);
check(
  "every kind reports done",
  final?.kinds?.every((row) => row.state === "done"),
  JSON.stringify(final),
);

picker.file.path = "/tmp/astra-bookmarks.html";
const saved = await Migration.exportBrowserData({ kind: "bookmarks" });
check("bookmark export saves", saved === "saved");
check("the save picker received a BrowsingContext", pickerCalls[0]?.[0]?.id === "bc");
check("the file was written", writes.length === 1 && writes[0].target === "/tmp/astra-bookmarks.html");
check(
  "bookmarks export as an importable Netscape HTML file",
  writes[0]?.text.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>") &&
    writes[0]?.text.includes('<DT><H3>Work</H3>') &&
    writes[0]?.text.includes('HREF="https://a.example/?a=1&amp;b=2"') &&
    writes[0]?.text.includes('ADD_DATE="1700000000"'),
  writes[0]?.text,
);
check(
  "the bookmark picker offers HTML",
  picker.filters.some(([label, pattern]) => label === "HTML" && pattern === "*.html"),
);
check("the bookmark name says html", picker.defaultString === "astra-bookmarks.html");

picker.file.path = "/tmp/astra-history.csv";
const historySaved = await Migration.exportBrowserData({ kind: "history" });
check("history export saves", historySaved === "saved");
const csv = writes[1]?.text ?? "";
check(
  "history exports every visit as CSV date,title,address",
  csv.startsWith("date,title,address\r\n") &&
    csv.includes("2023-11-14T22:13:20.000Z,") &&
    csv.includes('"A, ""quoted"" page",https://a.example/one') &&
    csv.split("\r\n").filter(Boolean).length === 3,
  csv,
);
check(
  "the history picker offers CSV",
  picker.filters.some(([label, pattern]) => label === "CSV" && pattern === "*.csv"),
);
check("the history name says csv", picker.defaultString === "astra-history.csv");

privateWindow = true;
const privateOutcome = await Migration.exportBrowserData({ kind: "history" });
check("a private window exports nothing", privateOutcome === "private");
privateWindow = false;

off();
__resetEventsForTests();
globalThis.Services = undefined;
globalThis.ChromeUtils = undefined;
globalThis.IOUtils = undefined;
globalThis.Cc = undefined;
check("no chrome lists no sources", (await Migration.importSources()).length === 0);
check("no chrome cannot export", (await Migration.exportBrowserData({ kind: "bookmarks" })) === "failed");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
