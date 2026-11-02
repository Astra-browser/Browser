import { describe, expect, it } from "vitest";
import {
  collectOmniboxSuggestions,
  completionSuffix,
  moveSelection,
  selectedId,
  hostOf,
  taskCommandRow,
  type OmniboxSources,
  type OmniboxSourceItem,
} from "../lib/omnibox-model";

const tab = (id: string, title: string, url = `https://example.com/${id}`): OmniboxSourceItem => ({
  id,
  title,
  url,
});
const visit = (id: string, title: string, url: string): OmniboxSourceItem => ({ id, title, url });
const note = (id: string, title: string): OmniboxSourceItem => ({
  id,
  title,
  url: `note://${id}`,
  detail: "matching line",
});

const sources = (): OmniboxSources => ({
  tabs: [tab("t1", "Rust documentation"), tab("t2", "Team calendar")],
  history: [
    visit("h1", "Rust borrow checker guide", "https://doc.rust-lang.org/borrow"),
    visit("h2", "Rust playground", "https://play.rust-lang.org/"),
  ],
  notes: [note("n1", "Rust learning notes"), note("n2", "Grocery list")],
});

describe("collectOmniboxSuggestions", () => {
  it("returns nothing for an empty query", () => {
    expect(collectOmniboxSuggestions("  ", sources(), { engineId: "duckduckgo" })).toEqual([]);
  });

  it("orders sections tabs, history, notes, then the search action", () => {
    const rows = collectOmniboxSuggestions("rust", sources(), { engineId: "duckduckgo" });
    const sections = rows.map((row) => row.source);
    expect(sections).toEqual(["tabs", "history", "history", "notes", "search"]);
    expect(rows.at(-1)).toMatchObject({ title: "rust", detail: "DuckDuckGo" });
  });

  it("points the search row at the engine url", () => {
    const rows = collectOmniboxSuggestions("rust", sources(), { engineId: "duckduckgo" });
    expect(rows.at(-1)?.url).toBe("https://duckduckgo.com/?q=rust");
  });

  it("shows only the search row when nothing local matches", () => {
    const rows = collectOmniboxSuggestions("qzxw", sources(), { engineId: "bing" });
    expect(rows.map((row) => row.source)).toEqual(["search"]);
    expect(rows[0]?.detail).toBe("Bing");
  });

  it("dedupes one address across sections with the tab winning", () => {
    const dup: OmniboxSources = {
      tabs: [tab("t1", "Playground", "https://play.rust-lang.org/")],
      history: [visit("h1", "Playground visit", "https://play.rust-lang.org/")],
      notes: [],
    };
    const rows = collectOmniboxSuggestions("play", dup, { engineId: "duckduckgo" });
    expect(rows.filter((row) => row.url === "https://play.rust-lang.org/")).toHaveLength(1);
    expect(rows[0]?.source).toBe("tabs");
  });

  it("respects per-source limits", () => {
    const many: OmniboxSources = {
      tabs: Array.from({ length: 10 }, (_, i) => tab(`t${i}`, `rust tab ${i}`)),
      history: [],
      notes: [],
    };
    const rows = collectOmniboxSuggestions("rust", many, {
      engineId: "duckduckgo",
      limits: { tabs: 2 },
    });
    expect(rows.filter((row) => row.source === "tabs")).toHaveLength(2);
  });

  it("supports custom engines and omits the row when unresolvable", () => {
    const withCustom = collectOmniboxSuggestions("rust", sources(), {
      engineId: "custom",
      customUrl: "https://example.com/search?q={searchTerms}",
    });
    expect(withCustom.at(-1)).toMatchObject({ source: "search", detail: "Custom search" });

    const broken = collectOmniboxSuggestions("rust", sources(), { engineId: "nope" });
    expect(broken.some((row) => row.source === "search")).toBe(false);
    expect(broken.length).toBeGreaterThan(0);
  });

  it("renders suggestions inside the typing budget on a large fixture", () => {
    const big: OmniboxSources = {
      tabs: Array.from({ length: 200 }, (_, i) => tab(`t${i}`, `rust tab number ${i}`)),
      history: Array.from({ length: 2000 }, (_, i) =>
        visit(`h${i}`, `visited rust page ${i}`, `https://example.com/rust/${i}`),
      ),
      notes: Array.from({ length: 500 }, (_, i) => note(`n${i}`, `rust note ${i}`)),
    };
    const start = performance.now();
    const rows = collectOmniboxSuggestions("rust", big, { engineId: "duckduckgo" });
    const elapsed = performance.now() - start;
    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("make-task command row", () => {
  it("leads with a task row for an explicit make-task command", () => {
    const rows = collectOmniboxSuggestions("make task Buy milk", sources(), {
      engineId: "duckduckgo",
    });
    expect(rows[0]).toMatchObject({
      id: "task:buy milk",
      source: "task",
      title: "Buy milk",
      detail: "Make task",
    });
    expect(rows.at(-1)?.source).toBe("search");
  });

  it("accepts create, add, new, and bare task commands", () => {
    for (const query of [
      "create task Buy milk",
      "add task Buy milk",
      "new task Buy milk",
      "task Buy milk",
    ]) {
      expect(taskCommandRow(query)).toMatchObject({ source: "task", title: "Buy milk" });
    }
  });

  it("ignores a bare command with no title and plain text", () => {
    expect(taskCommandRow("make task")).toBeNull();
    expect(taskCommandRow("make task   ")).toBeNull();
    expect(taskCommandRow("rust")).toBeNull();
    expect(taskCommandRow("tasking along")).toBeNull();
    const rows = collectOmniboxSuggestions("rust", sources(), { engineId: "duckduckgo" });
    expect(rows.some((row) => row.source === "task")).toBe(false);
  });

  it("trims the title and keeps it on one line of the row", () => {
    expect(taskCommandRow("  make task   Buy milk  ")).toMatchObject({ title: "Buy milk" });
  });
});

describe("keyboard navigation", () => {
  it("moves down to the last row and stays there", () => {
    expect(moveSelection(3, -1, "down")).toBe(0);
    expect(moveSelection(3, 2, "down")).toBe(2);
  });

  it("moves up back to the typed row and stays there", () => {
    expect(moveSelection(3, 0, "up")).toBe(-1);
    expect(moveSelection(3, -1, "up")).toBe(-1);
  });

  it("jumps home and end", () => {
    expect(moveSelection(3, 1, "home")).toBe(-1);
    expect(moveSelection(3, -1, "end")).toBe(2);
  });

  it("selects the typed row when there is nothing to move through", () => {
    expect(moveSelection(0, -1, "down")).toBe(-1);
  });

  it("resolves the active row id", () => {
    const rows = collectOmniboxSuggestions("rust", sources(), { engineId: "duckduckgo" });
    expect(selectedId(rows, -1)).toBe("typed");
    expect(selectedId(rows, 0)).toBe(rows[0]?.id);
    expect(selectedId(rows, 99)).toBe("typed");
  });
});

describe("completion and hosts", () => {
  it("completes only a strict extension of the typed text", () => {
    expect(completionSuffix("rust-l", "rust-lang.org")).toBe("ang.org");
    expect(completionSuffix("rust", "rust")).toBeNull();
    expect(completionSuffix("go", "rust-lang.org")).toBeNull();
    expect(completionSuffix("", "rust-lang.org")).toBeNull();
    expect(completionSuffix("rust", null)).toBeNull();
  });

  it("shows the bare host without www", () => {
    expect(hostOf("https://www.rust-lang.org/learn")).toBe("rust-lang.org");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
