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
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { WebExtensions, viewForAddon } = await import(path.join(HOST, "WebExtensions.sys.mjs"));

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
check("a running addon is enabled", running.enabled === true && running.state === "running");
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
check("a user-disabled addon is off", disabled.enabled === false && disabled.state === "off");
check("no site access without permissions", disabled.site_scoped === false);
check("site access keeps the list empty", Array.isArray(disabled.sites) && disabled.sites.length === 0);

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
check("without chrome the list is empty", Array.isArray(listed) && listed.length === 0);
let refused = false;
try {
  await WebExtensions.setEnabled({ id: "probe@astra.test", enabled: false });
} catch {
  refused = true;
}
check("without chrome an action fails instead of pretending", refused === true);

console.log(
  `\nwebext view contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
