#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// P4 stage dock contract: pure geometry and visibility state.
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { stageRectOf, stageStateFor, stageStyle } = await import(pathToFileURL(path.join(ROOT, "ui", "shell", "src", "content", "stage-rect.js")).href);

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

check("rect rounds to whole pixels", JSON.stringify(
  stageRectOf({ getBoundingClientRect: () => ({ left: 12.4, top: 8.6, width: 800.2, height: 600.7 }) }),
) === JSON.stringify({ x: 12, y: 9, w: 800, h: 601 }));
check("missing slot is a zero rect", stageRectOf(null).w === 0 && stageRectOf(null).h === 0);
check("negative size clamps to zero", stageRectOf({
  getBoundingClientRect: () => ({ left: 0, top: 0, width: -2, height: -3 }),
}).w === 0);

const base = { booted: true, hasPage: true, loading: false, internal: false };
check("committed page is visible", stageStateFor(base) === "page");
check("loading hides the native panel", stageStateFor({ ...base, loading: true }) === "loading");
check("no page keeps the app surface", stageStateFor({ ...base, hasPage: false }) === "app");
check("internal surface hides the panel", stageStateFor({ ...base, internal: true }) === "app");
check("unbooted is app", stageStateFor({ ...base, booted: false }) === "app");

const vars = stageStyle({ x: 10, y: 20, w: 300, h: 400 });
check("style carries all four px vars", vars["--astra-stage-x"] === "10px"
  && vars["--astra-stage-y"] === "20px"
  && vars["--astra-stage-w"] === "300px"
  && vars["--astra-stage-h"] === "400px");

assert.equal(failed, 0, `${failed} stage checks failed`);
console.log(`\nstage_rect: ${passed} passed, ${failed} failed`);
