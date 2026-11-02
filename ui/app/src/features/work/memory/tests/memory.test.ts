import { expect, test } from "vitest";
import { scopeLabel, searchMemories, type MemoryEntry } from "../lib/memory";

const entries: MemoryEntry[] = [
  { id: "a", scope: "global", content: "prefers dark mode", updatedAt: 30 },
  {
    id: "b",
    scope: "site",
    content: "keyboards keyboards keyboards",
    updatedAt: 10,
    site: "shop.example",
  },
  { id: "c", scope: "ephemeral", content: "scratch note", updatedAt: 50 },
];

test("blank queries list everything newest-first", () => {
  const ids = searchMemories(entries, "  ").map(({ entry }) => entry.id);
  expect(ids).toEqual(["c", "a", "b"]);
});

test("content hits outrank scope-only rows and recency breaks ties", () => {
  const hits = searchMemories(entries, "keyboards");
  expect(hits.map(({ entry }) => entry.id)).toEqual(["b"]);
  expect(hits[0]!.rank).toBeGreaterThan(0);

  const scoped: MemoryEntry[] = [
    { id: "old", scope: "global", content: "same words here", updatedAt: 5 },
    { id: "new", scope: "global", content: "same words here", updatedAt: 9 },
  ];
  expect(searchMemories(scoped, "same").map(({ entry }) => entry.id)).toEqual(["new", "old"]);
});

test("search is case-insensitive and matches scope text", () => {
  expect(searchMemories(entries, "SCRATCH").map(({ entry }) => entry.id)).toEqual(["c"]);
  expect(searchMemories(entries, "site").map(({ entry }) => entry.id)).toEqual(["b"]);
});

test("scope labels read back for known and unknown scopes", () => {
  expect(scopeLabel("global")).toBe("Everywhere");
  expect(scopeLabel("site")).toBe("This site");
  expect(scopeLabel("ephemeral")).toBe("Scratch");
  expect(scopeLabel("custom")).toBe("custom");
});
