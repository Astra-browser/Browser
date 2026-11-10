import { expect, test } from "vitest";
import { normalizeHomeUrl } from "../lib/home-url";

test("a bare host becomes an https address", () => {
  expect(normalizeHomeUrl("example.com")).toBe("https://example.com");
  expect(normalizeHomeUrl("  sub.example.co.uk/path?q=1  ")).toBe(
    "https://sub.example.co.uk/path?q=1",
  );
});

test("a full http(s) address is kept as written", () => {
  expect(normalizeHomeUrl("http://example.com")).toBe("http://example.com");
  expect(normalizeHomeUrl("https://example.com/home")).toBe("https://example.com/home");
});

test("an empty home is allowed; words and other schemes are not", () => {
  expect(normalizeHomeUrl("   ")).toBe("");
  expect(normalizeHomeUrl("my home page")).toBeNull();
  expect(normalizeHomeUrl("localhost")).toBeNull();
  expect(normalizeHomeUrl("javascript:alert(1)")).toBeNull();
  expect(normalizeHomeUrl("file:///etc/passwd")).toBeNull();
});
