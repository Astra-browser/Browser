/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { canInstall, categoryTitle, installLabel, statusBadge } from "../lib/gallery-view";

describe("gallery view helpers", () => {
  it("badges every mapping status", () => {
    expect(statusBadge("equivalent")).toBe("Firefox equivalent");
    expect(statusBadge("alternative")).toBe("Closest Firefox alternative");
    expect(statusBadge("none")).toBe("No Firefox version");
  });

  it("titles categories", () => {
    expect(categoryTitle("passwords")).toBe("Passwords");
    expect(categoryTitle("developers")).toBe("Developers");
    expect(categoryTitle("")).toBe("");
  });

  it("labels install actions, preferring accuracy over optimism", () => {
    expect(installLabel({ status: "equivalent", installed: false })).toBe("Get for Firefox");
    expect(installLabel({ status: "alternative", installed: false })).toBe("Get for Firefox");
    expect(installLabel({ status: "none", installed: false })).toBe("Chrome-only");
    expect(installLabel({ status: "equivalent", installed: true })).toBe("Installed");
    expect(canInstall({ status: "equivalent", installHref: "https://example.test" })).toBe(true);
    expect(canInstall({ status: "none", installHref: null })).toBe(false);
    expect(canInstall({ status: "alternative", installHref: null })).toBe(false);
  });
});
