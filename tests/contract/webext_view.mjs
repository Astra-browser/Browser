#!/usr/bin/env node
// P9 contract test: the AddonManager -> WebExtensionView mapping.
//
//   - a running addon maps to enabled/running with its options and site scope
//   - a user-disabled addon maps to off and enabled:false
//   - an app-disabled addon maps to failed
//   - icons, versions, sideloading and pending updates survive
//   - without chrome, list() is an empty array and actions fail (not fake)
//
// Usage: node tests/contract/webext_view.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { WebExtensions, viewForAddon } = await import(pathToFileURL(path.join(HOST, "WebExtensions.sys.mjs")).href);
const { addEventListener } = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

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

const running = viewForAddon({
  id: "probe@astra.test",
  name: "Probe",
  version: "1.2.3",
  description: "A probe",
  userDisabled: false,
  appDisabled: false,
  isActive: true,
  iconURL: "moz-extension://x/icon.png",
  optionsURL: "moz-extension://x/options.html",
  foreignInstall: true,
  pendingUpgrade: { version: "1.3.0" },
  userPermissions: { origins: ["https://example.com/*"], permissions: [] },
});
check("the id is the native addon id", running.id === "probe@astra.test");
check("install_id equals the id", running.install_id === running.id);
check("the profile is default", running.profile_id === "default");
check(
  "a running addon is enabled",
  running.enabled === true && running.state === "running",
);
check("the version survives", running.version === "1.2.3");
check("the icon survives", running.icon === "moz-extension://x/icon.png");
check("options are reported", running.has_options === true);
check("a pending update is held", running.held_update === "1.3.0");
check("a foreign install is sideloaded", running.sideloaded === true);
check("site access is detected", running.site_scoped === true);
check("access is all by default", running.access === "all");

const disabled = viewForAddon({
  id: "off@astra.test",
  name: "Off",
  userDisabled: true,
  appDisabled: false,
  isActive: false,
  userPermissions: null,
});
check(
  "a user-disabled addon is off",
  disabled.enabled === false && disabled.state === "off",
);
check("no site access without permissions", disabled.site_scoped === false);
check(
  "site access keeps the list empty",
  Array.isArray(disabled.sites) && disabled.sites.length === 0,
);

const failedAddon = viewForAddon({
  id: "bad@astra.test",
  name: "Bad",
  userDisabled: false,
  appDisabled: true,
  isActive: false,
});
check("an app-disabled addon is failed", failedAddon.state === "failed");
check("a missing addon maps to null", viewForAddon(null) === null);

const listed = await WebExtensions.list();
check(
  "without chrome the list is empty",
  Array.isArray(listed) && listed.length === 0,
);
let refused = false;
try {
  await WebExtensions.setEnabled({ id: "probe@astra.test", enabled: false });
} catch {
  refused = true;
}
check("without chrome an action fails instead of pretending", refused === true);

// --- install prompt bridge (engine panel -> Astra sheet) ------------------
const seen = [];
const off = addEventListener((event) => seen.push(event));
let accepted = false;
let cancelled = false;
let privateChoice = null;
let technicalChoice = null;
const fakeWindow = {
  closed: false,
  addEventListener() {},
  PopupNotifications: { show() {} },
};
check(
  "install hooks a window",
  WebExtensions.install({ window: fakeWindow }) === true,
);
const notification = fakeWindow.PopupNotifications.show(
  null,
  "addon-webext-permissions",
  "Add Probe",
  null,
  { callback: () => (accepted = true) },
  [{ callback: () => (cancelled = true) }],
  {
    name: "Probe",
    popupIconURL: null,
    customElementOptions: {
      strings: {
        header: "Add Probe",
        msgs: ["Read and change your data on probe.test"],
        addonName: "Probe",
      },
      showIncognitoCheckbox: true,
      grantPrivateBrowsingAllowed: false,
      onPrivateBrowsingAllowedChanged: (value) => (privateChoice = value),
      showTechnicalAndInteractionCheckbox: true,
      grantTechnicalAndInteractionDataCollection: true,
      onTechnicalAndInteractionDataChanged: (value) =>
        (technicalChoice = value),
    },
  },
);
check("the native panel is held", typeof notification?.remove === "function");
const promptEvent = seen.find(
  (event) => event.type === "web-extension-prompt-changed",
);
check("the prompt reaches Astra", promptEvent?.data?.prompt?.name === "Probe");
check(
  "its permissions survive",
  promptEvent?.data?.prompt?.messages?.[0] ===
    "Read and change your data on probe.test",
);
check(
  "both optional choices are offered",
  promptEvent?.data?.prompt?.show_private === true &&
    promptEvent?.data?.prompt?.show_technical === true,
);
if (promptEvent?.data?.prompt?.prompt_id) {
  await WebExtensions.answerPrompt({
    prompt_id: promptEvent.data.prompt.prompt_id,
    accept: true,
    private_windows: true,
    technical_data: false,
  });
}
check(
  "accept resolves the engine prompt",
  accepted === true && cancelled === false,
);
check("the private-window choice reaches the engine", privateChoice === true);
check(
  "the technical-data choice reaches the engine",
  technicalChoice === false,
);
check(
  "the sheet is told to close",
  seen.some(
    (event) =>
      event.type === "web-extension-prompt-changed" &&
      event.data?.prompt === null,
  ),
);
WebExtensions.uninstall({ window: fakeWindow });
check(
  "uninstall restores the native show",
  fakeWindow.PopupNotifications.show !== undefined,
);
off();

console.log(
  `\nwebext view contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
