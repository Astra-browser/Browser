#!/usr/bin/env node
// Every tab mutation the UI settles must answer an OperationAdmission:
// { operation_id: null, accepted: true } plus the host API envelope fields.
// A bare projection makes settle() report "rejected" (Work browse, menu
// actions). Also fences the accepted-certificate flag to its origin.
//
// Usage: node tests/contract/tabs_admission.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { Tabs, __resetTabsForTests, __setCertificateException, __applyExternalUpdate } =
  await import(path.join(HOST, "Tabs.sys.mjs"));

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
const admitted = (res) =>
  res?.accepted === true && res?.operation_id === null && res?.host_api_version === 1;

__resetTabsForTests();
await Tabs.bootstrap({ request_id: "boot" });
const first = (await Tabs.list({ request_id: "l" })).tabs[0].astra_tab_id;

const created = await Tabs.create({ request_id: "c", url: "https://a.example/" });
check("create admits", admitted(created));
const id = created.astra_tab_id;
check("select admits", admitted(await Tabs.select({ request_id: "s", astra_tab_id: id })));
check("pin admits", admitted(await Tabs.pin({ request_id: "p", astra_tab_id: id })));
check("unpin admits", admitted(await Tabs.unpin({ request_id: "u", astra_tab_id: id })));
check("discard admits", admitted(await Tabs.discard({ request_id: "d", astra_tab_id: id })));
check("wakeup admits", admitted(await Tabs.wakeup({ request_id: "w", astra_tab_id: id })));
const dup = await Tabs.duplicate({ request_id: "du", astra_tab_id: id });
check("duplicate admits", admitted(dup));
check("move admits", admitted(await Tabs.move({ request_id: "m", astra_tab_id: id, index: 0 })));
check("setMuted admits", admitted(await Tabs.setMuted({ request_id: "mu", astra_tab_id: id, muted: true })));
check("close admits", admitted(await Tabs.close({ request_id: "cl", astra_tab_id: dup.astra_tab_id })));

// The accepted-certificate flag belongs to the origin it was accepted for.
__setCertificateException(id, true, "https://bad.example");
let tab = (await Tabs.list({ request_id: "l2" })).tabs.find((entry) => entry.astra_tab_id === id);
check("the exception is set for its origin", tab?.certificate_exception === true);
__applyExternalUpdate(id, { url: "https://other.example/" });
tab = (await Tabs.list({ request_id: "l3" })).tabs.find((entry) => entry.astra_tab_id === id);
check("a different origin clears it", tab?.certificate_exception === false);
__setCertificateException(id, true, "https://bad.example");
__applyExternalUpdate(id, { url: "https://bad.example/next" });
tab = (await Tabs.list({ request_id: "l4" })).tabs.find((entry) => entry.astra_tab_id === id);
check("the same origin keeps it", tab?.certificate_exception === true);
check("the first tab is untouched", first !== "");

console.log(
  `\ntabs admission contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
