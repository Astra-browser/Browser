#!/usr/bin/env node
// System module contract (wiring): `about_info`, `system_clock_24h`,
// `update_status`, `update_check`, `default_browser_status`,
// `login_item_status` and `ui_info` answer the UI natively instead of failing
// with `unknown_command`.
//
//   - every answer is the shape `ui/app/src/shared/ipc/bindings.ts` declares,
//     and carries no key the type does not have
//   - `system_clock_24h` is a real local read: it agrees with this process's
//     own `Intl` hour cycle, and is `null` only when that names none
//   - `ui_info` answers the opaque `none` tier: no native material has been
//     discovered, so no tier is claimed; Boot does not answer it, so this
//     module is the only answer and nothing is duplicated
//   - `about_info` answers `null`: no version, OS product name or arch is
//     known here, and no placeholder version is offered
//   - `update_status` and `update_check` answer `unavailable`: no updater is
//     connected, no version is named, and a check never reports `checking`,
//     `upToDate` or `ready` for work it did not do
//   - `default_browser_status` answers `null`: neither "Astra is the default"
//     nor "Astra is not" can be read from the host
//   - `login_item_status` answers `supported: false` with `enabled` and
//     `needs_approval` false: the row is hidden, never shown as on
//   - answers are fresh per call, so a caller cannot poison the next read
//   - junk and hostile payloads answer instead of throwing
//
// Usage: node tests/contract/system_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { System } = await import(path.join(HOST, "System.sys.mjs"));
const { Boot } = await import(path.join(HOST, "Boot.sys.mjs"));

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
  default_browser_status: "defaultBrowserStatus",
  login_item_status: "loginItemStatus",
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

// === about_info: null, never a placeholder version =========================
{
  const answer = await System.aboutInfo();
  check("about_info answers null", answer === null);
  check(
    "about_info is either null or the three AboutInfo strings",
    answer === null ||
      (sameKeys(answer, ["version", "os", "arch"]) &&
        ["version", "os", "arch"].every(
          (key) => typeof answer[key] === "string" && answer[key] !== "",
        )),
  );
  check(
    "about_info invents no placeholder version today",
    answer === null || !/^(0\.0\.0|unknown|dev|mock)$/iu.test(answer.version),
  );
  check("about_info answers the same twice", (await System.aboutInfo()) === null);
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

// === ui_info: the opaque tier, never a tier nothing discovered =============
{
  const answer = await System.uiInfo();
  check("ui_info answers an object", isObject(answer));
  check("ui_info has the material key", sameKeys(answer, ["material"]));
  check(
    `ui_info names a Material (${answer.material})`,
    MATERIALS.has(answer.material),
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

console.log(`\nsystem_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
