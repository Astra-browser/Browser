#!/usr/bin/env node
// Docs reachability gate.
//
// Every doc under docs/ must stay reachable: either listed in docs/README.md or
// cited by name somewhere else in the repo. A doc nothing points at is sediment:
// archive it or link it. See docs/README.md for the contract/plan/report split.
//
// Usage: node tools/docs-check.mjs

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename, relative, sep } from "node:path";

const root = process.cwd();
const docsDir = join(root, "docs");
const indexPath = join(docsDir, "README.md");

// Time-boxed or local-only trees are exempt: they are already archives.
const SKIP_DOC_DIRS = new Set(["archive", "notes", "release", "spikes", "assets", "node_modules"]);

// Text the gate treats as evidence a doc is still cited.
const CORPUS_ROOTS = [
  "docs",
  "tools",
  "tests",
  "crates",
  "overlay",
  "forge",
  "passkeys",
  "config",
  "schemas",
  "ui/app/src",
  "AGENTS.md",
  "README.md",
  "Cargo.toml",
  "setup.sh",
];
const CORPUS_EXTS = new Set([
  ".md", ".mjs", ".js", ".ts", ".svelte", ".py", ".rs", ".toml", ".json", ".yml", ".yaml", ".sh", ".ps1",
]);
const HEAVY_DIRS = new Set(["node_modules", "target", "dist", "out", "engine", ".git"]);

function walk(dir, onFile, skip = new Set()) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || HEAVY_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), onFile, skip);
    } else {
      onFile(join(dir, entry.name));
    }
  }
}

if (!existsSync(indexPath)) {
  console.error("docs-check: docs/README.md is missing; it is the index the gate trusts.");
  process.exit(1);
}

const index = readFileSync(indexPath, "utf8");
const docs = [];
walk(docsDir, (file) => {
  if (file.endsWith(".md") && !SKIP_DOC_DIRS.has(relative(docsDir, file).split(sep)[0])) docs.push(file);
}, SKIP_DOC_DIRS);

let corpus = "";
for (const rel of CORPUS_ROOTS) {
  const target = join(root, rel);
  try {
    if (target.endsWith(".md") || /\.(toml|sh)$/.test(target)) {
      if (existsSync(target)) corpus += readFileSync(target, "utf8") + "\n";
      continue;
    }
    walk(target, (file) => {
      if (!CORPUS_EXTS.has(file.slice(file.lastIndexOf(".")))) return;
      try {
        corpus += readFileSync(file, "utf8") + "\n";
      } catch {
        /* unreadable file: ignore */
      }
    });
  } catch {
    /* missing root: ignore */
  }
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

const unreachable = [];
const archivedReports = [];
const brokenLinks = [];

for (const file of docs) {
  const name = basename(file);
  const self = readFileSync(file, "utf8");
  const cited = Math.max(0, count(corpus, name) - count(self, name));
  if (!index.includes(name) && cited === 0) unreachable.push({ file, name });
}

// Dated reports belong in docs/archive; warn until the archive sweep lands.
const DATED = /(_20\d{2}-\d{2}-\d{2}\.md|^REPORT-20\d{2})/;
for (const file of docs) {
  if (DATED.test(basename(file))) archivedReports.push(relative(root, file));
}

// Index links must resolve (paths relative to docs/).
for (const match of index.matchAll(/\]\(([^)#]+\.md)\)/g)) {
  const target = join(docsDir, match[1]);
  if (!existsSync(target)) brokenLinks.push(match[1]);
}

if (archivedReports.length > 0) {
  console.warn(`docs-check: ${archivedReports.length} dated report(s) still outside docs/archive:`);
  for (const f of archivedReports) console.warn(`  - ${f}`);
}

if (brokenLinks.length > 0) {
  console.error(`docs-check: ${brokenLinks.length} broken link(s) in docs/README.md:`);
  for (const l of brokenLinks) console.error(`  - ${l}`);
}

if (unreachable.length > 0) {
  console.error(`docs-check: ${unreachable.length} doc(s) nothing points at (index them or move to docs/archive):`);
  for (const { file } of unreachable) console.error(`  - ${relative(root, file)}`);
}

if (brokenLinks.length > 0 || unreachable.length > 0) process.exit(1);
console.log(`docs-check: ok (${docs.length} docs reachable; ${archivedReports.length} dated report warning(s))`);
