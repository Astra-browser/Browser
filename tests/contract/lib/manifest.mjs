/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One loader for the command manifest (D-55), shared by the contract suites.
//
// Node strips the manifest's TypeScript on import (its only import is
// type-only), so no build step and no parser are involved. Keeping the path in
// one place means moving the manifest is one edit, not five.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);
const MANIFEST = path.join(ROOT, "ui", "packages", "bridge", "src", "manifest.ts");

export async function loadManifest() {
  return import(pathToFileURL(MANIFEST).href);
}
