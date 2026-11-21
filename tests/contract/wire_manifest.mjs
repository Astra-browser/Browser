#!/usr/bin/env node
// Contract seam: the command manifest's declared invariants.
//
// What this catches: a duplicate command name, a row with no state, an
// unrouted row that still carries a module/method, a deferred row whose reason
// is not a real decision or SCOPE anchor, and drift in the settled
// denominators (317 names, 177 routed, 140 unrouted, states partition). The
// split of the 140 is reported, not pinned: it moves when a dead caller is
// deleted on a sibling branch.
//
// What it does not catch: whether host-transport.ts actually builds its table
// from the manifest, or whether a module/method exists at runtime. Those are
// `ui/packages/bridge/src/manifest.test.ts` (manifest <-> ROUTES, under bun)
// and `tests/contract/wire_coverage.mjs` (route targets exist).
//
// It imports the TypeScript module directly: this Node (26.x) strips types on
// import, and the manifest's only import is type-only, so nothing else loads.
//
// Usage: node tests/contract/wire_manifest.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

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

const decisions = await readFile(path.join(ROOT, "docs", "astra", "DECISIONS.md"), "utf8");
const scope = await readFile(path.join(ROOT, "docs", "astra", "SCOPE.md"), "utf8");

let manifest;
try {
  ({ COMMAND_MANIFEST: manifest } = await import(
    pathToFileURL(path.join(ROOT, "ui", "packages", "bridge", "src", "manifest.ts")).href
  ));
} catch (error) {
  console.error(`FAIL the manifest exists and loads (${error.message})`);
  console.error("\nwire manifest: FAIL (1 check, 1 failed)");
  process.exit(1);
}

check("the manifest is a non-empty array", Array.isArray(manifest) && manifest.length > 0);

const entries = Array.isArray(manifest) ? manifest : [];
const names = entries.map((entry) => entry.name);
const unique = new Set(names);
check(`command names are unique (${names.length} rows)`, unique.size === names.length);

const STATES = new Set(["routed", "deferred", "unused", "open"]);
const badShape = entries.filter(
  (entry) =>
    typeof entry.name !== "string" ||
    !/^[a-z][a-z0-9_]*$/u.test(entry.name) ||
    !STATES.has(entry.state) ||
    typeof entry.args !== "string",
);
check(`every row has a name, a known state and an arg map (${badShape.length} bad)`, badShape.length === 0);
for (const entry of badShape.slice(0, 10)) console.error(`  ${JSON.stringify(entry)}`);

const byState = (state) => entries.filter((entry) => entry.state === state);
const routed = byState("routed");
const deferred = byState("deferred");
const unused = byState("unused");
const open = byState("open");

// Settled denominators. 317 = the 281 generated command names plus the 36
// route names no registry ever carried. A new command, or a newly routed one,
// must update these on purpose, which is the gate. The split of the 140
// unrouted rows (deferred / unused / open) is reported by `--report` rather
// than pinned here: it moves when a dead caller is deleted, and pinning it
// would make the gate depend on unrelated branches.
check(`the manifest counts 317 commands (${entries.length})`, entries.length === 317);
check(`177 rows are routed (${routed.length})`, routed.length === 177);
check(`140 rows are unrouted (${entries.length - routed.length})`, entries.length - routed.length === 140);
check(
  "the states partition every row",
  routed.length + deferred.length + unused.length + open.length === entries.length,
);

const routedShape = routed.filter(
  (entry) =>
    typeof entry.module === "string" &&
    entry.module.length > 0 &&
    typeof entry.method === "string" &&
    entry.method.length > 0 &&
    entry.reason === null,
);
check(`every routed row names a module and a method (${routedShape.length}/${routed.length})`, routedShape.length === routed.length);

const unroutedShape = [...deferred, ...unused, ...open].filter(
  (entry) => entry.module === null && entry.method === null && entry.args === "none",
);
check(
  `every unrouted row has no destination (${unroutedShape.length}/${deferred.length + unused.length + open.length})`,
  unroutedShape.length === deferred.length + unused.length + open.length,
);

// A deferral is a decision, not a note. It must resolve to a real D-nn row or
// to a heading that exists in the scope contract.
const decisionIds = new Set([...decisions.matchAll(/^\|\s*(D-\d{2})\s*\|/gmu)].map((match) => match[1]));
const scopeSlugs = new Set(
  [...scope.matchAll(/^#{2,3}\s+(.+)$/gmu)].map((match) =>
    match[1]
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, ""),
  ),
);
const badReasons = deferred.filter((entry) => {
  if (typeof entry.reason !== "string") return true;
  if (entry.reason.startsWith("D-")) return !decisionIds.has(entry.reason);
  if (entry.reason.startsWith("SCOPE:")) return !scopeSlugs.has(entry.reason.slice("SCOPE:".length));
  return true;
});
check(`every deferred row names a real decision or SCOPE anchor (${badReasons.length} bad)`, badReasons.length === 0);
for (const entry of badReasons.slice(0, 10)) console.error(`  ${entry.name} -> ${entry.reason}`);

const strayReasons = [...unused, ...open].filter((entry) => entry.reason !== null);
check(`open and unused rows carry no decision reason (${strayReasons.length})`, strayReasons.length === 0);

// `--report` writes the visible gap inventory. It scans the app for callers so
// the reader can go straight to the surface that needs the route. The scan is a
// best-effort reference count, not a reachability proof: a caller in a module
// nothing imports still shows up, which is the honest answer on this base.
if (process.argv.includes("--report")) {
  const bindings = await readFile(
    path.join(ROOT, "ui", "app", "src", "shared", "ipc", "bindings.ts"),
    "utf8",
  );
  const block = bindings.slice(
    bindings.indexOf("export const commands = {"),
    bindings.indexOf("export const events"),
  );
  const wrapperToWire = new Map();
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current) return;
    const match = buffer.join(" ").match(/__TAURI_INVOKE(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/u);
    if (match) wrapperToWire.set(current, match[1]);
  };
  for (const line of block.split(/\r?\n/u)) {
    const head = line.match(/^\t([A-Za-z0-9_]+):\s*\(/u);
    if (head) {
      flush();
      current = head[1];
      buffer = [line];
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();

  const callers = new Map();
  const record = (name, file) => {
    if (!callers.has(name)) callers.set(name, new Set());
    callers.get(name).add(file);
  };
  const walk = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (["node_modules", "dist", "build"].includes(item.name)) continue;
        await walk(full);
      } else if (
        /\.(ts|js|svelte)$/u.test(item.name) &&
        !/\.test\.|\.spec\.|__tests__/u.test(item.name)
      ) {
        const text = await readFile(full, "utf8");
        const relative = path.relative(ROOT, full).split(path.sep).join("/");
        for (const match of text.matchAll(/\bcommands\.([A-Za-z0-9_]+)\s*\(/gu)) {
          const wire = wrapperToWire.get(match[1]);
          if (wire) record(wire, relative);
        }
        for (const match of text.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/gu)) {
          record(match[1], relative);
        }
      }
    }
  };
  await walk(path.join(ROOT, "ui", "app", "src"));

  const rowsFor = (state) =>
    entries
      .filter((entry) => entry.state === state)
      .map((entry) => ({
        name: entry.name,
        ...(entry.reason ? { reason: entry.reason } : {}),
        callers: [...(callers.get(entry.name) ?? [])].sort(),
      }));
  const report = {
    generatedBy: "node tests/contract/wire_manifest.mjs --report",
    note:
      "Callers are best-effort references in ui/app/src (non-test). A caller " +
      "in a module nothing imports still appears; reachability is not proven here.",
  verification:
      "No live probe: slice 1 changed no surface, host module or engine path. " +
      "Contract and unit gates only; see docs/astra/STATE.md P7-T01.",
    counts: {
      total: entries.length,
      routed: routed.length,
      deferred: deferred.length,
      unused: unused.length,
      open: open.length,
      calledUnrouted: [...deferred, ...unused, ...open].filter(
        (entry) => (callers.get(entry.name) ?? new Set()).size > 0,
      ).length,
    },
    deferred: rowsFor("deferred"),
    open: rowsFor("open"),
    unused: rowsFor("unused"),
  };
  await writeFile(
    path.join(ROOT, "tests", "contract", "wire_gaps.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `wire gaps: wrote tests/contract/wire_gaps.json ` +
      `(${report.counts.routed} routed, ${report.counts.deferred} deferred, ` +
      `${report.counts.unused} unused, ${report.counts.open} open)`,
  );
}

console.log(`\nwire manifest: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
