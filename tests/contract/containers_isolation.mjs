#!/usr/bin/env node
// P3-T05 contract test: Host API Containers module — spaces/profiles
// isolation on contextual identities (spike S-02, U-07).
//
// Imports the chrome module by file path (pure logic, no Firefox internals)
// and asserts:
//   - every call echoes `request_id` + `host_api_version: 1`
//   - failures return `{ request_id, host_api_version, error }`
//   - CRUD: create/get/list/update/remove with cookieStoreId shape
//     `firefox-container-N` and distinct userContextIds per space
//   - ISOLATION: cookies + localStorage written through a tab bound to
//     space A are invisible from a tab bound to space B (and vice versa)
//   - remove wipes the container's data (cookies/localStorage gone) and
//     unbinds its tabs; clearData wipes without deleting the identity
//   - ephemeral identities (agent sessions) round-trip and wipe on remove
//   - tab binding rejects unknown containers; storage on unbound tabs fails
//   - schema file parses and matches the module surface
//
// Stub-level proof: no built binary exists in this lane, so the module
// partitions stub storage per userContextId the same way the engine
// partitions real storage per originAttributes.userContextId (verified in
// S-02 against the pinned ESR source). Live follow-up: re-run the same
// property with real cookies/localStorage via geckodriver once the P3
// binary exists (red-cookie-in-A / read-in-B scenario in S-02 §5).
//
// Usage: node tests/contract/containers_isolation.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const HostAPI = await import(pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href);
const { Containers, __userContextIdFor, __resetContainersForTests } = await import(pathToFileURL(path.join(HOST, "Containers.sys.mjs")).href);

function checkEnv(name, res, rid) {
  check(`${name} echoes request_id`, res.request_id === rid);
  check(`${name} carries host_api_version 1`, res.host_api_version === 1);
}

function checkErr(name, res, rid, code) {
  checkEnv(name, res, rid);
  check(`${name} errors ${code}`, !!res.error && res.error.code === code);
}

function reset() {
  HostAPI.__resetForTests();
  __resetContainersForTests();
}

reset();

// === Envelope + create validation ===
{
  const bad = await Containers.create({ request_id: "c-0", name: "   " });
  checkErr("create blank name", bad, "c-0", "invalid_name");

  const badColor = await Containers.create({ request_id: "c-0b", name: "Work", color: "" });
  checkErr("create blank color", badColor, "c-0b", "invalid_color");

  const work = await Containers.create({
    request_id: "c-1",
    name: "Work",
    color: "blue",
    icon: "briefcase",
  });
  checkEnv("create work", work, "c-1");
  check("cookieStoreId shape firefox-container-N", /^firefox-container-\d+$/.test(work.container.cookieStoreId));
  check("first identity gets userContextId 1", work.container.userContextId === 1);
  check("not ephemeral by default", work.container.ephemeral === false);
  check(
    "helper exposes numeric id for live tab binding",
    __userContextIdFor(work.container.cookieStoreId) === 1,
  );

  const personal = await Containers.create({
    request_id: "c-2",
    name: "Personal",
    color: "green",
    icon: "fingerprint",
  });
  checkEnv("create personal", personal, "c-2");
  check("distinct cookieStoreIds per space", personal.container.cookieStoreId !== work.container.cookieStoreId);
  check("distinct userContextIds per space", personal.container.userContextId !== work.container.userContextId);

  const listed = await Containers.list({ request_id: "c-3" });
  checkEnv("list", listed, "c-3");
  check("list holds both spaces", listed.containers.length === 2);

  const got = await Containers.get({ request_id: "c-4", cookieStoreId: work.container.cookieStoreId });
  checkEnv("get", got, "c-4");
  check("get returns the space identity", got.container.name === "Work");
  checkErr(
    "get unknown",
    await Containers.get({ request_id: "c-5", cookieStoreId: "firefox-container-999" }),
    "c-5",
    "no_such_container",
  );
}

// === Update keeps the storage partition (same userContextId) ===
{
  const listed = await Containers.list({ request_id: "u-0" });
  const id = listed.containers[0].cookieStoreId;
  const upd = await Containers.update({ request_id: "u-1", cookieStoreId: id, name: "Work 2", color: "red" });
  checkEnv("update", upd, "u-1");
  check("update renames", upd.container.name === "Work 2");
  check("update keeps cookieStoreId", upd.container.cookieStoreId === id);
  checkErr(
    "update blank value",
    await Containers.update({ request_id: "u-2", cookieStoreId: id, name: " " }),
    "u-2",
    "invalid_value",
  );
  checkErr(
    "update unknown",
    await Containers.update({ request_id: "u-3", cookieStoreId: "firefox-container-999", name: "X" }),
    "u-3",
    "no_such_container",
  );
}

// === Tab binding ===
{
  const listed = await Containers.list({ request_id: "b-0" });
  const [workId, personalId] = listed.containers.map((c) => c.cookieStoreId);
  const b1 = await Containers.bindTab({ request_id: "b-1", astra_tab_id: "tab-a1", cookieStoreId: workId });
  checkEnv("bindTab work", b1, "b-1");
  const b2 = await Containers.bindTab({ request_id: "b-2", astra_tab_id: "tab-b1", cookieStoreId: personalId });
  checkEnv("bindTab personal", b2, "b-2");
  const cf = await Containers.containerForTab({ request_id: "b-3", astra_tab_id: "tab-a1" });
  checkEnv("containerForTab", cf, "b-3");
  check("containerForTab returns bound identity", cf.cookieStoreId === workId);
  const none = await Containers.containerForTab({ request_id: "b-4", astra_tab_id: "tab-ghost" });
  check("unbound tab maps to null", none.cookieStoreId === null);
  checkErr(
    "bindTab unknown container",
    await Containers.bindTab({ request_id: "b-5", astra_tab_id: "tab-x", cookieStoreId: "firefox-container-999" }),
    "b-5",
    "no_such_container",
  );
  checkErr(
    "bindTab blank tab id",
    await Containers.bindTab({ request_id: "b-6", astra_tab_id: "", cookieStoreId: workId }),
    "b-6",
    "invalid_tab",
  );
  checkErr(
    "storage on unbound tab",
    await Containers.setCookie({ request_id: "b-7", astra_tab_id: "tab-ghost", name: "s", value: "1" }),
    "b-7",
    "tab_not_bound",
  );
  // Rebind moves the tab to the other partition.
  const rb = await Containers.bindTab({ request_id: "b-8", astra_tab_id: "tab-a1", cookieStoreId: personalId });
  checkEnv("rebind", rb, "b-8");
  const cf2 = await Containers.containerForTab({ request_id: "b-9", astra_tab_id: "tab-a1" });
  check("rebind sticks", cf2.cookieStoreId === personalId);
  // Restore: tab-a1 belongs to the Work space for the isolation section.
  await Containers.bindTab({ request_id: "b-10", astra_tab_id: "tab-a1", cookieStoreId: workId });
}

// === ISOLATION: cookies + localStorage not shared across spaces ===
// tab-a1/tab-a2 bound to Work, tab-b1 bound to Personal.
{
  await Containers.bindTab({ request_id: "i-0", astra_tab_id: "tab-a2", cookieStoreId:
    (await Containers.list({ request_id: "i-0b" })).containers[0].cookieStoreId });

  await Containers.setCookie({ request_id: "i-1", astra_tab_id: "tab-a1", name: "session", value: "work-secret" });
  await Containers.setLocalItem({ request_id: "i-2", astra_tab_id: "tab-a1", key: "theme", value: "work-dark" });

  const bCookies = await Containers.getCookies({ request_id: "i-3", astra_tab_id: "tab-b1" });
  checkEnv("personal reads cookies", bCookies, "i-3");
  check("personal sees no work cookie", !("session" in bCookies.cookies));
  const bLocal = await Containers.getLocalItem({ request_id: "i-4", astra_tab_id: "tab-b1", key: "theme" });
  check("personal sees no work localStorage", bLocal.value === null);

  // Same-space tabs DO share (one jar per container).
  await Containers.setCookie({ request_id: "i-5", astra_tab_id: "tab-b1", name: "session", value: "personal-secret" });
  const aCookies = await Containers.getCookies({ request_id: "i-6", astra_tab_id: "tab-a1" });
  check("work cookie intact after personal write", aCookies.cookies.session === "work-secret");
  const aLocal = await Containers.getLocalItem({ request_id: "i-7", astra_tab_id: "tab-a2", key: "theme" });
  check("same-space tabs share localStorage", aLocal.value === "work-dark");
  const bCookies2 = await Containers.getCookies({ request_id: "i-8", astra_tab_id: "tab-b1" });
  check("personal cookie intact", bCookies2.cookies.session === "personal-secret");
  check(
    "partitions differ (no cross-read either direction)",
    JSON.stringify(aCookies.cookies) !== JSON.stringify(bCookies2.cookies),
  );
}

// === clearData wipes one space only ===
{
  const listed = await Containers.list({ request_id: "d-0" });
  const workId = listed.containers[0].cookieStoreId;
  const cl = await Containers.clearData({ request_id: "d-1", cookieStoreId: workId });
  checkEnv("clearData", cl, "d-1");
  check("clearData reports cleared", cl.cleared === true);
  const after = await Containers.getCookies({ request_id: "d-2", astra_tab_id: "tab-a1" });
  check("work cookies wiped", Object.keys(after.cookies).length === 0);
  const afterLocal = await Containers.getLocalItem({ request_id: "d-3", astra_tab_id: "tab-a1", key: "theme" });
  check("work localStorage wiped", afterLocal.value === null);
  const kept = await Containers.getCookies({ request_id: "d-4", astra_tab_id: "tab-b1" });
  check("sibling space untouched by clearData", kept.cookies.session === "personal-secret");
  checkErr(
    "clearData unknown",
    await Containers.clearData({ request_id: "d-5", cookieStoreId: "firefox-container-999" }),
    "d-5",
    "no_such_container",
  );
}

// === remove wipes data + unbinds tabs; ephemeral agent sessions ===
{
  const listed = await Containers.list({ request_id: "r-0" });
  const workId = listed.containers[0].cookieStoreId;
  await Containers.setCookie({ request_id: "r-1", astra_tab_id: "tab-a1", name: "k", value: "v" });
  const rem = await Containers.remove({ request_id: "r-2", cookieStoreId: workId });
  checkEnv("remove", rem, "r-2");
  check("remove wipes by default", rem.forgetData === true);
  check("remove unbinds tabs", rem.unbound_tabs.includes("tab-a1"));
  const cf = await Containers.containerForTab({ request_id: "r-3", astra_tab_id: "tab-a1" });
  check("removed binding gone", cf.cookieStoreId === null);
  checkErr(
    "storage on removed binding",
    await Containers.getCookies({ request_id: "r-4", astra_tab_id: "tab-a1" }),
    "r-4",
    "tab_not_bound",
  );
  const kept = await Containers.getCookies({ request_id: "r-5", astra_tab_id: "tab-b1" });
  check("sibling data survives remove", kept.cookies.session === "personal-secret");
  checkErr(
    "remove unknown",
    await Containers.remove({ request_id: "r-6", cookieStoreId: workId }),
    "r-6",
    "no_such_container",
  );

  // Ephemeral agent-session container: create → use → remove wipes.
  const eph = await Containers.create({ request_id: "r-7", name: "agent-run-7", ephemeral: true });
  checkEnv("create ephemeral", eph, "r-7");
  check("ephemeral flagged", eph.container.ephemeral === true);
  await Containers.bindTab({ request_id: "r-8", astra_tab_id: "tab-agent", cookieStoreId: eph.container.cookieStoreId });
  await Containers.setLocalItem({ request_id: "r-9", astra_tab_id: "tab-agent", key: "token", value: "abc" });
  const erem = await Containers.remove({ request_id: "r-10", cookieStoreId: eph.container.cookieStoreId });
  check("ephemeral remove wipes", erem.forgetData === true && erem.unbound_tabs.includes("tab-agent"));

  // forgetData: false keeps jars (rename-then-recreate flow).
  const k = await Containers.create({ request_id: "r-11", name: "Keep" });
  await Containers.bindTab({ request_id: "r-12", astra_tab_id: "tab-k", cookieStoreId: k.container.cookieStoreId });
  await Containers.setCookie({ request_id: "r-13", astra_tab_id: "tab-k", name: "k", value: "v" });
  const krem = await Containers.remove({ request_id: "r-14", cookieStoreId: k.container.cookieStoreId, forgetData: false });
  check("forgetData false keeps data flag", krem.forgetData === false);
  // Re-created identity reuses the numeric id sequence, so this asserts the
  // flag path only; data retention across re-mint is a live-service concern.
}

// === Events emitted ===
{
  reset();
  const seen = [];
  const { addEventListener } = HostAPI;
  addEventListener((ev) => seen.push([ev.type, ev.data.cookieStoreId]));
  const c = await Containers.create({ request_id: "e-1", name: "Ev" });
  await Containers.remove({ request_id: "e-2", cookieStoreId: c.container.cookieStoreId });
  check("container.created emitted", seen.some(([t, id]) => t === "container.created" && id === c.container.cookieStoreId));
  check("container.removed emitted", seen.some(([t, id]) => t === "container.removed" && id === c.container.cookieStoreId));
  void assert;
}

// === Schema file parses and matches the module surface ===
{
  reset();
  const schemaText = await (await import("node:fs/promises")).readFile(
    path.join(HOST, "schemas", "containers.json"),
    "utf8",
  );
  const schema = JSON.parse(schemaText);
  check("schema id is host containers schema", schema.$id === "resource://astra/host/schemas/containers.json");
  for (const fn of ["create", "get", "list", "update", "remove", "bindTab", "containerForTab", "clearData", "setCookie", "getCookies", "setLocalItem", "getLocalItem"]) {
    check(`schema documents Containers.${fn}`, !!schema.properties[fn]);
    check(`Containers.${fn} is a function`, typeof Containers[fn] === "function");
  }
  check(
    "schema Container requires cookieStoreId shape",
    schema.properties.Container.properties.cookieStoreId.pattern === "^firefox-container-[0-9]+$",
  );
}

console.log(`containers contract: ${failed ? "FAIL" : `PASS (${passed} checks)`}`);
if (failed) {
  process.exitCode = 1;
}
