#!/usr/bin/env node
// P6b contract test: the bounded operation ledger that settles privileged
// mutations for the app (bindings.ts OperationAdmission/OperationStatus).
//
//   - every admission returns a 16-lowercase-hex id and accepted: true
//   - the terminal disposition is published once and read back exactly
//   - reconcile returns only unacknowledged records
//   - acknowledgement drops the record and is idempotent
//   - the retained window is bounded; evicted ids report `unknown`
//   - an unclassifiable result fails closed to rejected/invalid_input
//
// Usage: node tests/contract/operations_ledger.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const { Operations, admit, refuse, retainedCount, __resetOperationsForTests } = await import(pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

const HEX16 = /^[0-9a-f]{16}$/u;

function reset() {
  __resetOperationsForTests();
  Events.__resetEventsForTests();
}

reset();
const seen = [];
Events.addEventListener((event) => seen.push(event));

// --- Admission ---------------------------------------------------------------
{
  const admission = admit({ outcome: "applied", reason: "mutation_applied" });
  check("admission accepts the command", admission.accepted === true);
  check("admission mints a 16-hex id", HEX16.test(admission.operation_id));
  const status = await Operations.status({ operation_id: admission.operation_id });
  check("status reports processed", status.state === "processed");
  check("disposition keeps the id", status.disposition.operation_id === admission.operation_id);
  check("disposition keeps the outcome", status.disposition.outcome === "applied");
  check("disposition keeps the reason", status.disposition.reason === "mutation_applied");
  const emitted = seen.filter((e) => e.type === "operation-processed");
  check("the disposition was published once", emitted.length === 1);
  check(
    "the published payload is the disposition",
    emitted[0].data.operation_id === admission.operation_id &&
      emitted[0].data.outcome === "applied",
  );
  check("a fresh id is unique", admit({}).operation_id !== admission.operation_id);
}

// --- Refusal -----------------------------------------------------------------
{
  const refusal = refuse("invalid_scope");
  check("a refusal is still admitted", refusal.accepted === true);
  const status = await Operations.status({ operation_id: refusal.operation_id });
  check("a refusal is classified rejected", status.disposition.outcome === "rejected");
  check("a refusal keeps its reason", status.disposition.reason === "invalid_scope");
}

// --- Reconciliation and acknowledgement --------------------------------------
{
  reset();
  const first = admit({});
  const second = admit({ outcome: "no_op", reason: "state_unchanged" });
  const pending = await Operations.reconcile();
  check("reconcile lists both records", pending.length === 2);
  check("reconcile preserves order", pending[0].operation_id === first.operation_id);
  check("acknowledgement drops a record", (await Operations.acknowledge({ operation_id: first.operation_id })) === true);
  const after = await Operations.reconcile();
  check("an acknowledged record is gone", after.length === 1 && after[0].operation_id === second.operation_id);
  check(
    "a second acknowledgement reports nothing to do",
    (await Operations.acknowledge({ operation_id: first.operation_id })) === false,
  );
  check(
    "an acknowledged record reads back unknown",
    (await Operations.status({ operation_id: first.operation_id })).state === "unknown",
  );
  check(
    "an unacknowledged record reads back processed",
    (await Operations.status({ operation_id: second.operation_id })).state === "processed",
  );
}

// --- Status fencing ----------------------------------------------------------
{
  check("an empty id is unknown", (await Operations.status({})).state === "unknown");
  check("a malformed id is unknown", (await Operations.status({ operation_id: "nope" })).state === "unknown");
  check(
    "an uppercase id is unknown",
    (await Operations.status({ operation_id: "AAAAAAAAAAAAAAAA" })).state === "unknown",
  );
  check(
    "acknowledging a malformed id is false",
    (await Operations.acknowledge({ operation_id: "nope" })) === false,
  );
}

// --- Bounded retention -------------------------------------------------------
{
  reset();
  const ids = [];
  for (let i = 0; i < 300; i += 1) {
    ids.push(admit({}).operation_id);
  }
  check("retention is bounded", retainedCount() === 256);
  const oldest = await Operations.status({ operation_id: ids[0] });
  const newest = await Operations.status({ operation_id: ids.at(-1) });
  check("the oldest record was evicted", oldest.state === "unknown");
  check("the newest record is retained", newest.state === "processed");
  const reconciled = await Operations.reconcile();
  check("reconcile never exceeds the window", reconciled.length <= 256);
  check("reconcile holds only retained ids", reconciled.every((d) => HEX16.test(d.operation_id)));
}

// --- Fail closed -------------------------------------------------------------
{
  reset();
  const admission = admit({ outcome: "magic", reason: "also-magic" });
  const status = await Operations.status({ operation_id: admission.operation_id });
  check("an unknown outcome fails closed to rejected", status.disposition.outcome === "rejected");
  check("an unknown reason fails closed to invalid_input", status.disposition.reason === "invalid_input");
}

console.log(
  `\noperations ledger contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
