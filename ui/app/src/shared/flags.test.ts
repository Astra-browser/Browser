import { describe, expect, it } from "vitest";
import { isOn } from "./flags";

describe("build flags", () => {
  it("is off unless the value is exactly true", () => {
    expect(isOn(undefined)).toBe(false);
    expect(isOn("")).toBe(false);
    expect(isOn("1")).toBe(false);
    expect(isOn("false")).toBe(false);
    expect(isOn("TRUE")).toBe(false);
    expect(isOn("true")).toBe(true);
  });
});
