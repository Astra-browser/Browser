/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One loader for the browser-surface registry, shared by the contract suites.
//
// Node strips the registry's TypeScript on import: its loaders are lazy
// `import()` thunks and every static import is type-only, so nothing resolves
// a Vite alias or a `.svelte` file while the contract runs. Keeping the path
// here means moving the registry is one edit, not five.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);
const SURFACES = path.join(ROOT, "ui", "app", "src", "domain", "surface", "surfaces.ts");

export async function loadSurfaces() {
  return import(pathToFileURL(SURFACES).href);
}
