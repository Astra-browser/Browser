import { describe, expect, it } from "vitest";
import { hasScheme, looksLikeAddress } from "../address";

describe("looksLikeAddress", () => {
  it("reads a scheme as an address", () => {
    for (const typed of [
      "http://localhost:3000",
      "https://example.com/a",
      "HTTP://EXAMPLE.COM",
      "about:blank",
    ]) {
      expect(looksLikeAddress(typed), typed).toBe(true);
    }
  });

  it("reads local development hosts without a scheme", () => {
    for (const typed of [
      "localhost:3000",
      "localhost",
      "127.0.0.1:8080",
      "localhost/health",
      "localhost:3000/app?dev=1",
      "[::1]:3000",
    ]) {
      expect(looksLikeAddress(typed), typed).toBe(true);
    }
  });

  it("reads a host and port as an address", () => {
    expect(looksLikeAddress("example.com:8443")).toBe(true);
    expect(looksLikeAddress("example.com")).toBe(true);
  });

  it("leaves words, bangs and clock times to the engine", () => {
    for (const typed of [
      "",
      "   ",
      "hello world",
      "rust",
      "note: buy milk",
      "10:30",
      "10:30 standup",
      "!g example.com",
      "javascript:alert(1)",
    ]) {
      expect(looksLikeAddress(typed), typed).toBe(false);
    }
  });
});

describe("hasScheme", () => {
  it("names the lines whose scheme the host decides", () => {
    expect(hasScheme("http://localhost:3000")).toBe(true);
    expect(hasScheme("mailto:a@b.c")).toBe(true);
    expect(hasScheme("javascript:alert(1)")).toBe(true);
    expect(hasScheme("10:30")).toBe(false);
    expect(hasScheme("hello world")).toBe(false);
  });
});
