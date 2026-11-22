/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  BROWSER_PAGES,
  PAGE_SURFACES,
  SURFACES,
  TOOL_KINDS,
  TOOL_SURFACES,
  isBrowserPage,
  isToolKind,
  toolSurface,
  type BrowserPage,
  type SurfaceKind,
  type SurfaceRow,
} from "..";

describe("surface registry", () => {
  it("derives each id list from its rows, without duplicates in a kind", () => {
    expect(BROWSER_PAGES).toEqual(PAGE_SURFACES.map((row) => row.id));
    expect(TOOL_KINDS).toEqual(TOOL_SURFACES.map((row) => row.id));
    expect(new Set(BROWSER_PAGES).size).toBe(BROWSER_PAGES.length);
    expect(new Set(TOOL_KINDS).size).toBe(TOOL_KINDS.length);
    const kinds: SurfaceKind[] = ["page", "tool"];
    expect(SURFACES.every((row) => kinds.includes(row.kind))).toBe(true);
  });

  it("classifies only the ids the rows own", () => {
    const page: BrowserPage = "settings";
    expect(isBrowserPage(page)).toBe(true);
    expect(isBrowserPage("ai")).toBe(false);
    expect(isToolKind("ai")).toBe(true);
    expect(isToolKind("settings")).toBe(false);
  });

  it("lets one id be both a page and a tool", () => {
    expect(PAGE_SURFACES.some((row) => row.id === "downloads")).toBe(true);
    expect(TOOL_SURFACES.some((row) => row.id === "downloads")).toBe(true);
    expect(toolSurface("notes").loader).toBe(toolSurface("tasks").loader);
  });

  it("gives every row a loader and a written name", () => {
    const rows: readonly SurfaceRow[] = SURFACES;
    for (const row of rows) {
      expect(typeof row.loader).toBe("function");
      expect(row.labelKey.length).toBeGreaterThan(0);
    }
  });
});
