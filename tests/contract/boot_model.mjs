#!/usr/bin/env node
// Boot module contract (P1 merge): one startup owner for the Rust core.
//
//   - handshake keeps version negotiation, default window and event_seq
//   - a missing core command is an honest `unavailable`, never a fake launch
//   - coreStatus and shutdown are safe before any core is launched
//   - the Appendix C frame stays 4-byte BE length + UTF-8 JSON
//   - importing Boot in Node does not resolve the chrome-only Subprocess
//
// Usage: node tests/contract/boot_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Boot, BootSidecar, SidecarFrame } = await import(path.join(HOST, "Boot.sys.mjs"));
const { __resetForTests, addEventListener } = HostAPI;

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

__resetForTests();

// --- handshake ------------------------------------------------------------
const tooNew = await Boot.handshake({
  request_id: "boot-new",
  min_host_api_version: 999,
});
check("rejects a newer host API", tooNew.error?.code === "incompatible_host");
check("echoes request_id on rejection", tooNew.request_id === "boot-new");

const seen = [];
const off = addEventListener((event) => {
  if (event.type === "boot.ready") seen.push(event.data);
});
const hello = await Boot.handshake({ request_id: "boot-1", core_version: 1 });
off();
check("handshake succeeds", !hello.error);
check("handshake carries a window id", typeof hello.window_id === "string" && hello.window_id !== "");
check("handshake carries an event_seq", Number.isInteger(hello.event_seq));
check("handshake emits boot.ready", seen.length === 1);
check("boot.ready names the host API", seen[0]?.host_api_version === 1);

// --- no core yet ----------------------------------------------------------
const status = await Boot.status({ request_id: "boot-status" });
check("status is ready", status.ready === true);
check("status reports a stopped core", status.core === "stopped");
const core = await Boot.coreStatus({ request_id: "boot-core" });
check("coreStatus is stopped", core.state === "stopped");

const missing = await Boot.launchCore({ request_id: "boot-launch-empty" });
check("missing command is unavailable", missing.state === "unavailable");
check("unavailable explains why", typeof missing.reason === "string" && missing.reason !== "");
const refused = await Boot.launchCore({ request_id: "boot-launch-blank", command: "   " });
check("blank command is refused", refused.state === "unavailable");

// --- shutdown is safe with no core ---------------------------------------
const bye = await Boot.shutdown({ request_id: "boot-bye", reason: "test" });
check("shutdown succeeds", bye.shutdown === true);
check("shutdown reports no core", bye.core_stopped === false);

// --- Appendix C framing ---------------------------------------------------
const frame = SidecarFrame.encode({ v: 1, id: "x", kind: "req", name: "n", seq: 0, payload: {} });
const view = new DataView(frame);
const len = view.getUint32(0, false);
check("frame length prefix matches body", len === frame.byteLength - 4);
const body = JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4)));
check("frame body round-trips", body.id === "x" && body.kind === "req");
check("BootSidecar is exported from Boot", typeof BootSidecar === "function");

assert.equal(failed, 0, `${failed} boot checks failed`);
console.log(`\nboot_model: ${passed} passed, ${failed} failed`);
