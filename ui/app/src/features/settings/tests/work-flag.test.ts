import { expect, it, vi } from "vitest";

vi.mock("$shared/flags", () => ({ flags: { work: false } }));

import { preferences } from "$domain/preferences";
import {
  groups,
  searchSections,
  searchSettings,
  sections,
  shownSections,
} from "../lib/settings-model";

it("ships no Work page, switch or search entry when the flag is off", () => {
  expect(sections.some((section) => section.id === "work")).toBe(false);
  expect(shownSections().some((section) => section.id === "work")).toBe(false);
  expect(searchSettings("work").some((result) => result.target === "work.enabled")).toBe(false);
  expect(searchSections("work").some((section) => section.id === "work")).toBe(false);
  // The remaining pages in that group are AI's, so the heading is AI's too.
  expect(groups.find((group) => group.id === "work")?.label()).toBe("AI");
});

it("a stored Work preference cannot bring the surface back when the flag is off", () => {
  expect(preferences.enabled("work")).toBe(false);
});
