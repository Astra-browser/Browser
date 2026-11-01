import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { browserMark } from "../browsers";

// Cross-boundary contract test: the mark catalog must cover every browser the
// native importer supports. `crates/astra-import` lands in Phase 2 (P4-T05);
// until then this test skips instead of failing on a missing artifact.
const NATIVE = new URL("../../../crates/astra-import/src/lib.rs", import.meta.url);

test.skipIf(!existsSync(NATIVE))("every browser native import supports has its own bundled mark", () => {
  const native = readFileSync(NATIVE, "utf8");
  const ids = [...native.matchAll(/Browser::\w+ => "([a-z-]+)"/gu)].map((match) => match[1]!);
  expect(ids.length).toBeGreaterThan(0);
  const marks = ids.map((id) => {
    const mark = browserMark(id);
    expect(mark, id).not.toBeNull();
    return mark!.light;
  });
  expect(new Set(marks).size).toBe(ids.length);
  expect(browserMark("unknown-browser")).toBeNull();
});
