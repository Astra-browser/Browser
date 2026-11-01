import { describe, expect, it } from "vitest";
import { scoreMatch, rank } from "../lib/ranking";

/** Vectors mirror `astra_core::search` tests (P2-T01): the UI port must order
 *  exactly like the core the launcher path uses. */
describe("scoreMatch parity with core", () => {
  it("prefix beats scattered", () => {
    const got = rank("git", ["legitimate", "github", "digest"], (s) => s).map(
      (entry) => entry.value,
    );
    expect(got[0]).toBe("github");
    expect(got).not.toContain("digest");
  });

  it("contiguous beats split runs", () => {
    const [best] = rank("ab", ["a-b", "ab"], (s) => s);
    expect(best?.value).toBe("ab");
  });

  it("empty query matches everything with zero", () => {
    expect(scoreMatch("", "anything")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreMatch("ASTRA", "astra-browser")).not.toBeNull();
  });

  it("drops non-subsequences", () => {
    expect(scoreMatch("xyz", "abc")).toBeNull();
  });

  it("drops queries longer than the candidate", () => {
    expect(scoreMatch("abcdef", "abc")).toBeNull();
  });

  it("prefers the earlier hit on ties", () => {
    const [best] = rank("a", ["ba", "ca", "aa"], (s) => s);
    expect(best?.value).toBe("aa");
  });
});

describe("rank", () => {
  it("returns best first with scores", () => {
    const got = rank("git", ["legitimate", "github"], (s) => s);
    expect(got[0]?.value).toBe("github");
    expect(got[0]?.score).toBeGreaterThan(got[1]?.score ?? 0);
  });

  it("maps over objects with a text projection", () => {
    const got = rank("rust", [{ title: "Rust docs" }, { title: "cooking" }], (item) => item.title);
    expect(got.map((entry) => entry.value.title)).toEqual(["Rust docs"]);
  });
});
