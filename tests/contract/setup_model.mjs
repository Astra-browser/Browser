#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The public install path is one command: ./setup.sh. This guard keeps the
// documented command, the Windows bridge, the dry-run and the CI check from
// drifting apart as the build grows.
import fs from "node:fs";
import path from "node:path";
import { ROOT, check, summary } from "./lib/harness.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const setup = read("setup.sh");
const windows = read("tools/setup-windows.ps1");
const readme = read("README.md");
const ci = read(".github/workflows/ci-fast.yml");

check("setup.sh is the documented one command", readme.includes("./setup.sh"));
check("setup.sh has a bash entry point", setup.startsWith("#!/usr/bin/env bash"));
check("setup.sh detects Windows", /MINGW\*\|MSYS\*\|CYGWIN\*/.test(setup));
check("setup.sh bridges to the Windows setup", setup.includes("tools/setup-windows.ps1"));
check("setup.sh supports a dry run", setup.includes("--dry-run") && setup.includes("DRY_RUN=1"));
check("dry run exits before sudo/builds", setup.indexOf('if [ "$DRY_RUN" = 1 ]') < setup.indexOf('step "sudo'));
check("setup.sh can reuse an engine source", setup.includes("--reuse-engine") && setup.includes("ln -sfn"));
check("setup.sh can share an objdir", setup.includes("--objdir") && setup.includes("--objdir \"$OBJDIR\""));
check("setup.sh can stop before packaging", setup.includes("--skip-package"));
check("setup.sh initializes missing git history", setup.includes('git init -q "$ROOT"'));

check("Windows setup exists", windows.includes("param("));
check("Windows setup checks/installs tools", windows.includes("Require-Tools") && windows.includes("Install-Winget"));
check("Windows setup links a reusable engine", windows.includes("New-Item -ItemType Junction"));
check("Windows setup builds the UI", windows.includes("build:chrome"));
check("Windows setup configures the Windows engine", windows.includes("'--os', 'windows'"));
check("Windows setup applies the overlay", windows.includes("overlay --os windows"));
check("Windows setup builds the engine", windows.includes("'build', '--os', 'windows'"));
check("Windows setup packages the release", windows.includes("package-windows.ps1"));
check("Windows setup verifies astra.exe", windows.includes("Astra/astra.exe"));
check("Windows setup has a dry run", windows.includes("[switch]$DryRun"));
check("README documents Windows", /Windows/i.test(readme) && readme.includes("setup-windows.ps1"));
check("README documents dry run", readme.includes("--dry-run"));
check("CI runs the dry-run gate", ci.includes("setup-dry-run"));
check("CI covers Linux and Windows", ci.includes("ubuntu-latest") && ci.includes("windows-latest"));
check("CI calls the public command on Linux", ci.includes("./setup.sh --dry-run"));
check("CI calls the Windows bridge", ci.includes("setup-windows.ps1 -DryRun"));

summary("setup_model");
