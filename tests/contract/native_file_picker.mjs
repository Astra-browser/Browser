#!/usr/bin/env node
// Native file-picker contract (wiring): the host modules must call
// `nsIFilePicker.init()` with the window's BrowsingContext.
//
// This engine's IDL is `void init(in BrowsingContext bc, ...)`
// (engine/widget/nsIFilePicker.idl). Passing the chrome window proxy (a
// mozIDOMWindowProxy) throws an XPConnect conversion error, the picker never
// opens, and the caller reports a silent `unavailable`. That is exactly the
// "Choose folder" / "New Tab image" / extension-package no-op the owner
// reported, so this test pins the argument shape.
//
// Usage: node tests/contract/native_file_picker.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

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

const RETURN_OK = 0;
const context = { name: "browsing-context" };
const windowProxy = { browsingContext: context, name: "window-proxy" };
const writes = [];
const prefs = {
  getBoolPref: (_name, fallback) => fallback,
  setBoolPref: () => {},
  getIntPref: (_name, fallback) => fallback,
  setIntPref: (name, value) => writes.push([name, value]),
  getStringPref: (_name, fallback) => fallback,
  setStringPref: (name, value) => writes.push([name, value]),
  clearUserPref: () => {},
};

const pickerCalls = [];
const fakePicker = {
  init(...args) {
    pickerCalls.push(args);
  },
  appendFilter() {},
  open(callback) {
    callback(RETURN_OK);
  },
  file: { path: "/tmp/astra-contract-downloads" },
};

globalThis.Services = {
  prefs,
  appinfo: { OS: "Linux" },
  wm: { getMostRecentWindow: () => windowProxy },
};
globalThis.ChromeUtils = {
  importESModule: () => ({
    Downloads: {
      PUBLIC: "public",
      getList: async () => ({
        addView() {},
        getAll: async () => [],
      }),
      getPreferredDownloadsDirectory: async () => "/home/person/Downloads",
    },
  }),
};
globalThis.Cc = {
  "@mozilla.org/filepicker;1": {
    createInstance: () => fakePicker,
  },
};
globalThis.Ci = {
  nsIFilePicker: {
    modeGetFolder: 2,
    modeOpen: 0,
    returnOK: RETURN_OK,
  },
};

const { Downloads } = await import(path.join(HOST, "Downloads.sys.mjs"));
const reply = await Downloads.call({
  profile: "00000000000000000000000001",
  call: { kind: "choose_directory" },
});

check("choose_directory reaches the picker", pickerCalls.length === 1);
const args = pickerCalls[0] ?? [];
check("picker.init receives the BrowsingContext", args[0] === context);
check("picker.init never receives the window proxy", args[0] !== windowProxy);
check("choose_directory answers preferences, not unavailable", reply.kind === "preferences");
check(
  "the chosen folder is written to browser.download.dir",
  writes.some(
    ([name, value]) =>
      name === "browser.download.dir" &&
      value === "/tmp/astra-contract-downloads",
  ),
);
check(
  "the folder choice is marked as custom (folderList = 2)",
  writes.some(
    ([name, value]) => name === "browser.download.folderList" && value === 2,
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
