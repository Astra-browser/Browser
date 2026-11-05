#!/usr/bin/env node
// Lane 3 contract test: Site settings host methods.
//
// Imports the chrome host module by file path with an in-memory backend and
// asserts the real route contract:
//   - the list carries the engine-supported kinds and the stored decisions
//   - one origin is a filter, not a different shape
//   - set/remove go through Operations and emit `sites-changed`
//   - a private window lists nothing and refuses every write
//   - a refused write is reported, never optimistically applied
//
// Usage: node tests/contract/site_permissions_host.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Permissions, SITE_KINDS, __setSitePermissionsBackend } = await import(
  path.join(HOST, "Permissions.sys.mjs")
);
const { Operations, __resetOperationsForTests } = await import(
  path.join(HOST, "Operations.sys.mjs")
);
const Events = await import(path.join(HOST, "Events.sys.mjs"));

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

const HEX16 = /^[0-9a-f]{16}$/u;
const kinds = ["camera", "microphone", "geolocation", "notifications", "midi", "popups"];

function backend({ privateWindow = false, failSet = false } = {}) {
  const store = new Map();
  const key = (origin, kind) => `${origin}\u0000${kind}`;
  return {
    store,
    isPrivate: () => privateWindow,
    kinds: () => kinds.slice(),
    list(origin) {
      const entries = [];
      for (const [compound, decision] of store) {
        const [entryOrigin, kind] = compound.split("\u0000");
        if (origin && entryOrigin !== origin) continue;
        entries.push({ origin: entryOrigin, kind, decision });
      }
      return { entries, complete: true };
    },
    set(origin, kind, decision) {
      if (failSet) return false;
      if (decision === null) store.delete(key(origin, kind));
      else store.set(key(origin, kind), decision);
      return true;
    },
  };
}

function reset() {
  __resetOperationsForTests();
  Permissions.__resetForTests();
  seen.length = 0;
}

async function disposition(admission) {
  return (await Operations.status(admission)).disposition;
}

const seen = [];
const off = Events.addEventListener((event) => seen.push(event));
const sitesEvents = () => seen.filter((event) => event.type === "sites-changed");
const lastSites = () => sitesEvents().at(-1)?.data;

// --- List --------------------------------------------------------------------
{
  reset();
  __setSitePermissionsBackend(backend());
  const view = await Permissions.listSites({});
  check("list returns every supported kind", view.kinds.length === kinds.length);
  check("list is private:false for a normal window", view.private === false);
  check("list is complete when the engine answered", view.complete === true);
  check("an empty profile has no entries", view.entries.length === 0);
  check("the exported kind list matches", SITE_KINDS.join(",") === kinds.join(","));
}

{
  reset();
  const store = backend();
  __setSitePermissionsBackend(store);
  const admission = await Permissions.setSite({
    origin: "https://meet.example",
    kind: "camera",
    decision: "allow",
  });
  check("a write is admitted with a 16-hex id", HEX16.test(admission.operation_id));
  check("a write settles as applied", (await disposition(admission)).outcome === "applied");
  check("the decision reached the backend", store.store.get("https://meet.example\u0000camera") === "allow");
  check("a write emits sites-changed", sitesEvents().length === 1);
  check("the event names the origin", lastSites().origin === "https://meet.example");
  check("the event names the kind", lastSites().kind === "camera");
  check("the event carries the decision", lastSites().decision === "allow");
  check("the event carries the profile", lastSites().profile === "default");

  const view = await Permissions.listSites({});
  check("the saved decision is listed", view.entries.length === 1);
  check("the entry is the exact origin", view.entries[0].origin === "https://meet.example");
  check("the entry carries allow", view.entries[0].decision === "allow");
}

// --- Change and remove -------------------------------------------------------
{
  reset();
  const store = backend();
  __setSitePermissionsBackend(store);
  await Permissions.setSite({ origin: "https://a.example", kind: "camera", decision: "allow" });
  await Permissions.setSite({ origin: "https://a.example", kind: "camera", decision: "block" });
  check("a second set updates in place", store.store.get("https://a.example\u0000camera") === "block");
  const removed = await Permissions.setSite({
    origin: "https://a.example",
    kind: "camera",
    decision: null,
  });
  check("remove settles as applied", (await disposition(removed)).outcome === "applied");
  check("remove forgets the decision", store.store.size === 0);
  check("remove emits another change", sitesEvents().length === 3);
  check("the remove event has a null decision", lastSites().decision === null);
}

// --- Origin filter -----------------------------------------------------------
{
  reset();
  const store = backend();
  __setSitePermissionsBackend(store);
  await Permissions.setSite({ origin: "https://a.example", kind: "camera", decision: "allow" });
  await Permissions.setSite({ origin: "https://b.example", kind: "microphone", decision: "block" });
  const one = await Permissions.listSites({ origin: "https://a.example" });
  check("an origin filter returns one entry", one.entries.length === 1);
  check("the filter keeps the requested origin", one.entries[0].origin === "https://a.example");
  const all = await Permissions.listSites({ origin: null });
  check("null lists every origin", all.entries.length === 2);
  const bad = await Permissions.listSites({ origin: "not-a-site" });
  check("a bad origin filter is incomplete, not widened", bad.complete === false && bad.entries.length === 0);
}

// --- Refusals ----------------------------------------------------------------
{
  reset();
  const store = backend();
  __setSitePermissionsBackend(store);
  const before = sitesEvents().length;

  for (const [name, args] of [
    ["a non-http origin", { origin: "about:blank", kind: "camera", decision: "allow" }],
    ["an origin with a path", { origin: "https://a.example/path", kind: "camera", decision: "allow" }],
    ["an unknown kind", { origin: "https://a.example", kind: "telepathy", decision: "allow" }],
    ["an unknown decision", { origin: "https://a.example", kind: "camera", decision: "maybe" }],
  ]) {
    const admission = await Permissions.setSite(args);
    check(`${name} is refused as invalid_input`, (await disposition(admission)).reason === "invalid_input");
  }
  check("refusals changed nothing", store.store.size === 0 && sitesEvents().length === before);
}

{
  reset();
  __setSitePermissionsBackend(backend({ failSet: true }));
  const admission = await Permissions.setSite({
    origin: "https://a.example",
    kind: "camera",
    decision: "allow",
  });
  check("a failed engine write is rejected", (await disposition(admission)).reason === "store_admission_rejected");
  check("a failed write emits nothing", sitesEvents().length === 0);
}

// --- Private scope -----------------------------------------------------------
{
  reset();
  const store = backend({ privateWindow: true });
  __setSitePermissionsBackend(store);
  const view = await Permissions.listSites({});
  check("a private window lists nothing", view.private === true && view.entries.length === 0);
  const admission = await Permissions.setSite({
    origin: "https://a.example",
    kind: "camera",
    decision: "allow",
  });
  check("a private write is refused", (await disposition(admission)).reason === "invalid_scope");
  check("a private write reaches no store", store.store.size === 0);
  check("a private refusal emits nothing", sitesEvents().length === 0);
}

// --- Broken engine read ------------------------------------------------------
{
  reset();
  __setSitePermissionsBackend({
    isPrivate: () => false,
    kinds: () => kinds.slice(),
    list() {
      throw new Error("engine down");
    },
    set() {
      return true;
    },
  });
  const view = await Permissions.listSites({});
  check("a throwing list is incomplete", view.complete === false && view.entries.length === 0);
}

// --- Unsupported kind from the engine ---------------------------------------
{
  reset();
  __setSitePermissionsBackend({
    isPrivate: () => false,
    kinds: () => ["camera"],
    list: () => ({ entries: [], complete: true }),
    set: () => true,
  });
  const admission = await Permissions.setSite({
    origin: "https://a.example",
    kind: "geolocation",
    decision: "allow",
  });
  check("a kind the engine does not keep is refused", (await disposition(admission)).reason === "unsupported_command");
}

off();

// Every entry the host returns must be one of the wire's kinds/decisions.
{
  reset();
  __setSitePermissionsBackend({
    isPrivate: () => false,
    kinds: () => kinds.slice(),
    list: () => ({
      complete: true,
      entries: [
        { origin: "https://ok.example", kind: "camera", decision: "allow" },
        { origin: "https://ok.example", kind: "telepathy", decision: "allow" },
        { origin: "ftp://no.example", kind: "camera", decision: "allow" },
        { origin: "https://no.example", kind: "camera", decision: "maybe" },
        { origin: "https://pop.example", kind: "popups", decision: "block" },
      ],
    }),
    set: () => true,
  });
  const view = await Permissions.listSites({});
  check("foreign entries are filtered out", view.entries.length === 1);
  check("the kept entry is canonical", view.entries[0].origin === "https://ok.example");
  check("a pop-up block is not offered as an editable row", view.entries.some((entry) => entry.kind === "popups") === false);
}

Permissions.__resetForTests();

console.log(
  `\nsite permissions host contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
