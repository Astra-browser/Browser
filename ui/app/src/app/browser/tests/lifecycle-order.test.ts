/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, it } from "vitest";

// A few modules in this table resolve platform and motion values at import
// time. The unit project runs in Node, so provide just those reads.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Windows" },
  configurable: true,
});
Object.assign(globalThis, {
  window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  },
  document: { documentElement: { dataset: {} } },
});

const { createBrowserLifecycle } = await import("../lifecycle");

const entries = createBrowserLifecycle({ handleKeydown: () => {} });
const active = entries.filter((entry) => entry.when === undefined || entry.when());
const started = active.filter((entry) => entry.start !== undefined).map((entry) => entry.id);
const stopped = [...active]
  .filter((entry) => entry.stop !== undefined)
  .sort((left, right) => left.teardown - right.teardown)
  .map((entry) => entry.id);

it("keeps the browser startup order", () => {
  expect(started).toEqual([
    "theme",
    "tools",
    "surface",
    "preferences",
    "runtime",
    "media-player",
    "peek",
    "focus",
    "updates",
    "update-notices",
    "extensions",
    "webext-refresh",
    "webext-access",
    "webext-prompt",
    "webext-store-clicks",
    "webext-drops",
    "page-permissions",
    "page-dialogs",
    "favicons",
    "tabs",
    "sidebar",
    "ui-commands",
    "keymap",
    "browser-import",
    "operations",
    "blocker",
    "layout",
    "keydown",
  ]);
});

it("keeps the browser teardown order", () => {
  expect(stopped).toEqual([
    "theme",
    "surface",
    "tools",
    "motion",
    "preferences",
    "operations",
    "blocker",
    "runtime",
    "media-player",
    "peek",
    "updates",
    "update-notices",
    "focus",
    "extensions",
    "webext",
    "page-permissions",
    "page-dialogs",
    "webext-access",
    "webext-prompt",
    "webext-store-clicks",
    "webext-drops",
    "favicons",
    "tabs",
    "ui-commands",
    "keymap",
    "find-in-page",
    "browser-import",
    "layout",
    "keydown",
  ]);
});
