#!/usr/bin/env node
// P8 contract test: the Source page host module.
//
// The engine read is injected; this pins the wire behaviour:
//   - no driver, no tab id, a throwing driver or a null result -> null
//   - a result is bounded to MAX_SOURCE_CHARS and reports truncation
//   - the url is echoed, non-string text becomes empty
//
// Usage: node tests/contract/page_source_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { PageSource, setDriver, pageSource, MAX_SOURCE_CHARS, __resetPageSourceForTests } =
  await import(path.join(HOST, "PageSource.sys.mjs"));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

__resetPageSourceForTests();
check("a missing driver answers null", (await pageSource({ tab_id: "tab-1" })) === null);

setDriver(async (tabId) => ({ url: `https://${tabId}.example/`, text: "<p>hello</p>" }));
check("a driver result keeps the url", (await pageSource({ tab_id: "a" })).url === "https://a.example/");
check("a driver result keeps the text", (await pageSource({ tab_id: "a" })).text === "<p>hello</p>");
check("a short document is not truncated", (await pageSource({ tab_id: "a" })).truncated === false);
check("an empty tab id is refused", (await pageSource({ tab_id: "" })) === null);
check("a non-string tab id is refused", (await pageSource({ tab_id: 7 })) === null);
check("no args is refused", (await pageSource()) === null);

setDriver(async () => ({ url: "https://big.example/", text: "x".repeat(MAX_SOURCE_CHARS + 10) }));
const big = await pageSource({ tab_id: "big" });
check("a long document is cut to the bound", big.text.length === MAX_SOURCE_CHARS);
check("a long document reports truncation", big.truncated === true);

setDriver(async () => ({ url: "https://x.example/", text: 42, truncated: true }));
const odd = await pageSource({ tab_id: "x" });
check("non-string text becomes empty", odd.text === "");
check("a driver's truncation flag survives", odd.truncated === true);

setDriver(async () => null);
check("a null driver result becomes null", (await pageSource({ tab_id: "x" })) === null);
setDriver(async () => {
  throw new Error("read failed");
});
check("a throwing driver never escapes", (await pageSource({ tab_id: "x" })) === null);
setDriver("not a function");
check("a non-function driver is ignored", PageSource.setDriver != null && (await pageSource({ tab_id: "x" })) === null);

setDriver(async (tabId) => ({ url: "u", text: tabId }));
check("the module exposes the same function", (await PageSource.pageSource({ tab_id: "z" })).text === "z");

// === One driver per window ================================================
setDriver(async (tabId) => ({ url: "normal", text: tabId }), "win-1");
setDriver(async (tabId) => ({ url: "private", text: tabId }), "win-2");
check(
  "each window's driver answers its own tab",
  (await pageSource({ tab_id: "a", window_id: "win-1" })).url === "normal" &&
    (await pageSource({ tab_id: "a", window_id: "win-2" })).url === "private",
);
check(
  "a window with no driver is not served by another window's driver",
  (await pageSource({ tab_id: "a", window_id: "win-3" })) === null,
);
check(
  "a window call does not fall back to the standalone driver",
  (await pageSource({ tab_id: "a", window_id: "win-9" })) === null,
);
setDriver(null, "win-2");
check(
  "clearing one window leaves the other's driver installed",
  (await pageSource({ tab_id: "a", window_id: "win-2" })) === null &&
    (await pageSource({ tab_id: "a", window_id: "win-1" })).url === "normal",
);
setDriver(null);
check(
  "a direct caller with one live window is served that window",
  (await pageSource({ tab_id: "a" })).url === "normal",
);

__resetPageSourceForTests();
check("reset clears the driver", (await pageSource({ tab_id: "z" })) === null);

console.log(
  `\npage source contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
