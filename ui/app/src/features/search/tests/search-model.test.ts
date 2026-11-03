import { describe, expect, it } from "vitest";
import {
  sameSearch,
  resultIdentity,
  resultHost,
  completionTarget,
  resultSection,
  groupRows,
  resultDetail,
  matchRange,
  completionSuffix,
  distinctResults,
} from "../lib/search-model";
import type { SearchContext, SearchResult } from "$shared/ipc/bindings";

const context = (session_id = "one", request_id = "one"): SearchContext => ({
  window_id: "window",
  session_id,
  request_id,
  profile_id: "p",
  space_id: "s",
});
const tab = (id: string, title = id): SearchResult => ({
  kind: "tab",
  title,
  detail: "example.com",
  icon: null,
  action: { type: "ActivateTab", id },
});

describe("search identity", () => {
  it("does not admit an ABA query from another session or profile", () => {
    expect(sameSearch(context(), context())).toBe(true);
    expect(sameSearch(context(), context("two"))).toBe(false);
    expect(sameSearch(context(), { ...context(), profile_id: "other" })).toBe(false);
    expect(sameSearch(context(), context("one", "two"))).toBe(false);
  });
  it("identifies a row by its action, so a retitled tab keeps its identity", () => {
    expect(resultIdentity(tab("a"))).toBe(resultIdentity(tab("a", "Changed title")));
    expect(resultIdentity(tab("a"))).not.toBe(resultIdentity(tab("b")));
  });
  it("keeps one row per action, so a bookmark and its visit cannot collide", () => {
    const page = (kind: SearchResult["kind"], title: string, url: string): SearchResult => ({
      kind,
      title,
      detail: url,
      icon: null,
      action: { type: "OpenUrl", url },
    });
    const visit = page("history", "visit", "https://example.com/x");
    const saved = page("bookmark", "saved", "https://example.com/x");
    const other = page("history", "other", "https://example.com/y");
    // Both rows lead to the same address, so they would share a list key and a
    // highlight. Native's order decides which spelling is kept.
    expect(distinctResults([visit, saved, other]).map((row) => row.title)).toEqual([
      "visit",
      "other",
    ]);
    expect(distinctResults([saved, visit]).map((row) => row.title)).toEqual(["saved"]);
    expect(distinctResults([tab("a"), tab("b")])).toHaveLength(2);
    expect(distinctResults([])).toEqual([]);
  });
});

describe("result presentation", () => {
  it("groups adjacent runs without reordering what native sent", () => {
    const rows = [
      { section: resultSection({ ...tab("x"), kind: "search" }) },
      { section: resultSection({ ...tab("x"), kind: "suggestion" }) },
      { section: resultSection(tab("a")) },
      { section: resultSection({ ...tab("x"), kind: "history" }) },
      { section: resultSection({ ...tab("x"), kind: "note" }) },
    ];
    expect(groupRows(rows).map((group) => group.section)).toEqual([
      "search",
      "tabs",
      "history",
      "notes",
    ]);
    // A bookmark leads the visited pages it ties with, in the same section.
    expect(resultSection({ ...tab("x"), kind: "bookmark" })).toBe("history");
    // Two runs of the same section stay two runs; grouping never gathers rows
    // across the list, which is what used to let a late result jump sections.
    const split = [
      { section: "tabs" as const },
      { section: "notes" as const },
      { section: "tabs" as const },
    ];
    expect(groupRows(split).map((group) => group.section)).toEqual(["tabs", "notes", "tabs"]);
  });
  it("shows the bare host as secondary text, and the engine for a search", () => {
    expect(resultDetail(tab("a"))).toBe("example.com");
    // Either spelling native may use for a host resolves the same way.
    expect(resultDetail({ ...tab("a"), detail: "https://www.example.com/x" })).toBe("example.com");
    expect(resultDetail({ ...tab("a"), detail: "www.example.com" })).toBe("example.com");
    expect(
      resultDetail({ ...tab("a"), kind: "bookmark", detail: "https://www.example.com/x" }),
    ).toBe("example.com");
    expect(resultDetail({ ...tab("a"), kind: "search", detail: "DuckDuckGo" })).toBe("DuckDuckGo");
    expect(resultDetail({ ...tab("a"), kind: "note", detail: "Pack the adapter" })).toBe(
      "Pack the adapter",
    );
  });
  it("emphasises one contiguous match and never fragments a title", () => {
    expect(matchRange("Rust Book", "rust")).toEqual([0, 4]);
    expect(matchRange("The Rust Book", "rust")).toEqual([4, 8]);
    expect(matchRange("Rust Book", "book rust")).toBeNull();
    expect(matchRange("Rust Book", "   ")).toBeNull();
  });
  it("maps expanded lowercase characters back to the original title", () => {
    expect(matchRange("İstanbul News", "news")).toEqual([9, 13]);
    expect(matchRange("İstanbul", "i")).toEqual([0, 1]);
    expect(matchRange("🙂İstanbul", "tan")).toEqual([4, 7]);
  });
  it("measures a match in right-to-left text and around emoji", () => {
    expect(matchRange("مثال عربي", "عربي")).toEqual([5, 9]);
    expect(matchRange("日本語のテキスト", "テキスト")).toEqual([4, 8]);
    // A surrogate pair is two units wide; the span still slices the title.
    expect(matchRange("🙂 Rust 🙂", "rust")).toEqual([3, 7]);
    expect("🙂 Rust 🙂".slice(3, 7)).toBe("Rust");
    // A mixed-direction title keeps the match where the query is.
    expect(matchRange("Rust — مثال", "مثال")).toEqual([7, 11]);
  });
});

describe("inline completion", () => {
  it("resolves the row a visible completion stands for", () => {
    const rows = [
      { result: { ...tab("a"), kind: "search", detail: "DuckDuckGo" } as SearchResult },
      { result: { ...tab("b"), detail: "www.notion.so" } as SearchResult },
    ];
    expect(resultHost(rows[1]!.result)).toBe("notion.so");
    // Once the field reads "notion.so" that is the destination on screen, so
    // Enter must open it rather than search the fragment that was typed.
    expect(completionTarget(rows, "notion.so")).toBe(rows[1]);
    expect(completionTarget(rows, "example.com")).toBeNull();
    expect(completionTarget(rows, null)).toBeNull();
  });

  it("only offers a strict extension of exactly what is typed", () => {
    expect(completionSuffix("git", "github.com")).toBe("hub.com");
    expect(completionSuffix("GIT", "github.com")).toBe("hub.com");
    expect(completionSuffix("github.com", "github.com")).toBeNull();
    expect(completionSuffix("gitl", "github.com")).toBeNull();
    expect(completionSuffix("", "github.com")).toBeNull();
    expect(completionSuffix("git", null)).toBeNull();
    // Sliced by what was typed, not by a folded copy: a host may be written
    // in another script, and the suffix is still just the remainder.
    expect(completionSuffix("日本", "日本語.jp")).toBe("語.jp");
    expect(completionSuffix("  git", "github.com")).toBeNull();
  });
});

type HostSearch = {
  resolve: (input: string) => { kind: "url" | "search"; url: string; query?: string } | null;
  Search: {
    newtabRun: (input: {
      action: unknown;
      context: unknown;
    }) => Promise<{ accepted: boolean; operation_id: string | null }>;
  };
};

/** The host decides what a typed field means, and the contract harness shares
 *  that exact module. It lives outside this app, so it is loaded by URL rather
 *  than bundled; the type above is the little of it these tests read. */
async function hostSearch(): Promise<HostSearch> {
  const url = new URL("../../../../../../overlay/astra/host/Search.sys.mjs", import.meta.url);
  return (await import(/* @vite-ignore */ url.href)) as HostSearch;
}

describe("what the host will navigate to", () => {
  it("opens a blank document and nothing else internal", async () => {
    const { resolve } = await hostSearch();
    expect(resolve("about:blank")).toMatchObject({ kind: "url", url: "about:blank" });
    // A parameter on a blank document is inert, so it stays a blank document.
    expect(resolve("about:blank?from=field")).toMatchObject({
      kind: "url",
      url: "about:blank?from=field",
    });
    // System-principal pages are words. Handing one to a content browser and
    // trusting the engine to refuse the load is not a boundary.
    for (const typed of [
      "about:config",
      "about:debugging",
      "about:addons",
      "ABOUT:CONFIG",
      "about:config#advanced",
      // Near misses that resolve to a different internal page.
      "about:blank/../config",
      "about://blank",
    ]) {
      expect(resolve(typed)?.kind, typed).toBe("search");
    }
  });

  it("searches the internal address it refuses, rather than dropping it", async () => {
    const { resolve } = await hostSearch();
    const refused = resolve("about:config");
    expect(refused?.url).toContain(encodeURIComponent("about:config"));
    expect(refused?.query).toBe("about:config");
  });

  it("still navigates the web and searches words", async () => {
    const { resolve } = await hostSearch();
    expect(resolve("https://example.com/a")).toMatchObject({ kind: "url" });
    expect(resolve("http://example.com/")).toMatchObject({ kind: "url" });
    expect(resolve("hello world")?.kind).toBe("search");
    expect(resolve("javascript:alert(1)")?.kind).toBe("search");
  });

  it("navigates local development hosts without a scheme", async () => {
    const { resolve } = await hostSearch();
    expect(resolve("localhost:3000")).toMatchObject({
      kind: "url",
      url: "http://localhost:3000/",
    });
    expect(resolve("127.0.0.1:8080")).toMatchObject({
      kind: "url",
      url: "http://127.0.0.1:8080/",
    });
    expect(resolve("localhost")).toMatchObject({ kind: "url", url: "http://localhost/" });
    expect(resolve("example.com:8443")).toMatchObject({
      kind: "url",
      url: "https://example.com:8443/",
    });
    // A colon that is not a host:port is still words.
    expect(resolve("note: buy milk")?.kind).toBe("search");
    expect(resolve("10:30")?.kind).toBe("search");
  });

  it("refuses an internal address arriving as a row's action", async () => {
    const { Search } = await hostSearch();
    // A result row is never an address the person typed, so the same policy
    // applies before any tab is asked to load it.
    const refused = await Search.newtabRun({
      action: { type: "OpenUrl", url: "about:config" },
      context: { session_id: "test" },
    });
    expect(refused.accepted).toBe(false);
  });
});
