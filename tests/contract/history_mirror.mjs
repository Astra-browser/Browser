#!/usr/bin/env node
// P2-T07 contract test: History mirror into Places (U-06), stub level.
//
// Imports overlay/astra/host/History.sys.mjs by path (zero static imports,
// no engine internals) and asserts the protocol in
// overlay/astra/host/schemas/history.json plus the visited/unvisited styling
// behavior on a local fixture page, modelled at stub level: the mirror's
// visited-set drives a :visited/:link style resolver with the engine UA
// colors (visited purple vs unvisited blue). The live-browser half
// (tests/contract/history_mirror.py) proves the same behavior against the
// real Places store.
//
// Usage: node tests/contract/history_mirror.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const mod = await import(pathToFileURL(path.join(HOST, "History.sys.mjs")).href);
const { History, __setHistoryEventSink, __resetHistoryForTests } = mod;

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

__resetHistoryForTests();
const events = [];
__setHistoryEventSink((type, data) => events.push({ type, data }));

const VISITED_URL = "http://127.0.0.1:9/fixture/visited.html";
const CONTROL_URL = "http://127.0.0.1:9/fixture/control.html";

// --- visit: echo + envelope ---
{
  const res = await History.visit({
    request_id: "h-1",
    url: VISITED_URL,
    title: "Visited Fixture",
    visit_time: 1762060000000,
  });
  check("visit echoes request_id", res.request_id === "h-1");
  check("visit carries host_api_version", res.host_api_version === 1);
  check("visit reports mirrored:true", res.mirrored === true);
  check("visit normalizes url", res.url === new URL(VISITED_URL).href);
  check("visit echoes visit_time ms", res.visit_time === 1762060000000);
  check("visit emits history.visited", events.some(
    (e) => e.type === "history.visited" && e.data.url === new URL(VISITED_URL).href,
  ));
}

// --- isVisited reflects the mirror ---
{
  const v = await History.isVisited({ request_id: "h-2", url: VISITED_URL });
  check("isVisited echoes request_id", v.request_id === "h-2");
  check("visited URL reads visited", v.visited === true);
  const c = await History.isVisited({ request_id: "h-3", url: CONTROL_URL });
  check("unvisited URL reads unvisited", c.visited === false);
}

// --- default visit_time means now ---
{
  const before = Date.now();
  const res = await History.visit({ request_id: "h-4", url: "http://127.0.0.1:9/now.html" });
  check("omitted visit_time defaults to now",
    res.mirrored === true && res.visit_time >= before && res.visit_time <= Date.now());
}

// --- errors + mirror policy M-1 ---
{
  const e1 = await History.visit({ request_id: "h-5", url: "" });
  check("empty url is invalid_url", !!e1.error && e1.error.code === "invalid_url");
  const e2 = await History.visit({ request_id: "h-6", url: "about:blank" });
  check("about:blank skipped not failed",
    e2.mirrored === false && !e2.error && typeof e2.reason === "string");
  const e3 = await History.isVisited({ request_id: "h-7", url: "about:blank" });
  check("about:blank reads unvisited", e3.visited === false && !e3.error);
  const v = await History.isVisited({ request_id: "h-8", url: "" });
  check("empty url isVisited is invalid_url", !!v.error && v.error.code === "invalid_url");
}

// --- title update on revisit ---
{
  await History.visit({ request_id: "h-9", url: VISITED_URL, title: "New Title" });
  check("revisit keeps visited state",
    (await History.isVisited({ url: VISITED_URL })).visited === true);
}

// --- fixture page: :visited styling behavior at stub level ---
// The engine UA sheet renders :link blue and :visited purple; the ONLY
// input to that selector is mirror state. This resolver models it.
const UA_LINK = "rgb(0, 0, 238)";
const UA_VISITED = "rgb(128, 0, 128)";
async function linkColor(url) {
  const r = await History.isVisited({ url });
  return r.visited ? UA_VISITED : UA_LINK;
}
{
  const visitedColor = await linkColor(VISITED_URL);
  const controlColor = await linkColor(CONTROL_URL);
  check("visited link gets :visited color", visitedColor === UA_VISITED);
  check("unvisited link keeps :link color", controlColor === UA_LINK);
}

// --- clear mirrors a core wipe ---
{
  const res = await History.clear({ request_id: "h-10" });
  check("clear echoes request_id", res.request_id === "h-10");
  check("clear reports cleared:true", res.cleared === true);
  check("clear emits history.cleared", events.some((e) => e.type === "history.cleared"));
  const v = await History.isVisited({ request_id: "h-11", url: VISITED_URL });
  check("visited URL reads unvisited after clear", v.visited === false);
  check("visited link loses :visited color after clear",
    (await linkColor(VISITED_URL)) === UA_LINK);
}

// --- schema validates ---
{
  const schema = JSON.parse(
    (await import("node:fs")).readFileSync(
      path.join(HOST, "schemas", "history.json"), "utf8",
    ),
  );
  check("schema defines visit", !!schema.properties.visit);
  check("schema defines clear", !!schema.properties.clear);
  check("schema defines isVisited", !!schema.properties.isVisited);
  check("visit requires url", schema.properties.visit.required.includes("url"));
  assert(schema.$id === "resource://astra/host/schemas/history.json");
  console.log("PASS schema $id is the resource URL");
  passed += 1;
}

console.log(`\nhistory_mirror: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
