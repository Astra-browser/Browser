/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Compatibility shim. The sidecar transport now lives in Boot.sys.mjs
// (`SidecarFrame` + `BootSidecar`) so startup has one owner. Keep this file
// for tests and older imports; it is not packaged in `jar.mn`.

export { BootSidecar, SidecarFrame } from "./Boot.sys.mjs";
