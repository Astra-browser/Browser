import { describe, expect, it } from "vitest";
import { neighbour, position, WELCOME_STEPS, type WelcomeStep } from "../index";

describe("welcome steps", () => {
  it("walks welcome, profile, theme, import-stub, then done", () => {
    expect(WELCOME_STEPS).toEqual(["welcome", "profile", "theme", "import", "done"]);
  });

  it("advances through every step in order", () => {
    let step: WelcomeStep = "welcome";
    const walked: WelcomeStep[] = [step];
    for (;;) {
      const next = neighbour(step, 1);
      if (!next) break;
      walked.push(next);
      step = next;
    }
    expect(walked).toEqual(["welcome", "profile", "theme", "import", "done"]);
  });

  it("counts from the first real step, welcome being the door", () => {
    expect(position("welcome")).toEqual({ at: 0, of: 4 });
    expect(position("profile")).toEqual({ at: 1, of: 4 });
    expect(position("import")).toEqual({ at: 3, of: 4 });
    expect(position("done")).toEqual({ at: 4, of: 4 });
  });

  it("never steps back through the door or past the end", () => {
    expect(neighbour("profile", -1)).toBeUndefined();
    expect(neighbour("welcome", 1)).toBe("profile");
    expect(neighbour("done", 1)).toBeUndefined();
    expect(neighbour("done", -1)).toBe("import");
  });
});
