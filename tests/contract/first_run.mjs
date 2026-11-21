#!/usr/bin/env node
// Contract test: first-run onboarding is reachable.
//
//   - the decision: a fresh profile opens it, a completed one does not, and a
//     private window never does (and never records it);
//   - `onboarding_finish` is routed to a host method that persists completion
//     through the settings store and refuses a private window;
//   - the page is staged beside the browser document and jar.mn-registered,
//     with no inline script or absolute/remote asset URL (chrome CSP);
//   - the browser document hands the frame over before mounting its UI;
//   - appearance has one spelling (`appearance.theme`, the key astra-core
//     validates) with a read-only migration from the old `appearance`.
//
// Usage: node tests/contract/first_run.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const bootModule = await import(pathToFileURL(path.join(HOST, "Boot.sys.mjs")).href);
const settingsModule = await import(pathToFileURL(path.join(HOST, "Settings.sys.mjs")).href);
const { Boot, onboardingDecision, onboardingPending, ONBOARDING_KEY } = bootModule;
const { Settings, __resetSettingsForTests, __setPrefsForTests } = settingsModule;

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
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

// === The decision =========================================================
check("the completion key is the one astra-core validates", ONBOARDING_KEY === "onboarding.completed");
check("a fresh profile opens onboarding", onboardingDecision({ completed: null }).open === true);
check(
  "the fresh reason is first-run",
  onboardingDecision({ completed: null }).reason === "first-run",
);
check("a stored 'false' still opens onboarding", onboardingDecision({ completed: "false" }).open === true);
check("a completed profile skips onboarding", onboardingDecision({ completed: "true" }).open === false);
check(
  "the completed reason is completion",
  onboardingDecision({ completed: "true" }).reason === "completed",
);
check(
  "a private window never opens onboarding, fresh or completed",
  onboardingDecision({ completed: null, isPrivate: true }).open === false &&
    onboardingDecision({ completed: "false", isPrivate: true }).open === false &&
    onboardingDecision({ completed: "true", isPrivate: true }).open === false,
);
check(
  "the private reason is private",
  onboardingDecision({ completed: null, isPrivate: true }).reason === "private",
);

// The store-backed read agrees with the rule.
__resetSettingsForTests();
check("the store decides: fresh profile is pending", onboardingPending() === true);
check(
  "the store decides: a private window is not pending",
  onboardingPending({ isPrivate: true }) === false,
);

// === Finish: persist, close the page, refuse private ======================
__resetSettingsForTests();
const finished = await Boot.onboardingFinish({ request_id: "onb-fresh" });
check("finishing a fresh flow is accepted", finished === true);
check(
  "finishing persists the completion flag",
  (await Settings.get({ key: ONBOARDING_KEY })) === "true",
);
check(
  "after finishing, the next run goes straight to the browser",
  onboardingPending() === false,
);

__resetSettingsForTests();
await Settings.set({ key: ONBOARDING_KEY, value: "false" });
const privateFinish = await Boot.onboardingFinish({ request_id: "onb-private", isPrivate: true });
check("a private window's finish is refused", privateFinish === false);
check(
  "a private window never records completion",
  (await Settings.get({ key: ONBOARDING_KEY })) === "false",
);

// A store that refuses the write keeps the page open (no false success).
__resetSettingsForTests();
__setPrefsForTests({
  getBoolPref: () => false,
  setBoolPref: () => {},
  getStringPref: () => {
    throw new Error("unreadable");
  },
  setStringPref: () => {
    throw new Error("refused");
  },
  addObserver: () => {},
  removeObserver: () => {},
});
const refused = await Boot.onboardingFinish({ request_id: "onb-refused" });
check("a refused store write is not a success", refused === false);
__setPrefsForTests(null);

// === Routing ==============================================================
const { COMMAND_MANIFEST } = await import(
  pathToFileURL(path.join(ROOT, "ui", "packages", "bridge", "src", "manifest.ts")).href
);
const onboardingRoute = COMMAND_MANIFEST.find((entry) => entry.name === "onboarding_finish");
check(
  "onboarding_finish routes to a host method",
  onboardingRoute?.module === "Boot" && onboardingRoute?.method === "onboardingFinish",
);
check(
  "the route target exists",
  typeof bootModule.Boot.onboardingFinish === "function",
);
const baseline = JSON.parse(await read("tests/contract/wire_baseline.json"));
check(
  "onboarding_finish is no longer a known gap",
  !(baseline.unrouted ?? []).includes("onboarding_finish"),
);

// === The page is opened before the browser UI =============================
const browserEntry = await read("ui/app/chrome-entry/browser-chrome.ts");
const redirectAt = browserEntry.indexOf('window.location.replace(ONBOARDING_PAGE)');
const mountAt = browserEntry.indexOf("mount(App");
check("the browser document reads the completion flag", browserEntry.includes('"setting_get"'));
check("it reads the canonical completion key", browserEntry.includes('"onboarding.completed"'));
check("it hands the frame to onboarding.html", browserEntry.includes('"./onboarding.html"'));
check("it never shows onboarding in a private window", browserEntry.includes("inPrivateWindow()"));
check(
  "the hand-off happens before the browser UI mounts",
  redirectAt > 0 && mountAt > 0 && redirectAt < mountAt,
);

const onboardingEntry = await read("ui/app/src/entries/onboarding.ts");
check("the onboarding document configures the bridge", onboardingEntry.includes("ensureBridge"));
check(
  "the onboarding document announces readiness to the shell",
  onboardingEntry.includes('kind: "ready"'),
);

// === Staging ==============================================================
const staged = path.join(ROOT, "overlay", "astra", "chrome", "app", "onboarding.html");
let stagedHtml = null;
try {
  stagedHtml = await readFile(staged, "utf8");
} catch {
  stagedHtml = null;
}
check(
  "the onboarding document is staged into the chrome app",
  stagedHtml !== null,
);
const jar = await read("overlay/astra/jar.mn");
check(
  "jar.mn registers the staged onboarding document",
  jar.includes("content/astra/app/onboarding.html (chrome/app/onboarding.html)"),
);
if (stagedHtml !== null) {
  const scripts = [...stagedHtml.matchAll(/<script\b([^>]*)>/giu)].map((match) => match[1]);
  const inline = scripts.filter((attrs) => !/\bsrc\s*=/iu.test(attrs));
  const absolute = [...stagedHtml.matchAll(/\b(?:src|href)\s*=\s*["'](\/[^/"'])/giu)];
  const remote = [...stagedHtml.matchAll(/\b(?:src|href)\s*=\s*["']https?:\/\//giu)];
  check("the staged document has an external script", scripts.length > 0);
  check("the staged document has no inline script", inline.length === 0);
  check("the staged document uses relative asset URLs", absolute.length === 0);
  check("the staged document has no remote assets", remote.length === 0);
}

const packageJson = JSON.parse(await read("ui/app/package.json"));
const buildChrome = packageJson.scripts?.["build:chrome"] ?? "";
check(
  "build:chrome runs the onboarding build",
  buildChrome.includes("vite.onboarding.config.ts") && buildChrome.includes("--mode chrome"),
);
const stageScript = await read("ui/app/scripts/stage-chrome.mjs");
check(
  "staging refuses a build without onboarding.html",
  stageScript.includes('"onboarding.html"'),
);

// === One appearance spelling =============================================
const firstRun = await read("ui/app/src/features/welcome/lib/first-run.ts");
check(
  "the welcome flow writes the core-validated key",
  /THEME_KEY\s*=\s*"appearance\.theme"/u.test(firstRun),
);
check(
  "the old spelling is kept only as a legacy read",
  /LEGACY_THEME_KEY\s*=\s*"appearance"/u.test(firstRun) &&
    firstRun.includes("settingGet(LEGACY_THEME_KEY)") &&
    !firstRun.includes("settingSet(LEGACY_THEME_KEY"),
);
check(
  "the page's first-run rule matches the host's",
  /completed !== "true"/u.test(firstRun) && /shouldOpenOnboarding/u.test(firstRun),
);

const theme = await read("ui/app/src/domain/appearance/theme.ts");
check(
  "the appearance picker reads the core-validated key",
  /APPEARANCE_KEY\s*=\s*"appearance\.theme"/u.test(theme) &&
    theme.includes("settingGet(APPEARANCE_KEY)") &&
    theme.includes("settingSet(APPEARANCE_KEY"),
);
check(
  "the picker still reads the old spelling once to migrate it",
  /LEGACY_APPEARANCE_KEY\s*=\s*"appearance"/u.test(theme) &&
    theme.includes("settingGet(LEGACY_APPEARANCE_KEY)") &&
    !theme.includes("settingSet(LEGACY_APPEARANCE_KEY"),
);
check(
  "the picker no longer writes the old spelling",
  !theme.includes('settingSet("appearance"'),
);

const preferences = await read("ui/app/src/domain/preferences/preferences.svelte.ts");
check(
  "the preferences surface stores the same key",
  /"appearance\.theme":\s*"light"/u.test(preferences),
);

const core = await read("crates/astra-core/src/settings.rs");
check(
  "astra-core validates both keys",
  core.includes('key: "appearance.theme"') && core.includes('key: "onboarding.completed"'),
);

// === Honest flags ========================================================
const flow = await read("ui/app/src/features/onboarding/lib/flow.ts");
check(
  "the onboarding Work step follows the build flag",
  /flags\.work/u.test(flow) && /step === "work"\)\s*return ai && work/u.test(flow),
);
const windowComponent = await read("ui/app/src/features/onboarding/components/Window.svelte");
check(
  "the illustrated window offers Work only when the build ships it",
  /\{#if modes\}<span class="on">/u.test(windowComponent),
);

// Test seams: a probe profile and an explicit override. `Services` does not
// exist in Node, so these checks install a fake around the call.
{
  const saved = globalThis.Services;
  const fake = (force, automation) => ({
    prefs: {
      getStringPref: () => force,
      prefHasUserValue: (name) => automation && name === "marionette.port",
    },
  });
  try {
    globalThis.Services = fake("skip", false);
    check("a forced skip keeps onboarding closed", onboardingDecision({ completed: null }).open === false);
    check(
      "the forced skip reason is named",
      onboardingDecision({ completed: null }).reason === "forced-skip",
    );
    globalThis.Services = fake("show", true);
    check(
      "an explicit show wins over an automation profile",
      onboardingDecision({ completed: "true" }).open === true,
    );
    globalThis.Services = fake("", true);
    check(
      "an automation profile skips onboarding",
      onboardingDecision({ completed: null }).open === false,
    );
    check(
      "the automation reason is named",
      onboardingDecision({ completed: null }).reason === "automation",
    );
    // A Marionette-driven chrome window reports webdriver even with no port
    // preference of its own.
    const savedDoc = globalThis.document;
    try {
      globalThis.Services = fake("", false);
      globalThis.document = { defaultView: { navigator: { webdriver: true } } };
      check(
        "a webdriver window skips onboarding",
        onboardingDecision({ completed: null }).open === false &&
          onboardingDecision({ completed: null }).reason === "automation",
      );
    } finally {
      if (savedDoc === undefined) delete globalThis.document;
      else globalThis.document = savedDoc;
    }
    globalThis.Services = fake("", false);
    check(
      "a real fresh profile still opens onboarding",
      onboardingDecision({ completed: null }).open === true,
    );
  } finally {
    if (saved === undefined) delete globalThis.Services;
    else globalThis.Services = saved;
  }
}

console.log(`\nfirst run: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
