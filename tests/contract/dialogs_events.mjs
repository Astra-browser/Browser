#!/usr/bin/env node
// P3-T09 contract test: Dialogs request-event emission + resolve flows.
//
// Imports the chrome module by file path (pure logic, no Firefox
// internals) and asserts the shape from docs/astra/DIALOGS.md:
//   - every request emits its event and returns a pending dialog
//   - every chrome resolve marks the dialog resolved and emits the paired event
//   - every result echoes `request_id` + `host_api_version: 1`
//   - every emitted event validates against overlay/astra/host/schemas/dialogs.json
//
// Usage: node tests/contract/dialogs_events.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Dialogs, __resetDialogsForTests } = await import(path.join(HOST, "Dialogs.sys.mjs"));
const EventsMod = await import(path.join(HOST, "Events.sys.mjs"));
const { addEventListener } = EventsMod;

const schema = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(HOST, "schemas", "dialogs.json"), "utf8"),
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

function checkEnv(name, res, rid) {
  check(`${name} echoes request_id`, res.request_id === rid);
  check(`${name} carries host_api_version 1`, res.host_api_version === 1);
}

// Minimal hand-rolled validation of emitted events against dialogs.json:
// every event type must be a schema key, required fields present, and
// enum fields within their allowed values.
function checkEventValid(name, event) {
  const def = schema.properties[event.type];
  check(`${name} type in dialogs.json schema`, !!def);
  if (!def) {
    return;
  }
  const missing = (def.required ?? []).filter((k) => !(k in event.data));
  check(`${name} required fields present`, missing.length === 0);
  for (const [key, prop] of Object.entries(def.properties ?? {})) {
    if (key in event.data && prop.enum && !prop.enum.includes(event.data[key])) {
      check(`${name}.${key} in enum`, false);
      return;
    }
  }
  check(`${name} schema-valid`, true);
}

__resetDialogsForTests();
EventsMod.__resetEventsForTests();
const seen = [];
const off = addEventListener((e) => seen.push(e));
const byType = (t) => seen.filter((e) => e.type === t);
const CHROME = { actor: "chrome" };

// === Permissions ===
{
  const res = await Dialogs.requestPermission({
    request_id: "p-1", astra_tab_id: "tab-1", url: "https://a.example/", permission: "camera", ...CHROME,
  });
  checkEnv("permission.request", res, "p-1");
  check("permission dialog pending", res.dialog?.status === "pending" && typeof res.dialog?.dialog_id === "string");
  const id = res.dialog.dialog_id;
  check("emitted permission.requested", byType("permission.requested").some((e) => e.data.dialog_id === id));
  checkEventValid("permission.requested", byType("permission.requested").at(-1));

  const bad = await Dialogs.requestPermission({
    request_id: "p-1b", astra_tab_id: "tab-1", url: "https://a.example/", permission: "telepathy", ...CHROME,
  });
  check("unknown permission rejected", bad.error?.code === "invalid_permission");

  const grant = await Dialogs.decidePermission({ request_id: "p-2", dialog_id: id, decision: "grant", ...CHROME });
  checkEnv("permission.grant", grant, "p-2");
  check("grant kept", grant.decision === "grant");
  check("emitted permission.resolved", byType("permission.resolved").some((e) => e.data.decision === "grant"));
  checkEventValid("permission.resolved", byType("permission.resolved").at(-1));
  const got = await Dialogs.get({ request_id: "p-3", dialog_id: id });
  check("dialog marked resolved", got.dialog?.status === "resolved");

  const again = await Dialogs.decidePermission({ request_id: "p-4", dialog_id: id, decision: "deny", ...CHROME });
  check("double resolve rejected", again.error?.code === "already_resolved");
  const nope = await Dialogs.decidePermission({ request_id: "p-5", dialog_id: "dlg-nope", decision: "deny", ...CHROME });
  check("unknown dialog rejected", nope.error?.code === "no_such_dialog");
  const badD = await Dialogs.decidePermission({ request_id: "p-6", dialog_id: "dlg-nope", decision: "maybe", ...CHROME });
  check("bad decision rejected", badD.error?.code === "invalid_decision");
}

// === Downloads ===
{
  const res = await Dialogs.requestDownload({
    request_id: "d-1", astra_tab_id: "tab-1", url: "https://a.example/f.bin", filename: "f.bin", mime: "application/octet-stream", ...CHROME,
  });
  checkEnv("download.request", res, "d-1");
  const id = res.dialog.dialog_id;
  check("emitted download.started", byType("download.started").some((e) => e.data.filename === "f.bin"));
  checkEventValid("download.started", byType("download.started").at(-1));
  const allow = await Dialogs.decideDownload({ request_id: "d-2", dialog_id: id, decision: "allow", ...CHROME });
  checkEnv("download.allow", allow, "d-2");
  check("emitted download.resolved", byType("download.resolved").some((e) => e.data.decision === "allow"));
  checkEventValid("download.resolved", byType("download.resolved").at(-1));
  const empty = await Dialogs.requestDownload({ request_id: "d-3", astra_tab_id: "tab-1", url: "https://a.example/f", filename: "", ...CHROME });
  check("empty filename rejected", empty.error?.code === "invalid_filename");
}

// === HTTP auth (secrets never echoed) ===
{
  const res = await Dialogs.requestAuth({
    request_id: "a-1", astra_tab_id: "tab-1", host: "intranet.example", realm: "Files", scheme: "basic", ...CHROME,
  });
  checkEnv("auth.request", res, "a-1");
  const id = res.dialog.dialog_id;
  check("emitted auth.required", byType("auth.required").some((e) => e.data.host === "intranet.example"));
  checkEventValid("auth.required", byType("auth.required").at(-1));
  const badScheme = await Dialogs.requestAuth({ request_id: "a-1b", astra_tab_id: "tab-1", host: "h", scheme: "magic", ...CHROME });
  check("bad scheme rejected", badScheme.error?.code === "invalid_scheme");

  const creds = await Dialogs.respondAuth({ request_id: "a-2", dialog_id: id, username: "u", password: "s3cret", ...CHROME });
  checkEnv("auth.respond", creds, "a-2");
  check("provided true", creds.provided === true);
  const ev = byType("auth.resolved").at(-1);
  checkEventValid("auth.resolved", ev);
  check("event carries no password", !("password" in ev.data) && !("username" in ev.data));

  const res2 = await Dialogs.requestAuth({ request_id: "a-3", astra_tab_id: "tab-1", host: "h2.example", ...CHROME });
  const cancelled = await Dialogs.respondAuth({ request_id: "a-4", dialog_id: res2.dialog.dialog_id, cancel: true, ...CHROME });
  check("cancel provides nothing", cancelled.provided === false);
  const noUser = await Dialogs.requestAuth({ request_id: "a-5", astra_tab_id: "tab-1", host: "h3.example", ...CHROME });
  const missing = await Dialogs.respondAuth({ request_id: "a-6", dialog_id: noUser.dialog.dialog_id, ...CHROME });
  check("missing username rejected", missing.error?.code === "invalid_credentials");
  const cleanup = await Dialogs.respondAuth({ request_id: "a-7", dialog_id: noUser.dialog.dialog_id, cancel: true, ...CHROME });
  check("leftover auth dialog cancelled", cleanup.provided === false);
}

// === Certificate errors ===
{
  const res = await Dialogs.requestCertError({
    request_id: "c-1", astra_tab_id: "tab-1", url: "https://expired.example/", code: "SEC_ERROR_EXPIRED_CERTIFICATE", ...CHROME,
  });
  checkEnv("cert.request", res, "c-1");
  const id = res.dialog.dialog_id;
  check("emitted cert.error", byType("cert.error").some((e) => e.data.code === "SEC_ERROR_EXPIRED_CERTIFICATE"));
  checkEventValid("cert.error", byType("cert.error").at(-1));
  const cancel = await Dialogs.decideCert({ request_id: "c-2", dialog_id: id, decision: "cancel", ...CHROME });
  checkEnv("cert.cancel", cancel, "c-2");
  checkEventValid("cert.resolved", byType("cert.resolved").at(-1));
  void cancel;
}

// === Find bar + print preview ===
{
  const f = await Dialogs.openFind({ request_id: "f-1", astra_tab_id: "tab-1", query: "hello", ...CHROME });
  checkEnv("find.open", f, "f-1");
  checkEventValid("find.opened", byType("find.opened").at(-1));
  const fc = await Dialogs.closeFind({ request_id: "f-2", dialog_id: f.dialog.dialog_id, ...CHROME });
  check("find closed", fc.closed === true);
  checkEventValid("find.closed", byType("find.closed").at(-1));

  const pv = await Dialogs.openPrintPreview({ request_id: "r-1", astra_tab_id: "tab-1", url: "https://a.example/", ...CHROME });
  checkEnv("print.preview", pv, "r-1");
  checkEventValid("print.preview-opened", byType("print.preview-opened").at(-1));
  const pr = await Dialogs.resolvePrint({ request_id: "r-2", dialog_id: pv.dialog.dialog_id, decision: "print", ...CHROME });
  check("print confirmed", pr.decision === "print");
  checkEventValid("print.resolved", byType("print.resolved").at(-1));
}

// === Context menus ===
{
  const res = await Dialogs.requestContextMenu({
    request_id: "m-1", astra_tab_id: "tab-1", x: 120, y: 300,
    link_url: "https://a.example/page", selection: "some text", ...CHROME,
  });
  checkEnv("contextmenu.request", res, "m-1");
  checkEventValid("contextmenu.requested", byType("contextmenu.requested").at(-1));
  const badPt = await Dialogs.requestContextMenu({ request_id: "m-1b", astra_tab_id: "tab-1", x: NaN, y: 0, ...CHROME });
  check("non-finite point rejected", badPt.error?.code === "invalid_point");
  const act = await Dialogs.resolveContextMenu({
    request_id: "m-2", dialog_id: res.dialog.dialog_id, action: "copy-link", ...CHROME,
  });
  check("action kept", act.action === "copy-link");
  checkEventValid("contextmenu.resolved", byType("contextmenu.resolved").at(-1));
  const empty = await Dialogs.resolveContextMenu({ request_id: "m-3", dialog_id: res.dialog.dialog_id, action: "", ...CHROME });
  check("empty action rejected even when resolved", ["invalid_action", "already_resolved"].includes(empty.error?.code));
}

// === Introspection ===
{
  const list = await Dialogs.list({ request_id: "l-1" });
  checkEnv("dialogs.list", list, "l-1");
  check("list carries resolved dialogs", list.dialogs.length > 0 && list.dialogs.every((d) => d.status === "resolved"));
  const pending = await Dialogs.list({ request_id: "l-2", status: "pending" });
  check("pending filter empty after all resolved", pending.dialogs.length === 0);
  const missing = await Dialogs.get({ request_id: "l-3", dialog_id: "dlg-nope" });
  check("get unknown rejected", missing.error?.code === "no_such_dialog");
}

off();

console.log(`dialogs events contract: ${failed ? "FAIL" : `PASS (${passed} checks)`}`);
if (failed) {
  process.exitCode = 1;
}
