#!/usr/bin/env node
// P3-T09 contract test: spoof-resistance of dialog resolution.
//
// The trust boundary (docs/astra/DIALOGS.md SECURITY): only
// chrome-privileged code may resolve dialogs. Content-originated resolves
// must be rejected with `untrusted_actor` and leave the pending dialog
// untouched; the content actor's only entry is `reportFromContent`, which
// records an unverified `dialog.content-report` (tagged `untrusted: true`)
// and never creates or resolves a dialog.
//
// Usage: node tests/contract/dialogs_security.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Dialogs, __resetDialogsForTests } = await import(path.join(HOST, "Dialogs.sys.mjs"));
const EventsMod = await import(path.join(HOST, "Events.sys.mjs"));
const { addEventListener } = EventsMod;

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

__resetDialogsForTests();
EventsMod.__resetEventsForTests();
const seen = [];
const off = addEventListener((e) => seen.push(e));
const byType = (t) => seen.filter((e) => e.type === t);
const CHROME = { actor: "chrome" };
const CONTENT = { actor: "content" };

// Open one pending dialog of every resolvable kind, via chrome.
const perm = await Dialogs.requestPermission({
  request_id: "s-0a", astra_tab_id: "tab-1", url: "https://a.example/", permission: "geolocation", ...CHROME,
});
const dl = await Dialogs.requestDownload({
  request_id: "s-0b", astra_tab_id: "tab-1", url: "https://a.example/f", filename: "f", ...CHROME,
});
const auth = await Dialogs.requestAuth({ request_id: "s-0c", astra_tab_id: "tab-1", host: "h.example", ...CHROME });
const cert = await Dialogs.requestCertError({
  request_id: "s-0d", astra_tab_id: "tab-1", url: "https://bad.example/", code: "SEC_ERROR_UNKNOWN_ISSUER", ...CHROME,
});
const find = await Dialogs.openFind({ request_id: "s-0e", astra_tab_id: "tab-1", ...CHROME });
const print = await Dialogs.openPrintPreview({ request_id: "s-0f", astra_tab_id: "tab-1", ...CHROME });
const menu = await Dialogs.requestContextMenu({ request_id: "s-0g", astra_tab_id: "tab-1", x: 1, y: 2, ...CHROME });
check("setup opened 7 pending dialogs", [perm, dl, auth, cert, find, print, menu].every((r) => r.dialog?.status === "pending"));

// --- Content-originated resolves are rejected on every path ---
{
  const attempts = [
    ["permission", Dialogs.decidePermission({ request_id: "s-1", dialog_id: perm.dialog.dialog_id, decision: "grant", ...CONTENT })],
    ["download", Dialogs.decideDownload({ request_id: "s-2", dialog_id: dl.dialog.dialog_id, decision: "allow", ...CONTENT })],
    ["auth", Dialogs.respondAuth({ request_id: "s-3", dialog_id: auth.dialog.dialog_id, username: "evil", password: "x", ...CONTENT })],
    ["cert", Dialogs.decideCert({ request_id: "s-4", dialog_id: cert.dialog.dialog_id, decision: "proceed-once", ...CONTENT })],
    ["find", Dialogs.closeFind({ request_id: "s-5", dialog_id: find.dialog.dialog_id, ...CONTENT })],
    ["print", Dialogs.resolvePrint({ request_id: "s-6", dialog_id: print.dialog.dialog_id, decision: "print", ...CONTENT })],
    ["contextmenu", Dialogs.resolveContextMenu({ request_id: "s-7", dialog_id: menu.dialog.dialog_id, action: "evil", ...CONTENT })],
  ];
  for (const [kind, promise] of attempts) {
    const res = await promise;
    check(`content ${kind} resolve rejected untrusted_actor`, res.error?.code === "untrusted_actor");
  }
  // Missing actor is equally untrusted (no implicit chrome default).
  const noActor = await Dialogs.decideCert({ request_id: "s-8", dialog_id: cert.dialog.dialog_id, decision: "cancel" });
  check("missing actor rejected untrusted_actor", noActor.error?.code === "untrusted_actor");

  // None of the spoof attempts resolved anything or emitted resolve events.
  const stillPending = await Dialogs.list({ request_id: "s-9", status: "pending" });
  check("all 7 dialogs still pending", stillPending.dialogs.length === 7);
  for (const t of ["permission.resolved", "download.resolved", "auth.resolved", "cert.resolved",
    "find.closed", "print.resolved", "contextmenu.resolved"]) {
    check(`no ${t} emitted by spoof`, byType(t).length === 0);
  }
}

// --- Content cannot open dialogs directly either ---
{
  const fake = await Dialogs.requestPermission({
    request_id: "s-10", astra_tab_id: "tab-1", url: "https://evil.example/", permission: "camera", ...CONTENT,
  });
  check("content cannot request permission dialog", fake.error?.code === "untrusted_actor");
  const fakeCert = await Dialogs.requestCertError({
    request_id: "s-11", astra_tab_id: "tab-1", url: "https://evil.example/", code: "X", ...CONTENT,
  });
  check("content cannot request cert dialog", fakeCert.error?.code === "untrusted_actor");
}

// --- reportFromContent: recorded, flagged, and inert ---
{
  const before = (await Dialogs.list({ request_id: "s-12" })).dialogs.length;
  const rep = await Dialogs.reportFromContent({
    request_id: "s-13", kind: "cert-dismissed", astra_tab_id: "tab-1", facts: { url: "https://bad.example/" },
  });
  check("content report accepted", rep.recorded === true && rep.untrusted === true);
  const ev = byType("dialog.content-report").at(-1);
  check("report event tagged untrusted", ev?.data.untrusted === true && ev?.data.kind === "cert-dismissed");
  const after = (await Dialogs.list({ request_id: "s-14" })).dialogs.length;
  check("report created no dialog", after === before);
  const certStill = await Dialogs.get({ request_id: "s-15", dialog_id: cert.dialog.dialog_id });
  check("report resolved nothing", certStill.dialog?.status === "pending");
  const badKind = await Dialogs.reportFromContent({ request_id: "s-16", kind: "", astra_tab_id: "tab-1" });
  check("empty report kind rejected", badKind.error?.code === "invalid_kind");
}

// --- Chrome resolves still work after the attack ---
{
  const grant = await Dialogs.decidePermission({
    request_id: "s-20", dialog_id: perm.dialog.dialog_id, decision: "deny", ...CHROME,
  });
  check("chrome deny after spoof works", grant.decision === "deny" && !grant.error);
  const stop = await Dialogs.decideCert({
    request_id: "s-21", dialog_id: cert.dialog.dialog_id, decision: "cancel", ...CHROME,
  });
  check("chrome cert cancel after spoof works", stop.decision === "cancel" && !stop.error);
  // A spoofed-then-cancelled dialog cannot be revived by content either.
  const revive = await Dialogs.decideCert({
    request_id: "s-22", dialog_id: cert.dialog.dialog_id, decision: "proceed-once", ...CONTENT,
  });
  check("content cannot revive resolved dialog", revive.error?.code === "untrusted_actor");
}

off();

console.log(`dialogs security contract: ${failed ? "FAIL" : `PASS (${passed} checks)`}`);
if (failed) {
  process.exitCode = 1;
}
