/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GALLERY } from "../gallery-data";
import {
  countByStatus,
  findByChromeId,
  groupByCategory,
  installUrl,
  isInstallable,
  statusLabel,
  type FirefoxMapping,
  type GalleryEntry,
} from "../gallery";

type GalleryJson = {
  version: number;
  amo_base: string;
  entries: {
    chrome_store_id: string;
    name: string;
    category: string;
    firefox: { status: string; slug: string | null; amo_url: string | null; note: string };
  }[];
};

const loadJson = (): GalleryJson => {
  const url = new URL("../../../../../../crates/astra-extensions/gallery.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as GalleryJson;
};

describe("gallery data", () => {
  it("mirrors gallery.json entry for entry (drift gate)", () => {
    const json = loadJson();
    expect(GALLERY.length).toBe(json.entries.length);
    for (const [index, mirrored] of GALLERY.entries()) {
      const source = json.entries[index]!;
      expect(mirrored.chromeStoreId).toBe(source.chrome_store_id);
      expect(mirrored.name).toBe(source.name);
      expect(mirrored.category).toBe(source.category);
      expect(mirrored.firefox.status).toBe(source.firefox.status);
      expect(mirrored.firefox.slug).toBe(source.firefox.slug);
      expect(mirrored.firefox.amoUrl).toBe(source.firefox.amo_url);
      expect(mirrored.firefox.note).toBe(source.firefox.note);
    }
  });

  it("covers the whole base catalog with unique ids", () => {
    // Code wins over the README's stale "20 verified" claim.
    expect(GALLERY.length).toBe(45);
    const ids = GALLERY.map((entry) => entry.chromeStoreId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of GALLERY) {
      expect(entry.chromeStoreId).toMatch(/^[a-z0-9]{32}$/);
      expect(entry.firefox.note.length).toBeGreaterThan(0);
    }
  });

  it("status mix matches the AMO research", () => {
    expect(countByStatus(GALLERY)).toEqual({ equivalent: 36, alternative: 8, none: 1 });
    expect(GALLERY.filter(isInstallable).length).toBe(44);
    const mappings: FirefoxMapping[] = GALLERY.map((entry: GalleryEntry) => entry.firefox);
    for (const mapping of mappings) {
      if (mapping.slug !== null && mapping.amoUrl !== null) {
        expect(mapping.amoUrl).toContain(mapping.slug);
      }
    }
  });
});

describe("gallery helpers", () => {
  it("labels every status", () => {
    expect(statusLabel("equivalent")).toBe("Firefox equivalent");
    expect(statusLabel("alternative")).toBe("Closest Firefox alternative");
    expect(statusLabel("none")).toBe("No Firefox version");
  });

  it("installs from AMO when possible, else the Chrome listing", () => {
    const darkReader = findByChromeId(GALLERY, "eimadpbcbfnmbkopoojfekhnkhdbieeh");
    expect(darkReader?.firefox.slug).toBe("darkreader");
    expect(installUrl(darkReader!)).toBe("https://addons.mozilla.org/firefox/addon/darkreader/");
    const docsOffline = findByChromeId(GALLERY, "ghbmnnjooekpmoecnnnilnnbdlolhkhi")!;
    expect(isInstallable(docsOffline)).toBe(false);
    expect(installUrl(docsOffline)).toBe(
      "https://chromewebstore.google.com/detail/ghbmnnjooekpmoecnnnilnnbdlolhkhi",
    );
    expect(findByChromeId(GALLERY, "0".repeat(32))).toBeNull();
  });

  it("groups by category in catalog order", () => {
    const groups = groupByCategory(GALLERY);
    expect(groups.map((group) => group.category)).toEqual([
      "passwords",
      "language",
      "browsing",
      "video",
      "saving",
      "productivity",
      "developers",
    ]);
    expect(groups.reduce((sum, group) => sum + group.entries.length, 0)).toBe(45);
  });
});
