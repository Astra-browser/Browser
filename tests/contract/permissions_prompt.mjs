#!/usr/bin/env node
// P6b contract test: the Astra page-permission prompt state machine.
//
// Imports the chrome host module by file path (pure logic, no Firefox
// internals at import time) and asserts the contract in
// overlay/astra/host/schemas/permissions.json:
//   - every ask publishes one exact prompt with a 32-hex revision
//   - the prompt token, profile and item are the stale fence
//   - a decision is single-shot and resolves the engine exactly once
//   - an ephemeral context cannot receive durable policy
//   - a failed durable write cancels instead of granting
//   - the queue shows one prompt at a time
//   - pagehide closes a prompt that outlived its page
//
// Usage: node tests/contract/permissions_prompt.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Permissions } = await import(path.join(HOST, "Permissions.sys.mjs"));
const { Operations, __resetOperationsForTests } = await import(
  path.join(HOST, "Operations.sys.mjs")
);
const Events = await import(path.join(HOST, "Events.sys.mjs"));

const schema = JSON.parse(
  await readFile(path.join(HOST, "schemas", "permissions.json"), "utf8"),
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

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX16 = /^[0-9a-f]{16}$/u;

/** Strict check of the published payload against permissions.json. */
function validView(view) {
  const top = schema.required.every((key) => key in view);
  if (!top) return false;
  for (const key of Object.keys(view)) {
    if (!(key in schema.properties)) return false;
  }
  if (!HEX32.test(view.projection_revision)) return false;
  if (view.prompt === null) return true;
  const def = schema.properties.prompt;
  if (def.required.some((key) => !(key in view.prompt))) return false;
  if (Object.keys(view.prompt).some((key) => !(key in def.properties))) return false;
  const kinds = def.properties.kinds;
  if (!Array.isArray(view.prompt.kinds) || view.prompt.kinds.length === 0) return false;
  if (view.prompt.kinds.some((kind) => !kinds.items.enum.includes(kind))) return false;
  for (const key of ["profile_id", "item_id", "request_id", "origin"]) {
    if (typeof view.prompt[key] !== "string" || view.prompt[key] === "") return false;
  }
  for (const key of ["rememberable", "processing", "in_sidebar", "blocked_by_system"]) {
    if (typeof view.prompt[key] !== "boolean") return false;
  }
  return true;
}

function reset() {
  __resetOperationsForTests();
  Permissions.__resetForTests();
}

function harness({ persist = () => true, rememberable = true } = {}) {
  const calls = { allow: 0, cancel: 0, persist: [] };
  const token = Permissions.ask({
    kind: "geolocation",
    origin: "https://a.example",
    item_id: "tab-1",
    profile_id: "default",
    rememberable,
    allow: () => {
      calls.allow += 1;
    },
    cancel: () => {
      calls.cancel += 1;
    },
    persist: (allow, durable) => {
      calls.persist.push({ allow, durable });
      return persist(allow, durable);
    },
  });
  return { token, calls };
}

const disposition = async (admission) => (await Operations.status(admission)).disposition;

reset();
const seen = [];
const off = Events.addEventListener((event) => seen.push(event));
const lastView = () => seen.filter((e) => e.type === "page-permission-prompt-changed").at(-1)?.data;

// --- Publishing --------------------------------------------------------------
{
  const { token, calls } = harness();
  check("ask returns an opaque token", typeof token === "string" && token.length >= 16);
  const view = lastView();
  check("ask publishes a prompt", view?.prompt !== null);
  check("published view matches the schema", validView(view));
  check("revision is 32 lowercase hex", HEX32.test(view.projection_revision));
  check("prompt carries the Astra tab", view.prompt.item_id === "tab-1");
  check("prompt carries the profile", view.prompt.profile_id === "default");
  check("prompt echoes the origin", view.prompt.origin === "https://a.example");
  check("prompt lists one kind", view.prompt.kinds.length === 1 && view.prompt.kinds[0] === "geolocation");
  check("prompt is not processing", view.prompt.processing === false);
  check("prompt is not blocked by the system", view.prompt.blocked_by_system === false);
  check("prompt is shown as a sheet by default", view.prompt.in_sidebar === false);
  check("request_id is the prompt token", view.prompt.request_id === token);
  check("pending shows one request", Permissions.pending().length === 1);
  check("ask did not resolve the engine", calls.allow === 0 && calls.cancel === 0);
}

// --- Stale fences ------------------------------------------------------------
{
  reset();
  const { token } = harness();
  const wrongToken = await Permissions.respond({
    prompt_id: "unrelated",
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("unknown token is refused", wrongToken.accepted === true && HEX16.test(wrongToken.operation_id));
  check(
    "unknown token is classified invalid_scope",
    (await disposition(wrongToken)).reason === "invalid_scope",
  );
  const wrongProfile = await Permissions.respond({
    prompt_id: token,
    profile_id: "incognito",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("wrong profile is refused", (await disposition(wrongProfile)).reason === "invalid_scope");
  const wrongItem = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-2",
    decision: "allow_once",
  });
  check("wrong item is refused", (await disposition(wrongItem)).reason === "invalid_scope");
  check("a refused response leaves the prompt on screen", Permissions.pending().length === 1);
  const before = lastView().projection_revision;
  const ok = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("the exact fence still answers", (await disposition(ok)).outcome === "applied");
  check(
    "closing publishes a newer revision",
    lastView().projection_revision > before && lastView().prompt === null,
  );
}

// --- Decisions ---------------------------------------------------------------
{
  reset();
  const { token, calls } = harness();
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("allow_once admits with a 16-hex id", HEX16.test(admission.operation_id));
  check("allow_once reports applied", (await disposition(admission)).outcome === "applied");
  check("allow_once resolves the engine allow", calls.allow === 1 && calls.cancel === 0);
  check("allow_once stores a temporary policy", calls.persist.length === 1 && calls.persist[0].durable === false);
  const replay = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("a replay cannot resolve twice", (await disposition(replay)).reason === "invalid_scope");
  check("replay never reached the engine", calls.allow === 1 && calls.cancel === 0);
}

{
  reset();
  const { token, calls } = harness();
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_allow",
  });
  check("always_allow stores a persistent allow", calls.persist[0].allow === true && calls.persist[0].durable === true);
  check("always_allow resolves the request", calls.allow === 1);
  check("always_allow reports applied", (await disposition(admission)).outcome === "applied");
}

{
  reset();
  const { token, calls } = harness();
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_deny",
  });
  check("always_deny stores a persistent block", calls.persist[0].allow === false && calls.persist[0].durable === true);
  check("always_deny cancels the request", calls.cancel === 1 && calls.allow === 0);
  check("always_deny reports applied", (await disposition(admission)).outcome === "applied");
}

{
  reset();
  const { token, calls } = harness();
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "deny_once",
  });
  check("deny_once cancels only", calls.cancel === 1 && calls.allow === 0);
  check("deny_once stores nothing durable", calls.persist[0].durable === false);
  check("deny_once reports applied", (await disposition(admission)).outcome === "applied");
}

{
  reset();
  const { token, calls } = harness();
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "dismiss",
  });
  check("dismiss cancels the request", calls.cancel === 1 && calls.allow === 0);
  check("dismiss reports no_op", (await disposition(admission)).outcome === "no_op");
}

// --- Ephemeral and failed stores ---------------------------------------------
{
  reset();
  const { token, calls } = harness({ rememberable: false });
  check("ephemeral prompt is not rememberable", lastView().prompt.rememberable === false);
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_allow",
  });
  check("durable policy on an ephemeral prompt is refused", (await disposition(admission)).reason === "invalid_scope");
  check("a refused durable policy resolves nothing", calls.allow === 0 && calls.cancel === 0);
  check("the ephemeral prompt stays up", Permissions.pending().length === 1);
}

{
  reset();
  const { token, calls } = harness({ persist: () => false });
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_allow",
  });
  check("a failed durable write is rejected", (await disposition(admission)).reason === "store_admission_rejected");
  check("a failed durable write never allows", calls.allow === 0 && calls.cancel === 1);
}

// --- Queue and card host -----------------------------------------------------
{
  reset();
  const first = harness();
  const second = harness();
  check("ask queues behind the visible prompt", Permissions.pending().length === 2);
  const head = lastView().prompt;
  check("only the oldest prompt is visible", head?.request_id === first.token);
  const firstRev = lastView().projection_revision;
  await Permissions.respond({
    prompt_id: first.token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "deny_once",
  });
  check("the next prompt takes over", lastView().prompt?.request_id === second.token);
  check("taking over advances the revision", lastView().projection_revision > firstRev);
  await Permissions.respond({
    prompt_id: second.token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "deny_once",
  });
  check("an empty queue publishes null", lastView().prompt === null);
}

{
  reset();
  harness();
  const before = lastView().projection_revision;
  await Permissions.cardHost({ available: true });
  check("a sidebar host moves the prompt to a card", lastView().prompt.in_sidebar === true);
  check("moving hosts advances the revision", lastView().projection_revision > before);
  await Permissions.cardHost({ available: false });
  check("hiding the sidebar host returns to the sheet", lastView().prompt.in_sidebar === false);
}

// --- Page lifecycle ----------------------------------------------------------
{
  reset();
  const listeners = new Map();
  const browser = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
  };
  let cancelled = 0;
  Permissions.ask({
    kind: "geolocation",
    origin: "https://a.example",
    item_id: "tab-1",
    profile_id: "default",
    rememberable: true,
    browser,
    cancel: () => {
      cancelled += 1;
    },
  });
  check("a prompt watches its page", listeners.has("pagehide"));
  listeners.get("pagehide")();
  check("pagehide closes the prompt", lastView().prompt === null);
  check("pagehide cancels the engine request", cancelled === 1);
  check("pagehide releases the listener", listeners.size === 0);
}

// --- Invalid descriptors -----------------------------------------------------
{
  reset();
  const published = seen.length;
  check(
    "an unknown kind is refused",
    Permissions.ask({ kind: "telepathy", origin: "https://a.example", item_id: "tab-1" }) === null,
  );
  check(
    "an empty origin is refused",
    Permissions.ask({ kind: "geolocation", origin: "", item_id: "tab-1" }) === null,
  );
  check(
    "an empty item is refused",
    Permissions.ask({ kind: "geolocation", origin: "https://a.example", item_id: "" }) === null,
  );
  check("no prompt was published", seen.length === published && Permissions.pending().length === 0);
}

off();

// --- Ledger classification ---------------------------------------------------
{
  const bad = await Permissions.respond({
    prompt_id: "none",
    profile_id: "default",
    item_id: "tab-1",
    decision: "maybe",
  });
  check("an invalid decision is refused", bad.accepted === true);
  check(
    "an invalid decision is classified invalid_scope first",
    ["invalid_scope"].includes((await disposition(bad)).reason),
  );
}

console.log(
  `\npermissions prompt contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
