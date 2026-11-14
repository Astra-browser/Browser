#!/usr/bin/env node
// Diagnostics contract: About's report is real profile/process data, and the
// log-folder control reveals a folder instead of silently doing nothing.
//
// The app used to show "Couldn't read the diagnostics. Try again." because
// `diagnostics_report` had no host route; `diagnostics_show_logs` was equally
// unrouted. Pin the text, the redaction and the reveal.
//
// Usage: node tests/contract/diagnostics_model.mjs
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

const reviewed = [];
const logsFile = {
  path: "/home/person/.mozilla/astra/astra/logs",
  exists: () => true,
  reveal() {
    reviewed.push(this.path);
  },
};
const profileFile = {
  path: "/home/person/.mozilla/astra",
  clone() {
    return {
      path: `${this.path}/astra/logs`,
      append() {},
      exists: () => true,
      reveal() {
        reviewed.push(this.path);
      },
    };
  },
};
const prefs = {
  getStringPref: (name, fallback) => {
    if (name === "astra.blocker.installed") {
      return JSON.stringify({ lists: { a: {}, b: {}, c: {} } });
    }
    if (name === "astra.version") return "0.1.742";
    if (name === "astra.settings.appearance") return "dark";
    if (name === "astra.settings.zoom.default") return "110";
    if (name === "astra.settings.performance.sleep") return "true";
    return fallback;
  },
  getBoolPref: (_name, fallback) => fallback,
  setBoolPref: () => {},
};

globalThis.Ci = { nsIFile: 1 };
globalThis.Services = {
  appinfo: {
    version: "153.0",
    buildID: "20261101000000",
    OS: "Linux",
    XPCOMABI: "x86_64-gcc3",
  },
  sysinfo: { getProperty: () => "6.17.0" },
  locale: { appLocales: ["en-US"] },
  prefs,
  dirsvc: {
    get(key) {
      return key === "Home" ? { path: "/home/person" } : profileFile;
    },
  },
};

const { System } = await import(pathToFileURL(path.join(HOST, "System.sys.mjs")).href);
const report = await System.diagnosticsReport();

check("a report is returned", typeof report === "string" && report.length > 0);
check("the report names the Astra build", /Astra: 0\.1\.742 \(build 20261101000000\)/u.test(report ?? ""));
check("the report names the engine it runs on", /Engine: Firefox 153\.0/u.test(report ?? ""));
check("the report names the platform", /Platform: Linux x86_64-gcc3/u.test(report ?? ""));
check("the report names the system build", /System build: 6\.17\.0/u.test(report ?? ""));
check("the report names the locale", /Locale: en-US/u.test(report ?? ""));
check("the report counts installed blocker lists", /Blocker lists installed: 3/u.test(report ?? ""));
check(
  "the report hides the home directory",
  !String(report).includes("/home/person") && String(report).includes("~"),
  report,
);

const revealed = await System.diagnosticsShowLogs();
check("show-logs reports a reveal", revealed === true);
check("show-logs reveals the log folder", reviewed.length === 1 && reviewed[0].endsWith("/astra/logs"));

globalThis.Services = undefined;
check("no chrome means no report, not a fake one", (await System.diagnosticsReport()) === null);
check("no chrome means no reveal", (await System.diagnosticsShowLogs()) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
