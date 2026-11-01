/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Curated gallery types + pure helpers (P4-T04). Canonical data lives in
// gallery-data.ts (mirrored from crates/astra-extensions/gallery.json);
// this module only shapes and queries it.

export type MappingStatus = "equivalent" | "alternative" | "none";

export type FirefoxMapping = {
  status: MappingStatus;
  slug: string | null;
  amoUrl: string | null;
  note: string;
};

export type GalleryEntry = {
  chromeStoreId: string;
  name: string;
  category: string;
  firefox: FirefoxMapping;
};

/** Installable on Firefox: an AMO listing exists (same build or substitute). */
export const isInstallable = (entry: GalleryEntry): boolean =>
  entry.firefox.status !== "none" && entry.firefox.slug !== null && entry.firefox.amoUrl !== null;

/** Direct install URL: AMO listing, or the Chrome listing for `none` entries. */
export const installUrl = (entry: GalleryEntry): string =>
  entry.firefox.amoUrl ?? `https://chromewebstore.google.com/detail/${entry.chromeStoreId}`;

export const statusLabel = (status: MappingStatus): string =>
  status === "equivalent"
    ? "Firefox equivalent"
    : status === "alternative"
      ? "Closest Firefox alternative"
      : "No Firefox version";

export const findByChromeId = (
  entries: readonly GalleryEntry[],
  chromeStoreId: string,
): GalleryEntry | null => entries.find((entry) => entry.chromeStoreId === chromeStoreId) ?? null;

export const groupByCategory = (
  entries: readonly GalleryEntry[],
): { category: string; entries: GalleryEntry[] }[] => {
  const order: string[] = [];
  const groups = new Map<string, GalleryEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.category);
    if (list) list.push(entry);
    else {
      groups.set(entry.category, [entry]);
      order.push(entry.category);
    }
  }
  return order.map((category) => ({ category, entries: groups.get(category) ?? [] }));
};

export const countByStatus = (entries: readonly GalleryEntry[]): Record<MappingStatus, number> => {
  const counts: Record<MappingStatus, number> = { equivalent: 0, alternative: 0, none: 0 };
  for (const entry of entries) counts[entry.firefox.status] += 1;
  return counts;
};
