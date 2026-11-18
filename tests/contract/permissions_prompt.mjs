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
//   - the queue shows one prompt at a time and never evicts the visible one
//   - navigation and tab close cancel a prompt that outlived its document
//   - dismiss decides nothing: no store write, no site block
//
// Usage: node tests/contract/permissions_prompt.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Permissions, KINDS, KIND_BY_ENGINE_TYPE, ENGINE_PERMISSION_NAME } = await import(pathToFileURL(path.join(HOST, "Permissions.sys.mjs")).href);
const { Operations, __resetOperationsForTests } = await import(pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

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
  check("dismiss writes no site policy", calls.persist.length === 0);
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
function fakeBrowser(spec = "https://a.example/") {
  const state = { spec, listeners: new Map(), removed: 0, closed: false };
  const tabContainer = {
    addEventListener(type, fn) {
      state.listeners.set(`tab:${type}`, fn);
    },
    removeEventListener(type, fn) {
      if (state.listeners.get(`tab:${type}`) === fn) state.listeners.delete(`tab:${type}`);
    },
  };
  const progress = {
    addProgressListener(fn) {
      state.listeners.set("progress", fn);
    },
    removeProgressListener() {
      state.removed += 1;
    },
  };
  const browser = {
    get currentURI() {
      return { spec: state.spec };
    },
    webProgress: progress,
    ownerGlobal: { gBrowser: { tabContainer } },
  };
  state.tab = { linkedBrowser: browser };
  return { browser, state, tabContainer };
}

{
  reset();
  const { browser, state, tabContainer } = fakeBrowser();
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
  check("a prompt watches its document", state.listeners.has("progress"));
  state.listeners.get("progress").onLocationChange();
  check("navigation closes the prompt", lastView().prompt === null);
  check("navigation cancels the engine request", cancelled === 1);
  check("navigation releases the progress listener", state.removed === 1);
  check("navigation releases the tab listener", !state.listeners.has("tab:TabClose"));
  tabContainer.addEventListener; // keep the fake referenced
}

{
  reset();
  const { browser, state } = fakeBrowser();
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
  state.listeners.get("tab:TabClose")({ target: state.tab });
  check("closing the tab closes the prompt", lastView().prompt === null);
  check("closing the tab cancels the engine request", cancelled === 1);
}

{
  // A late answer for a document that already changed is a stale fence.
  reset();
  const { browser, state } = fakeBrowser();
  let allowed = 0;
  let cancelled = 0;
  const token = Permissions.ask({
    kind: "geolocation",
    origin: "https://a.example",
    item_id: "tab-1",
    profile_id: "default",
    rememberable: true,
    browser,
    allow: () => {
      allowed += 1;
    },
    cancel: () => {
      cancelled += 1;
    },
  });
  state.spec = "https://b.example/";
  const stale = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("a late answer for a new document is refused", (await disposition(stale)).reason === "invalid_scope");
  check("a late answer never allows", allowed === 0);
  check("a late answer settles the engine request", cancelled === 1);
  check("a late answer closes the prompt", lastView().prompt === null);
}

// --- WebRTC (camera + microphone) -------------------------------------------
{
  reset();
  let allowCalls = 0;
  let cancelCalls = 0;
  const persisted = [];
  const token = Permissions.ask({
    kinds: ["camera", "microphone"],
    call_id: "call-1",
    origin: "https://a.example",
    item_id: "tab-1",
    profile_id: "default",
    rememberable: true,
    allow: () => { allowCalls += 1; },
    cancel: () => { cancelCalls += 1; },
    persist: (allow, durable) => { persisted.push({ allow, durable }); return true; },
  });
  check("a WebRTC prompt carries both kinds", lastView().prompt.kinds.join(",") === "camera,microphone");
  check("the schema accepts both kinds", validView(lastView()));
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "allow_once",
  });
  check("one decision resolves a two-kind request", (await disposition(admission)).outcome === "applied");
  check("allow runs once for the request", allowCalls === 1 && cancelCalls === 0);
  check("persist sees the one-shot decision", persisted.length === 1 && persisted[0].durable === false);

  const bad = Permissions.ask({
    kinds: ["camera", "telepathy"],
    origin: "https://a.example",
    item_id: "tab-1",
  });
  check("an unknown kind in a list is refused", bad === null);
}

{
  // A page that goes away cancels its pending WebRTC prompt.
  reset();
  let cancelled = 0;
  Permissions.ask({
    kinds: ["camera"],
    call_id: "call-2",
    origin: "https://a.example",
    item_id: "tab-1",
    cancel: () => { cancelled += 1; },
  });
  check("the WebRTC record is queued", Permissions.pending().length === 1);
  check("cancelWebRTC finds the call", Permissions.cancelWebRTC("call-2") === true);
  check("cancelWebRTC closes the prompt", lastView().prompt === null);
  check("cancelWebRTC cancels the engine request", cancelled === 1);
  check("an unknown call is a no-op", Permissions.cancelWebRTC("call-3") === false);
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

// --- Further refusals --------------------------------------------------------
{
  reset();
  const { token, calls } = harness();
  const bad = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "maybe",
  });
  check("an invalid decision is refused", (await disposition(bad)).reason === "invalid_input");
  check("an invalid decision resolves nothing", calls.allow === 0 && calls.cancel === 0);
  check("an invalid decision leaves the prompt up", Permissions.pending().length === 1);

  const missing = await Permissions.respond({
    prompt_id: "none",
    profile_id: "default",
    item_id: "tab-1",
    decision: "maybe",
  });
  check("a missing token outranks the decision check", (await disposition(missing)).reason === "invalid_scope");
}

{
  reset();
  const { token, calls } = harness({
    persist: () => {
      throw new Error("store down");
    },
  });
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_allow",
  });
  check("a throwing store is rejected", (await disposition(admission)).reason === "store_admission_rejected");
  check("a throwing store never allows", calls.allow === 0 && calls.cancel === 1);
}

{
  reset();
  let allowed = 0;
  let cancelled = 0;
  const token = Permissions.ask({
    kind: "geolocation",
    origin: "https://a.example",
    item_id: "tab-1",
    profile_id: "default",
    rememberable: true,
    allow: () => {
      allowed += 1;
    },
    cancel: () => {
      cancelled += 1;
    },
  });
  const admission = await Permissions.respond({
    prompt_id: token,
    profile_id: "default",
    item_id: "tab-1",
    decision: "always_allow",
  });
  check("a durable decision with no store is rejected", (await disposition(admission)).reason === "store_admission_rejected");
  check("a durable decision with no store cancels", allowed === 0 && cancelled === 1);
}

{
  reset();
  check(
    "ask does not grant durable policy by default",
    (() => {
      const t = Permissions.ask({ kind: "geolocation", origin: "https://a.example", item_id: "tab-1" });
      Permissions.ask({ kind: "geolocation", origin: "https://a.example", item_id: "tab-1" });
      return lastView()?.prompt?.rememberable === false;
    })(),
  );
}

// --- Kind registry -----------------------------------------------------------
{
  reset();
  // Every engine prompt Astra owns, and the `Services.perms` name it stores.
  const ENGINE_TYPES = {
    geolocation: "geolocation",
    "desktop-notification": "notifications",
    "persistent-storage": "persistent-storage",
    xr: "xr",
    "loopback-network": "loopback-network",
    "local-network": "local-network",
  };
  for (const [engineType, kind] of Object.entries(ENGINE_TYPES)) {
    check(
      `${engineType} routes to the ${kind} prompt`,
      KIND_BY_ENGINE_TYPE[engineType] === kind && KINDS.has(kind),
    );
  }
  // Picker-style and per-request prompts stay native on purpose: a yes/no card
  // cannot choose a serial port, install a site-permission add-on, pick a
  // screen source, or answer storage-access (the engine writes no policy and
  // replies with a per-embedder choice).
  for (const engineType of ["serial", "midi", "screen", "audioCapture", "storage-access"]) {
    check(`${engineType} keeps the engine prompt`, KIND_BY_ENGINE_TYPE[engineType] === undefined);
  }
  const enumKinds = schema.properties.prompt.properties.kinds.items.enum;
  check(
    "the schema enum is exactly the prompt kinds",
    enumKinds.length === KINDS.size && [...KINDS].every((kind) => enumKinds.includes(kind)),
  );
  for (const kind of KINDS) {
    check(`kind ${kind} has an engine permission name`, typeof ENGINE_PERMISSION_NAME[kind] === "string");
    Permissions.__resetForTests();
    const token = Permissions.ask({
      kind,
      origin: "https://kinds.example",
      item_id: "tab-k",
      profile_id: "default",
      rememberable: true,
    });
    const view = lastView();
    check(
      `kind ${kind} publishes a schema-valid prompt`,
      typeof token === "string" && view?.prompt?.kinds[0] === kind && validView(view),
    );
  }
}

// --- Queue bound -------------------------------------------------------------
{
  reset();
  const tokens = [];
  for (let i = 0; i < 8; i += 1) {
    tokens.push(harness().token);
  }
  const head = Permissions.current().prompt;
  const overflow = Permissions.ask({
    kind: "geolocation",
    origin: "https://overflow.example",
    item_id: "tab-9",
  });
  check("the ninth request is refused", overflow === null);
  check("overflow keeps the visible prompt", Permissions.current().prompt?.request_id === head?.request_id);
  check("overflow does not grow the queue", Permissions.pending().length === 8);
}

off();

console.log(
  `\npermissions prompt contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
