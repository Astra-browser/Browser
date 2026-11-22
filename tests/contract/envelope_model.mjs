#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One owner for the Host API reply envelope (P7-T03).
//
// What this catches: a host module that grows its own `ok`/`err` again, or a
// second `HOST_API_VERSION = 1`, so two replies can drift on the wire. It also
// pins the two admission shapes that share field names and mean the opposite:
//
//   operationAccepted("op-1")  -> { operation_id: "op-1", accepted: true }
//      The operation exists and was taken up; its outcome is rejected.
//   commandNotAdmitted("...")  -> { operation_id: null, accepted: false, reason }
//      No operation exists; the command never reached the engine.
//
// The field set and order are the wire (Appendix C). `JSON.stringify` is
// compared, not only deep equality, so adding/renaming/reordering a field
// fails here before a contract suite sees different bytes.
//
// Source scan: the host files are plain ES modules, read from disk and brace-
// matched, not inferred from a TypeScript regex. Exactly one file may define
// each helper, and it is `Envelope.sys.mjs`.
//
// Usage: node tests/contract/envelope_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const ENVELOPE = path.join(HOST, "Envelope.sys.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
    if (detail) console.error(`  ${detail}`);
  }
}

let env = null;
try {
  env = await import(pathToFileURL(ENVELOPE).href);
  check("overlay/astra/host/Envelope.sys.mjs imports", true);
} catch (error) {
  check("overlay/astra/host/Envelope.sys.mjs imports", false, String(error?.message ?? error));
}

if (env) {
  // --- the version ---------------------------------------------------------
  check("HOST_API_VERSION is 1", env.HOST_API_VERSION === 1, String(env.HOST_API_VERSION));
  check(
    "the version is a number, not a string",
    typeof env.HOST_API_VERSION === "number",
    typeof env.HOST_API_VERSION,
  );

  // --- ok ------------------------------------------------------------------
  const plainOk = env.ok("r-1");
  check(
    "ok carries exactly request_id + host_api_version",
    Object.keys(plainOk).join(",") === "request_id,host_api_version",
    Object.keys(plainOk).join(","),
  );
  check("ok echoes request_id", plainOk.request_id === "r-1");
  check("ok carries the shared version", plainOk.host_api_version === env.HOST_API_VERSION);
  check(
    "ok wire bytes are unchanged",
    JSON.stringify(env.ok("r-1", { accepted: true })) ===
      '{"request_id":"r-1","host_api_version":1,"accepted":true}',
    JSON.stringify(env.ok("r-1", { accepted: true })),
  );

  // --- err -----------------------------------------------------------------
  const failure = env.err("r-1", "invalid_url", "not an address");
  check(
    "err carries exactly request_id + host_api_version + error",
    Object.keys(failure).join(",") === "request_id,host_api_version,error",
    Object.keys(failure).join(","),
  );
  check(
    "err's error carries exactly code + message",
    Object.keys(failure.error).join(",") === "code,message",
    Object.keys(failure.error).join(","),
  );
  check(
    "err wire bytes are unchanged",
    JSON.stringify(failure) ===
      '{"request_id":"r-1","host_api_version":1,"error":{"code":"invalid_url","message":"not an address"}}',
    JSON.stringify(failure),
  );

  // --- admitted (the envelope variant) -------------------------------------
  check(
    "admitted is an ok envelope that already names the operation",
    JSON.stringify(env.admitted("r-1", { astra_tab_id: "tab-1" })) ===
      '{"request_id":"r-1","host_api_version":1,"operation_id":null,"accepted":true,"astra_tab_id":"tab-1"}',
    JSON.stringify(env.admitted("r-1", { astra_tab_id: "tab-1" })),
  );

  // --- the two refusal shapes stay distinct --------------------------------
  const recorded = env.operationAccepted("op-7");
  check(
    "an operation refused by policy is still an accepted operation",
    recorded.accepted === true,
    String(recorded.accepted),
  );
  check(
    "the operation refusal points at the recorded operation",
    recorded.operation_id === "op-7" && !("reason" in recorded),
  );
  check(
    "the operation refusal wire bytes are unchanged",
    JSON.stringify(recorded) === '{"operation_id":"op-7","accepted":true}',
    JSON.stringify(recorded),
  );

  const neverAdmitted = env.commandNotAdmitted("refused");
  check(
    "a command refused before dispatch was never admitted",
    neverAdmitted.accepted === false,
    String(neverAdmitted.accepted),
  );
  check(
    "a command refused before dispatch has no operation id",
    neverAdmitted.operation_id === null,
  );
  check(
    "the command refusal keeps its reason",
    neverAdmitted.reason === "refused",
    String(neverAdmitted.reason),
  );
  check(
    "the command refusal wire bytes are unchanged",
    JSON.stringify(neverAdmitted) ===
      '{"operation_id":null,"accepted":false,"reason":"refused"}',
    JSON.stringify(neverAdmitted),
  );
  check(
    "the two refusal shapes answer different questions",
    recorded.accepted !== neverAdmitted.accepted &&
      recorded.operation_id !== neverAdmitted.operation_id,
  );

  // --- the module itself ---------------------------------------------------
  const envelopeSource = await readFile(ENVELOPE, "utf8");
  check(
    "Envelope imports nothing",
    !/^\s*(?:import|export)\s[^;]*\bfrom\b/m.test(envelopeSource) &&
      !/\bimport\s*\(/u.test(envelopeSource),
    "an import here could give a host module a cycle it cannot break",
  );
}

// --- no host module may define the envelope again ---------------------------
const files = (await readdir(HOST, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sys.mjs"))
  .map((entry) => entry.name)
  .sort();
const sources = new Map();
for (const file of files) {
  sources.set(file, await readFile(path.join(HOST, file), "utf8"));
}

// A function definition and its balanced body. The host files are plain
// modules, so a brace scan is exact where a regex over code would not be.
function functionBodies(source, name) {
  const bodies = [];
  const needle = `function ${name}(`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    const before = at === 0 ? "" : source[at - 1];
    if (!/[\w$]/u.test(before)) {
      // Find the body brace after the parameter list; a default parameter
      // (`data = {}`) has braces of its own before the body.
      const openParen = at + needle.length - 1;
      let parens = 0;
      let open = -1;
      for (let index = openParen; index < source.length; index += 1) {
        const char = source[index];
        if (char === "(") parens += 1;
        else if (char === ")") {
          parens -= 1;
          if (parens === 0) {
            open = source.indexOf("{", index);
            break;
          }
        }
      }
      if (open !== -1) {
        let depth = 0;
        let close = -1;
        for (let index = open; index < source.length; index += 1) {
          const char = source[index];
          if (char === "{") depth += 1;
          else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
              close = index;
              break;
            }
          }
        }
        if (close !== -1) bodies.push(source.slice(open, close + 1));
      }
    }
    at = source.indexOf(needle, at + needle.length);
  }
  return bodies;
}

// The reply helpers are function declarations; a local boolean named `ok`
// (Permissions, Blocker, MediaGallery) is not one. A `const ok = ...` counts
// only when its value reads the envelope's `request_id` input.
function binding(name, source) {
  const match = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${name}\\s*=`, "u").exec(
    source,
  );
  if (!match) return false;
  return /\brequest_id\b/u.test(source.slice(match.index, match.index + 200));
}

function definingFiles(name) {
  return files.filter((file) => {
    const source = sources.get(file);
    return functionBodies(source, name).length > 0 || binding(name, source);
  });
}

for (const helper of ["ok", "err"]) {
  const owners = definingFiles(helper);
  check(
    `only Envelope.sys.mjs defines ${helper}() (${owners.length} owner)`,
    owners.length === 1 && owners[0] === "Envelope.sys.mjs",
    owners.join(", ") || "no module defines it",
  );
}

const versionOwners = files.filter((file) =>
  /HOST_API_VERSION\s*=\s*1(?![0-9])/u.test(sources.get(file)),
);
check(
  `only Envelope.sys.mjs assigns HOST_API_VERSION = 1 (${versionOwners.length} owner)`,
  versionOwners.length === 1 && versionOwners[0] === "Envelope.sys.mjs",
  versionOwners.join(", ") || "no module assigns it",
);

// `admitted` exists twice on purpose: Tabs' reply is an envelope, Time's is a
// bare admission with no request id. Only the envelope belongs to Envelope.
const envelopeAdmitted = files.filter((file) =>
  functionBodies(sources.get(file), "admitted").some((body) =>
    body.includes("host_api_version"),
  ),
);
check(
  "only Envelope.sys.mjs builds the envelope admitted()",
  envelopeAdmitted.length === 1 && envelopeAdmitted[0] === "Envelope.sys.mjs",
  envelopeAdmitted.join(", ") || "no envelope-shaped admitted()",
);
const timeAdmitted = functionBodies(sources.get("Time.sys.mjs") ?? "", "admitted");
check(
  "Time's admitted() is a bare admission, not a second envelope",
  timeAdmitted.length === 1 && !timeAdmitted[0].includes("host_api_version"),
  `${timeAdmitted.length} definition(s)`,
);

console.log(
  `\nenvelope model: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
