#!/usr/bin/env node
// P6c-2 contract test: the certificate interstitial's host gate and fencing.
//
//   - only loopback/private/single-label hosts may be continued past
//   - a public name never is
//   - an answer without a live challenge is refused
//   - with no chrome services (Node), no error can be raised at all
//
// Usage: node tests/contract/dialog_prompts_cert.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { DialogPrompts, isLocalHost } = await import(path.join(HOST, "DialogPrompts.sys.mjs"));
const { Operations, __resetOperationsForTests } = await import(
  path.join(HOST, "Operations.sys.mjs")
);

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

const disposition = async (admission) => (await Operations.status(admission)).disposition;

for (const host of [
  "localhost",
  "app.localhost",
  "printer.local",
  "127.0.0.1",
  "127.9.9.9",
  "10.1.2.3",
  "192.168.1.10",
  "172.16.0.1",
  "172.31.255.1",
  "169.254.1.1",
  "nas",
  "::1",
]) {
  check(`${host} may be continued past`, isLocalHost(host) === true);
}
for (const host of [
  "example.com",
  "bank.example",
  "172.32.0.1",
  "172.15.0.1",
  "8.8.8.8",
  "203.0.113.9",
  "",
]) {
  check(`${host || "(empty)"} never is`, isLocalHost(host) === false);
}

__resetOperationsForTests();
DialogPrompts.__resetForTests();
const stale = await DialogPrompts.answerCert({ astra_tab_id: "tab-1", decision: "proceed-once" });
check("an answer with no challenge is refused", (await disposition(stale)).reason === "invalid_scope");
const bad = await DialogPrompts.answerCert({ astra_tab_id: "tab-1", decision: "always" });
check("an unknown decision is refused", (await disposition(bad)).reason === "invalid_scope");

// No chrome services in Node: raising an error is a fail-closed false.
const raised = await DialogPrompts.certErrorFor({
  browser: { browsingContext: {} },
  failedURI: "https://127.0.0.1/",
  tabId: "tab-1",
});
check("without chrome services no challenge is raised", raised === false);

console.log(
  `\ndialog prompts cert contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
