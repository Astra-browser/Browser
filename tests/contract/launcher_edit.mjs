#!/usr/bin/env node
// `launcher_edit` — the address hand-off behind Ctrl+L and the sidebar search
// button. Before this route existed the app called a binding with no host
// target, swallowed the refusal, and the keystroke did nothing.
//
// Usage: node tests/contract/launcher_edit.mjs
// Exit 0 PASS, 1 FAIL. Stdlib only.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, check, failed } from "./lib/harness.mjs";

const { Launcher } = await import(pathToFileURL(path.join(HOST, "Launcher.sys.mjs")).href);
const { addEventListener } = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

const seen = [];
const stop = addEventListener((event) => {
  if (event?.type === "ui-command") seen.push(event.data);
});

const took = await Launcher.edit({ tab_id: "tab-1", url: "https://example.com/a?b=c=d" });
check("a web address is handed over", took === true);
check(
  "the command carries the whole address, encoded",
  seen.at(-1) === "launcher.edit=" + encodeURIComponent("https://example.com/a?b=c=d"),
  String(seen.at(-1)),
);
check(
  "an '=' inside the query survives the separator",
  decodeURIComponent(String(seen.at(-1)).slice("launcher.edit=".length)) ===
    "https://example.com/a?b=c=d",
);

check(
  "the camelCase binding name is accepted too",
  (await Launcher.edit({ tabId: "tab-1", url: "http://127.0.0.1:8080/" })) === true,
);
check(
  "a missing tab id is refused",
  (await Launcher.edit({ url: "https://example.com/" })) === false,
);
check(
  "an empty tab id is refused",
  (await Launcher.edit({ tab_id: "", url: "https://example.com/" })) === false,
);

const before = seen.length;
for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/Windows/win.ini", "", "not a url"]) {
  check(`${JSON.stringify(bad)} is refused`, (await Launcher.edit({ tab_id: "tab-1", url: bad })) === false);
}
check("a refused address emits nothing", seen.length === before);

const beforeBrowser = seen.length;
check("about:blank is refused", (await Launcher.edit({ tab_id: "tab-1", url: "about:blank" })) === false);
check("a refused internal address emits nothing", seen.length === beforeBrowser);

stop();
console.log(`\nlauncher edit contract: ${failed === 0 ? "PASS" : "FAIL"} (${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
