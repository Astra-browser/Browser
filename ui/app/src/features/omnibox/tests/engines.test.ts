import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SEARCH_ENGINES,
  DEFAULT_ENGINE_ID,
  getEngine,
  isValidSearchTemplate,
  fillSearchTemplate,
  buildSearchUrl,
  buildSuggestUrl,
} from "../lib/engines";

describe("engine table", () => {
  it("lists the four settings engines with https templates", () => {
    expect(SEARCH_ENGINES.map((engine) => engine.id)).toEqual([
      "duckduckgo",
      "google",
      "bing",
      "brave",
    ]);
    for (const engine of SEARCH_ENGINES) {
      expect(engine.searchUrl).toContain("{searchTerms}");
      expect(new URL(engine.searchUrl.replace("{searchTerms}", "q")).protocol).toBe("https:");
      if (engine.suggestUrl) {
        expect(engine.suggestUrl).toContain("{searchTerms}");
        expect(new URL(engine.suggestUrl.replace("{searchTerms}", "q")).protocol).toBe("https:");
      }
    }
  });

  it("defaults to Google like the search.engine preference", () => {
    expect(DEFAULT_ENGINE_ID).toBe("google");
    expect(getEngine(DEFAULT_ENGINE_ID)?.name).toBe("Google");
  });

  it("returns null for unknown engines", () => {
    expect(getEngine("firefox")).toBeNull();
  });
});

describe("url building", () => {
  it("encodes the query into the template", () => {
    const url = buildSearchUrl(getEngine("duckduckgo"), "", "hello world & more");
    expect(url).toBe("https://duckduckgo.com/?q=hello%20world%20%26%20more");
  });

  it("resolves custom engines through the custom url", () => {
    const url = buildSearchUrl(null, "https://example.com/search?q={searchTerms}", "tea");
    expect(url).toBe("https://example.com/search?q=tea");
  });

  it("returns null when nothing resolves", () => {
    expect(buildSearchUrl(null, "", "tea")).toBeNull();
    expect(buildSearchUrl(null, "not a template", "tea")).toBeNull();
    expect(buildSearchUrl(getEngine("google"), "", "   ")).toBeNull();
  });

  it("builds suggestion urls only for engines that offer them", () => {
    expect(buildSuggestUrl(getEngine("brave"), "as")).toContain("search.brave.com");
    expect(buildSuggestUrl(null, "as")).toBeNull();
    expect(buildSuggestUrl(getEngine("bing"), "  ")).toBeNull();
  });
});

describe("template validation", () => {
  it("accepts one token in the query string", () => {
    expect(isValidSearchTemplate("https://example.com/search?q={searchTerms}")).toBe(true);
  });

  it("rejects missing, doubled, http, or host tokens", () => {
    expect(isValidSearchTemplate("https://example.com/search?q=tea")).toBe(false);
    expect(isValidSearchTemplate("https://example.com/?a={searchTerms}&b={searchTerms}")).toBe(
      false,
    );
    expect(isValidSearchTemplate("http://example.com/search?q={searchTerms}")).toBe(false);
    expect(isValidSearchTemplate("https://{searchTerms}.example.com/?q=x")).toBe(false);
    expect(isValidSearchTemplate("not a url {searchTerms}")).toBe(false);
    expect(isValidSearchTemplate("")).toBe(false);
  });

  it("fill returns null for invalid templates", () => {
    expect(fillSearchTemplate("https://example.com/?q=x", "tea")).toBeNull();
  });
});

describe("local-only engine configuration", () => {
  const ALLOWED_HOSTS = new Set([
    "duckduckgo.com",
    "www.google.com",
    "suggestqueries.google.com",
    "www.bing.com",
    "search.brave.com",
  ]);

  it("touches only the builtin engine hosts", () => {
    for (const engine of SEARCH_ENGINES) {
      for (const raw of [engine.searchUrl, engine.suggestUrl ?? null]) {
        if (!raw) continue;
        const host = new URL(raw.replace("{searchTerms}", "q")).hostname;
        expect(ALLOWED_HOSTS.has(host)).toBe(true);
      }
    }
  });

  it("mentions no remote configuration endpoint anywhere in the table", () => {
    const serialised = JSON.stringify(SEARCH_ENGINES).toLowerCase();
    expect(serialised).not.toContain("mozilla");
    expect(serialised).not.toContain("remote");
    expect(serialised).not.toContain("settings");
  });

  it("contains no remote-settings dependency in shipped omnibox sources", () => {
    // Tokens are assembled from parts so this file never matches a scan that
    // included it (the same trick brand-lint uses for its own pattern). Only
    // shipped code is scanned: lib/ and components/, never tests/.
    const forbidden = [
      ["remote", "settings"].join("-"),
      ["services", "settings"].join("."),
      ["firefox", "settings"].join("."),
      ["XMLHttp", "Request"].join(""),
      ["mo", "zilla"].join(""),
      ["fet", "ch("].join(""),
    ];
    const sources: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = `${path}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|svelte)$/u.test(entry.name)) sources.push(full);
      }
    };
    const root = new URL("..", import.meta.url);
    walk(fileURLToPath(new URL("lib", root)));
    walk(fileURLToPath(new URL("components", root)));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const token of forbidden) {
        expect(text, `${file} mentions ${token}`).not.toContain(token);
      }
    }
  });
});
