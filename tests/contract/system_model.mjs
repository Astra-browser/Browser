#!/usr/bin/env node
// System module contract (wiring): `about_info`, `system_clock_24h`,
// `update_status`, `update_check`, `default_browser_status`,
// `login_item_status`, `ui_info` and `set_content_color_scheme` answer the UI
// natively instead of failing with `unknown_command`.
//
//   - every answer is the shape `ui/app/src/shared/ipc/bindings.ts` declares,
//     and carries no key the type does not have
//   - `system_clock_24h` is a real local read: it agrees with this process's
//     own `Intl` hour cycle, and is `null` only when that names none
//   - `ui_info` answers the opaque `none` tier: no native material has been
//     discovered, so no tier is claimed; Boot does not answer it, so this
//     module is the only answer and nothing is duplicated
//   - `about_info` answers Astra's own version (the `astra.version` pref the
//     branding renderer writes) plus the OS and arch the process reads; any
//     fact missing answers `null`, so no placeholder version is offered
//   - `update_status` and `update_check` answer `unavailable`: no updater is
//     connected, no version is named, and a check never reports `checking`,
//     `upToDate` or `ready` for work it did not do
//   - `default_browser_status`, `default_browser_request`, `login_item_status`,
//     `login_item_set` and `login_item_open_settings` read and write Windows'
//     own `UserChoice`/`Run` state; off Windows they answer `null` or
//     `supported: false`, so the UI claims nothing it cannot hold
//   - `windows_reputation_managed` and `windows_diagnostics_settings` answer
//     real policy/settings state instead of `unknown_command`
//   - `set_content_color_scheme` maps light/dark/system to Firefox's
//     content color-scheme pref (1/0/2), rejects anything that is not a
//     boolean or null with `invalid_light`, and answers `applied: false`
//     instead of throwing where no chrome `Services.prefs` is reachable
//   - answers are fresh per call, so a caller cannot poison the next read
//   - junk and hostile payloads answer instead of throwing
//
// Usage: node tests/contract/system_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const {
  System,
  __setContentPrefForTests,
  __setWindowsForTests,
  __resetSystemForTests,
} = await import(pathToFileURL(path.join(HOST, "System.sys.mjs")).href);
const { Boot } = await import(
  pathToFileURL(path.join(HOST, "Boot.sys.mjs")).href
);

/** The pref Firefox reads a content document's `prefers-color-scheme` from. */
const CONTENT_COLOR_SCHEME_PREF =
  "layout.css.prefers-color-scheme.content-override";

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

/** The commands this module owns, and the method answering each. */
const COMMANDS = {
  about_info: "aboutInfo",
  system_clock_24h: "systemClock24h",
  update_status: "updateStatus",
  update_check: "updateCheck",
  update_highlights: "updateHighlights",
  update_relaunch: "updateRelaunch",
  default_browser_status: "defaultBrowserStatus",
  default_browser_request: "defaultBrowserRequest",
  login_item_status: "loginItemStatus",
  login_item_set: "loginItemSet",
  login_item_open_settings: "loginItemOpenSettings",
  windows_reputation_managed: "windowsReputationManaged",
  windows_diagnostics_settings: "windowsDiagnosticsSettings",
  set_content_color_scheme: "setContentColorScheme",
  ui_info: "uiInfo",
};

/** `UpdateStatus`' states. */
const UPDATE_STATES = new Set([
  "unavailable",
  "idle",
  "checking",
  "upToDate",
  "downloading",
  "ready",
  "manualInstall",
  "installing",
  "failed",
]);

/** `Material`'s tiers. */
const MATERIALS = new Set([
  "none",
  "vibrancy",
  "liquid_glass",
  "acrylic",
  "mica",
]);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const keysOf = (value) => Object.keys(value).sort();
const sameKeys = (value, expected) =>
  isObject(value) &&
  JSON.stringify(keysOf(value)) === JSON.stringify([...expected].sort());

/** This process's own hour cycle, read independently of the module. */
function localHourCycle() {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    if (resolved && typeof resolved.hourCycle === "string") {
      return resolved.hourCycle;
    }
    if (resolved && typeof resolved.hour12 === "boolean") {
      return resolved.hour12 ? "h12" : "h23";
    }
  } catch {
    return null;
  }
  return null;
}

const HOUR_24 = { h11: true, h23: true, h12: false, h24: false };
const localCycle = localHourCycle();
const localHour24 = Object.hasOwn(HOUR_24, localCycle)
  ? HOUR_24[localCycle]
  : null;

// === The module answers every command it owns ==============================
{
  check("System is exported as an object", isObject(System));
  for (const [command, method] of Object.entries(COMMANDS)) {
    check(
      `${command} is answered by System.${method}`,
      typeof System[method] === "function",
    );
  }
  check(
    "ui_info is not answered by Boot, so System is its only answer",
    typeof Boot.uiInfo !== "function",
  );
}

// === system_clock_24h: a real local read, never invented ===================
{
  const answer = await System.systemClock24h();
  check(
    "system_clock_24h answers a boolean or null",
    answer === null || typeof answer === "boolean",
  );
  check(
    "system_clock_24h agrees with this process's own hour cycle",
    answer === localHour24,
  );
  check(
    "system_clock_24h is known where Intl names a cycle",
    localHour24 === null || typeof answer === "boolean",
  );
  check(
    "system_clock_24h is null only where no cycle is named",
    localHour24 !== null || answer === null,
  );
  check(
    "system_clock_24h answers the same twice",
    (await System.systemClock24h()) === answer,
  );
}

// === about_info: the build's own facts, or null with nothing to read ======
{
  check(
    "about_info answers null outside chrome",
    (await System.aboutInfo()) === null,
  );

  globalThis.Services = {
    appinfo: { OS: "Linux", XPCOMABI: "x86_64-gcc3" },
    sysinfo: {
      getProperty: (name) =>
        ({ name: "Linux", version: "6.17.0" })[name] ?? "",
    },
    prefs: {
      getStringPref: (name, fallback) =>
        name === "astra.version" ? "0.1.742" : fallback,
    },
  };

  const answer = await System.aboutInfo();
  check(
    "about_info answers exactly the three AboutInfo strings",
    sameKeys(answer, ["version", "os", "arch"]) &&
      ["version", "os", "arch"].every(
        (key) => typeof answer[key] === "string" && answer[key] !== "",
      ),
  );
  check(
    "about_info names the Astra version the build carries",
    answer?.version === "0.1.742",
  );
  check(
    "about_info names the OS product the engine reads",
    answer?.os === "Linux 6.17.0",
  );
  check(
    "about_info names the CPU, not the ABI triple",
    answer?.arch === "x86_64",
  );
  check(
    "about_info answers the same facts twice",
    JSON.stringify(await System.aboutInfo()) === JSON.stringify(answer),
  );

  // A build with no version pref says nothing, rather than inventing one.
  globalThis.Services.prefs.getStringPref = (_name, fallback) => fallback;
  check(
    "about_info invents no version when the build names none",
    (await System.aboutInfo()) === null,
  );

  // A hostile pref service answers null instead of throwing.
  globalThis.Services.prefs.getStringPref = () => {
    throw new Error("no prefs");
  };
  check(
    "about_info survives a hostile pref read",
    (await System.aboutInfo()) === null,
  );

  delete globalThis.Services;
  check(
    "about_info is null again once chrome is gone",
    (await System.aboutInfo()) === null,
  );
}

// === update_status / update_check: unavailable, and nothing claimed ========
{
  const status = await System.updateStatus();
  check("update_status answers an object", isObject(status));
  check("update_status answers state unavailable", status.state === "unavailable");
  check("update_status carries no other key", sameKeys(status, ["state"]));
  check(
    "update_status never claims an update is waiting",
    status.state !== "ready" && status.state !== "manualInstall",
  );
  check(
    "update_status never claims the release is current",
    status.state !== "upToDate",
  );
  check("update_status names no version", !("version" in status));
  check("update_status names no retry reason", !("retry_reason" in status));

  const checked = await System.updateCheck();
  check("update_check answers an object", isObject(checked));
  check("update_check answers state unavailable", checked.state === "unavailable");
  check("update_check carries no other key", sameKeys(checked, ["state"]));
  check(
    "update_check never reports a check in flight",
    checked.state !== "checking" && checked.state !== "downloading",
  );
  check("update_check names no version", !("version" in checked));
  check(
    "update_check leaves the status unchanged",
    (await System.updateStatus()).state === "unavailable",
  );
  check(
    "update_check is repeatable without starting work",
    (await System.updateCheck()).state === "unavailable",
  );

  for (const answer of [status, checked]) {
    check(
      `update state ${answer.state} is one the wire allows`,
      UPDATE_STATES.has(answer.state),
    );
  }
}

// === default_browser_status: not known, so no claim either way =============
{
  const answer = await System.defaultBrowserStatus();
  check("default_browser_status answers null", answer === null);
  check(
    "default_browser_status never claims Astra is the default",
    !isObject(answer) || answer.is_default !== true,
  );
  check(
    "default_browser_status never claims it can register this build",
    !isObject(answer) || answer.can_request !== true,
  );
  check(
    "default_browser_status answers the same twice",
    (await System.defaultBrowserStatus()) === null,
  );
}

// === login_item_status: unsupported, so General hides the row ==============
{
  const answer = await System.loginItemStatus();
  check("login_item_status answers an object", isObject(answer));
  check(
    "login_item_status has the three wire keys",
    sameKeys(answer, ["supported", "enabled", "needs_approval"]),
  );
  check("login_item_status reports unsupported", answer.supported === false);
  check("login_item_status reports not enabled", answer.enabled === false);
  check(
    "login_item_status reports no pending approval",
    answer.needs_approval === false,
  );
  check(
    "login_item_status never reports a registered login item",
    answer.enabled !== true && answer.needs_approval !== true,
  );

  const again = await System.loginItemStatus();
  check(
    "login_item_status answers the same values twice",
    JSON.stringify(again) === JSON.stringify(answer),
  );
  check(
    "login_item_status hands out a fresh object each call",
    again !== answer,
  );
}

// === Windows state: UserChoice, Run and policy are real reads ==============
{
  const values = new Map();
  const opened = [];
  const fake = {
    packaged: () => true,
    readString(root, path, name) {
      return values.get(`${root}|${path}|${name}`) ?? null;
    },
    readInt(root, path, name) {
      return values.get(`${root}|${path}|${name}`) ?? null;
    },
    exists(root, path) {
      return [...values.keys()].some((key) =>
        key.startsWith(`${root}|${path}|`),
      );
    },
    writeString(root, path, name, value) {
      values.set(`${root}|${path}|${name}`, String(value));
      return true;
    },
    removeValue(root, path, name) {
      return values.delete(`${root}|${path}|${name}`);
    },
    removeKey() {
      return true;
    },
    exePath: () =>
      "C:\\Users\\Test\\AppData\\Local\\Programs\\Astra\\astra.exe",
    profilePath: () =>
      "C:\\Users\\Test\\AppData\\Roaming\\Astra\\Profiles\\default",
    openSettings(uri) {
      opened.push(uri);
      return true;
    },
  };
  __setWindowsForTests(fake);

  const chromeDefault = await System.defaultBrowserStatus();
  check(
    "default_browser_status reads a non-Astra ProgId as not default",
    chromeDefault.is_default === false && chromeDefault.can_request === true,
  );
  values.set(
    "HKCU|Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice|ProgId",
    "AstraURL",
  );
  const astraDefault = await System.defaultBrowserStatus();
  check(
    "default_browser_status reads AstraURL as Astra",
    astraDefault.is_default === true,
  );
  const requested = await System.defaultBrowserRequest();
  check(
    "default_browser_request opens Windows default apps",
    opened.includes("ms-settings:defaultapps"),
  );
  check(
    "default_browser_request reports the current answer",
    requested.is_default === true && requested.can_request === true,
  );

  const loginOff = await System.loginItemStatus();
  check(
    "login_item_status is supported on a packaged Windows build",
    loginOff.supported === true && loginOff.enabled === false,
  );
  const loginOn = await System.loginItemSet({ enabled: true });
  check(
    "login_item_set writes the per-user Run value",
    loginOn.supported === true && loginOn.enabled === true,
  );
  const command = values.get(
    "HKCU|Software\\Microsoft\\Windows\\CurrentVersion\\Run|Astra",
  );
  check(
    "the Run value launches the installed exe with its profile",
    typeof command === "string" &&
      command.includes("Programs\\Astra\\astra.exe") &&
      command.includes("-profile") &&
      command.includes("Profiles\\default"),
  );
  const loginAgain = await System.loginItemSet({ enabled: false });
  check(
    "login_item_set(false) removes the Run value",
    loginAgain.supported === true && loginAgain.enabled === false,
  );
  check(
    "login_item_open_settings opens Windows Startup Apps",
    (await System.loginItemOpenSettings()) === true &&
      opened.includes("ms-settings:startupapps"),
  );

  check(
    "windows_reputation_managed answers false with no policy",
    (await System.windowsReputationManaged()) === false,
  );
  values.set(
    "HKLM|Software\\Policies\\Microsoft\\Windows\\System|EnableSmartScreen",
    1,
  );
  check(
    "windows_reputation_managed reads the SmartScreen policy",
    (await System.windowsReputationManaged()) === true,
  );
  check(
    "windows_diagnostics_settings opens Windows feedback privacy",
    (await System.windowsDiagnosticsSettings()) === true &&
      opened.includes("ms-settings:privacy-feedback"),
  );

  // A development build cannot register; the UI must not offer the request.
  __setWindowsForTests({ ...fake, packaged: () => false });
  const devDefault = await System.defaultBrowserStatus();
  check(
    "a development build reports can_request false",
    devDefault.can_request === false,
  );
  check(
    "a development build hides the login item",
    (await System.loginItemStatus()).supported === false,
  );

  __resetSystemForTests();
  check(
    "off Windows default_browser_status returns to null",
    (await System.defaultBrowserStatus()) === null,
  );
  check(
    "off Windows windows_reputation_managed answers null",
    (await System.windowsReputationManaged()) === null,
  );
}

// === ui_info: the opaque tier, never a tier nothing discovered =============
{
  const answer = await System.uiInfo();
  check("ui_info answers an object", isObject(answer));
  check(
    "ui_info has the material and materials keys",
    sameKeys(answer, ["material", "materials"]),
  );
  check(
    `ui_info names a Material (${answer.material})`,
    MATERIALS.has(answer.material),
  );
  check(
    "ui_info lists the tiers the picker may offer",
    Array.isArray(answer.materials) &&
      answer.materials.length > 0 &&
      answer.materials.every((tier) => MATERIALS.has(tier)),
  );
  check(
    "the resolved material is one of the offered tiers",
    answer.materials.includes(answer.material),
  );
  check(
    "ui_info claims no native material it has not discovered",
    answer.material === "none",
  );
  check(
    "ui_info answers the same tier twice",
    (await System.uiInfo()).material === answer.material,
  );
}

// === Answers are fresh: a caller cannot poison the host's state ============
{
  const first = await System.updateStatus();
  first.state = "ready";
  first.version = "99.0.0";
  const second = await System.updateStatus();
  check(
    "a mutated update_status does not become the next answer",
    second.state === "unavailable" && !("version" in second),
  );

  const info = await System.uiInfo();
  info.material = "liquid_glass";
  check(
    "a mutated ui_info does not become the next answer",
    (await System.uiInfo()).material === "none",
  );

  const login = await System.loginItemStatus();
  login.supported = true;
  login.enabled = true;
  const loginAgain = await System.loginItemStatus();
  check(
    "a mutated login_item_status does not become the next answer",
    loginAgain.supported === false && loginAgain.enabled === false,
  );
}

// === set_content_color_scheme: the app's theme reaches content =============
{
  check(
    "set_content_color_scheme is answered by System.setContentColorScheme",
    typeof System.setContentColorScheme === "function",
  );

  // No chrome in this process: the module answers honestly, never throws.
  for (const [name, payload] of [
    ["light", { light: true }],
    ["dark", { light: false }],
    ["system", { light: null }],
    ["absent", {}],
    ["no payload", undefined],
  ]) {
    const answer = await System.setContentColorScheme(payload);
    check(`no chrome answers applied:false (${name})`, answer.applied === false);
    check(
      `no chrome answer carries only applied (${name})`,
      sameKeys(answer, ["applied"]),
    );
  }

  // A request_id is accepted and changes nothing about the answer.
  const echoed = await System.setContentColorScheme({
    request_id: "theme-1",
    light: true,
  });
  check(
    "a request_id does not change the no-chrome answer",
    sameKeys(echoed, ["applied"]) && echoed.applied === false,
  );

  // Only a boolean or null is a theme; everything else is invalid.
  for (const light of ["true", "system", 1, 0, [], {}, "light"]) {
    const answer = await System.setContentColorScheme({ light });
    check(
      `light ${JSON.stringify(light)} is rejected as invalid_light`,
      isObject(answer) &&
        isObject(answer.error) &&
        answer.error.code === "invalid_light" &&
        sameKeys(answer, ["error"]),
    );
    check(
      `an invalid light carries only the invalid_light code`,
      sameKeys(answer.error, ["code"]),
    );
  }

  // Junk and hostile payloads answer rather than throw.
  {
    const hostile = [
      undefined,
      null,
      "theme",
      0,
      Symbol("theme"),
      {
        get light() {
          throw new Error("hostile payload");
        },
      },
      new Proxy(
        {},
        {
          get() {
            throw new Error("hostile payload");
          },
        },
      ),
    ];
    let threw = false;
    for (const payload of hostile) {
      try {
        const answer = await System.setContentColorScheme(payload);
        if (!isObject(answer)) threw = true;
      } catch {
        threw = true;
      }
    }
    check(
      "set_content_color_scheme answers junk payloads instead of throwing",
      threw === false,
    );
  }

  // The chrome route: Services.prefs.setIntPref on the chrome global.
  {
    const writes = [];
    globalThis.Services = {
      prefs: {
        setIntPref(pref, value) {
          writes.push([pref, value]);
        },
      },
    };
    const answer = await System.setContentColorScheme({ light: false });
    delete globalThis.Services;
    check(
      "a chrome Services.prefs receives the dark override",
      answer.applied === true &&
        answer.value === 0 &&
        writes.length === 1 &&
        writes[0][0] === CONTENT_COLOR_SCHEME_PREF &&
        writes[0][1] === 0,
    );
    check(
      "the applied answer names the value and nothing else",
      sameKeys(answer, ["applied", "value"]),
    );
  }

  // The injectable seam a live shell/test can wire: light/dark/system.
  {
    const writes = [];
    __setContentPrefForTests((pref, value) => writes.push([pref, value]));
    for (const [light, expected, name] of [
      [true, 1, "light"],
      [false, 0, "dark"],
      [null, 2, "system"],
      [undefined, 2, "absent"],
    ]) {
      const answer = await System.setContentColorScheme({ light });
      const [pref, value] = writes.at(-1) ?? [];
      check(
        `${name} writes ${expected} to the content color-scheme pref`,
        answer.applied === true &&
          answer.value === expected &&
          pref === CONTENT_COLOR_SCHEME_PREF &&
          value === expected,
      );
    }
    check(
      "each theme choice is one write",
      writes.length === 4 && writes.every(([pref]) => pref === CONTENT_COLOR_SCHEME_PREF),
    );

    // A writer that fails answers `applied: false` instead of throwing.
    __setContentPrefForTests(() => {
      throw new Error("no prefs");
    });
    const failed = await System.setContentColorScheme({ light: true });
    check(
      "a throwing pref writer answers applied:false",
      sameKeys(failed, ["applied"]) && failed.applied === false,
    );
    __setContentPrefForTests(null);
    check(
      "with the seam reset, no chrome answers applied:false again",
      (await System.setContentColorScheme({ light: true })).applied === false,
    );
  }
}

// === Junk and hostile payloads answer instead of throwing ==================
{
  const hostile = [
    undefined,
    null,
    {},
    [],
    "about_info",
    0,
    Symbol("about_info"),
    {
      get request_id() {
        throw new Error("hostile payload");
      },
    },
    new Proxy(
      {},
      {
        get() {
          throw new Error("hostile payload");
        },
        has() {
          throw new Error("hostile payload");
        },
      },
    ),
  ];

  let threw = false;
  for (const [command, method] of Object.entries(COMMANDS)) {
    for (const payload of hostile) {
      try {
        const answer = await System[method](payload);
        if (answer === undefined) threw = true;
      } catch {
        threw = true;
      }
    }
  }
  check("junk payloads answer instead of throwing", threw === false);
}

// --- update availability ----------------------------------------------------
// The build ships no updater, so both answers are honest refusals rather than
// `unknown_command`: the About row reads "unavailable" from update_status and
// never promises a restart that cannot happen.
check(
  "update_highlights answers null with no updater",
  (await System.updateHighlights()) === null,
);
check(
  "update_relaunch refuses with nothing parked",
  (await System.updateRelaunch()) === false,
);

console.log(`\nsystem_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
