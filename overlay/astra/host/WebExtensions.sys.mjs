/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API WebExtensions module (v1, P3-T17). Minimal stub for
// `web_extension_list`, which the app's extension store
// (`ui/app/src/domain/webext/webext.svelte.ts`) calls on boot — the third
// `no host route` BridgeError in out/p3t17-r2/poll.jsonl.
//
// No extension host is reachable from pure host logic (the real listing lives
// behind Firefox's AddonManager: chrome-privileged, async, and with no
// Node-testable surface), so `list` answers the native payload shape
// directly — a bare `WebExtensionView[]`, today always empty — instead of the
// usual `{ request_id, host_api_version, ... }` envelope. That shape is load
// bearing: the generated UI binding (`commands.webExtensionList`) consumes
// the bridge payload as the array itself, so an envelope here would trade the
// current BridgeError for a TypeError inside `webext.refresh()`. The UI
// treats the empty list as "no extensions installed" (`available: true`).
// Pure logic, no Firefox internals.

export const WebExtensions = {
  // List installed extensions (stub: none yet — see above).
  async list() {
    return [];
  },
};

// Test-only reset so contract tests start from a clean slate. The stub is
// stateless; this exists for the HostAPI reset protocol.
export function __resetWebExtensionsForTests() {
}
