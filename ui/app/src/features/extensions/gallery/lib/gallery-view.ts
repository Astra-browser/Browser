/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Gallery presentation model (P4-T04). Self-contained view types: the data
// itself lives in $domain/extensions (gallery-data.ts); whoever renders
// these components maps domain entries to GalleryViewEntry props. Keeping
// this module dependency-free lets the gallery render before (and without)
// the bridge.

export type GalleryStatus = "equivalent" | "alternative" | "none";

export type GalleryViewEntry = {
  chromeStoreId: string;
  name: string;
  category: string;
  status: GalleryStatus;
  /** AMO slug, if any. */
  slug: string | null;
  /** Direct install href, or null when there is no Firefox version. */
  installHref: string | null;
  /** Mapping note from the research (docs/astra/EXTENSIONS.md). */
  note: string;
  installed: boolean;
};

export type GalleryViewGroup = {
  category: string;
  entries: GalleryViewEntry[];
};

export const statusBadge = (status: GalleryStatus): string =>
  status === "equivalent"
    ? "Firefox equivalent"
    : status === "alternative"
      ? "Closest Firefox alternative"
      : "No Firefox version";

export const categoryTitle = (category: string): string =>
  category.length === 0 ? category : category[0]!.toUpperCase() + category.slice(1);

/** Button label for the entry's install action. */
export const installLabel = (entry: Pick<GalleryViewEntry, "status" | "installed">): string => {
  if (entry.installed) return "Installed";
  return entry.status === "none" ? "Chrome-only" : "Get for Firefox";
};

export const canInstall = (entry: Pick<GalleryViewEntry, "status" | "installHref">): boolean =>
  entry.status !== "none" && entry.installHref !== null;
