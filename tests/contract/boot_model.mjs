#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
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
const { Boot, BootSidecar, SidecarFrame, __setCoreLauncherForTests } = await import(
  path.join(HOST, "Boot.sys.mjs"),
);
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
check("status keeps the v1 shape", !("core" in status));

const missing = await Boot.launchCore({ request_id: "boot-launch-empty" });
check("missing command is unavailable", missing.state === "unavailable");
check("unavailable explains why", typeof missing.reason === "string" && missing.reason !== "");
const refused = await Boot.launchCore({ request_id: "boot-launch-blank", command: "   " });
check("blank command is refused", refused.state === "unavailable");

const bye = await Boot.shutdown({ request_id: "boot-bye", reason: "test" });
check("shutdown succeeds", bye.shutdown === true);
check("shutdown reports no core", bye.core_stopped === false);

// --- one launch, shared by concurrent callers ----------------------------
let launches = 0;
let shutdowns = 0;
const fake = {
  alive: true,
  async call() {
    return { kind: "res" };
  },
  async shutdown() {
    this.alive = false;
    shutdowns += 1;
  },
};
__setCoreLauncherForTests(async () => {
  launches += 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return fake;
});
const [a, b] = await Promise.all([
  Boot.launchCore({ request_id: "boot-a", command: "/fake/core" }),
  Boot.launchCore({ request_id: "boot-b", command: "/fake/core" }),
]);
check("concurrent launches share one process", launches === 1);
check("first launch is running", a.state === "running");
check("second launch is running", b.state === "running");
const shut = await Boot.shutdown({ request_id: "boot-shut", reason: "test" });
check("shutdown stops the core", shut.core_stopped === true);
check("shutdown calls the handle once", shutdowns === 1);

// --- a dead handle is not reported as running ----------------------------
__resetForTests();
__setCoreLauncherForTests(async () => ({ alive: false }));
const dead = await Boot.launchCore({ request_id: "boot-dead", command: "/fake/dead" });
check("a dead launch is an error", dead.error?.code === "core_launch_failed");
let second = 0;
__setCoreLauncherForTests(async () => {
  second += 1;
  return { alive: true, async call() { return { kind: "res" }; }, async shutdown() {} };
});
const retry = await Boot.launchCore({ request_id: "boot-retry", command: "/fake/core" });
check("a dead core can be relaunched", retry.state === "running" && second === 1);
await Boot.shutdown({ request_id: "boot-shut-2" });

// --- shutdown does not hang on a silent core ------------------------------
let killed = 0;
const never = new Promise(() => {});
const silent = {
  stdin: { write: () => Promise.resolve() },
  stdout: { read: () => never, readString: () => never },
  kill: async () => {
    killed += 1;
  },
};
const handle = new BootSidecar(silent);
const started = Date.now();
await handle.shutdown(20);
check("shutdown times out instead of hanging", Date.now() - started < 500);
check("shutdown kills a silent core", killed === 1);
check("a shut handle is not alive", handle.alive === false);

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
