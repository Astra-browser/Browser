import { expect, test } from "vitest";
import { GALLERY, installUrl } from "$domain/extensions";
import { catalog, storeListing } from "../lib/catalog";

test("every catalog entry resolves to its curated install page", () => {
  const entries = catalog.flatMap((group) => group.entries);
  const ids = entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const group of catalog) expect(group.title().length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry.id).toMatch(/^[a-p]{32}$/);
    expect(entry.icon).toBeTruthy();
    expect(entry.blurb().length).toBeGreaterThan(0);
    const mapped = GALLERY.find((candidate) => candidate.chromeStoreId === entry.id);
    expect(mapped).toBeTruthy();
    expect(storeListing(entry.id)).toBe(installUrl(mapped!));
  }
});
