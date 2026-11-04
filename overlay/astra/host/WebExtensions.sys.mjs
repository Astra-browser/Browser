/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API WebExtensions module (P9). The manager page lists the engine's real
// extensions through `AddonManager`; enable/disable, uninstall and options are
// native. The list payload is a bare `WebExtensionView[]` (the generated UI
// binding consumes the array itself, not an envelope).
//
// Node tests have no `ChromeUtils`/`AddonManager`; the module then answers an
// empty list and refuses actions, which is the honest "no engine" path.
// Nothing here fabricates an extension or a state.

import { HOST_API_VERSION } from "./Tabs.sys.mjs";

async function addonManager() {
  try {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs"
    );
    await AddonManager.readyPromise;
    return AddonManager;
  } catch {
    return null;
  }
}

function hasSiteAccess(addon) {
  try {
    const permissions = addon.userPermissions;
    if (!permissions) return false;
    if (Array.isArray(permissions.origins) && permissions.origins.length > 0) return true;
    return Array.isArray(permissions.permissions)
      ? permissions.permissions.some((name) => name.endsWith("://*/"))
      : false;
  } catch {
    return false;
  }
}

/** Pure mapper, exported for the contract test. */
export function viewForAddon(addon, { profileId = "default" } = {}) {
  if (!addon) return null;
  const disabled = addon.userDisabled === true;
  const failed = addon.appDisabled === true || addon.isActive !== true;
  return {
    profile_id: profileId,
    install_id: String(addon.id ?? ""),
    id: String(addon.id ?? ""),
    name: String(addon.name ?? addon.id ?? ""),
    version: String(addon.version ?? ""),
    description: String(addon.description ?? ""),
    enabled: !disabled,
    icon: typeof addon.iconURL === "string" && addon.iconURL !== "" ? addon.iconURL : null,
    state: disabled ? "off" : failed ? "failed" : "running",
    error: null,
    warnings: [],
    limitations: [],
    access: "all",
    sites: [],
    site_scoped: hasSiteAccess(addon),
    has_options: typeof addon.optionsURL === "string" && addon.optionsURL !== "",
    held_update: addon.pendingUpgrade?.version ?? null,
    sideloaded: addon.foreignInstall === true,
    pinned: false,
  };
}

async function findAddon(id) {
  if (typeof id !== "string" || id === "") return null;
  const manager = await addonManager();
  if (!manager) return null;
  try {
    return await manager.getAddonByID(id);
  } catch {
    return null;
  }
}

function fail(message) {
  const error = new Error(message);
  error.code = "host_error";
  return error;
}

export const WebExtensions = {
  async list() {
    const manager = await addonManager();
    if (!manager) return [];
    try {
      const addons = await manager.getAddonsByTypes(["extension"]);
      return addons
        .filter(
          (addon) =>
            addon &&
            addon.isSystem !== true &&
            addon.isBuiltin !== true &&
            addon.hidden !== true &&
            typeof addon.id === "string"
        )
        .map((addon) => viewForAddon(addon))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  },

  async setEnabled({ id = "", enabled = true } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    try {
      if (enabled === true) await addon.enable();
      else await addon.disable();
      return null;
    } catch {
      throw fail("the engine refused the change");
    }
  },

  async uninstall({ id = "" } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    const removed = new Promise((resolve) => {
      const listener = {
        onUninstalled(uninstalled) {
          if (uninstalled?.id === id) resolve(true);
        },
        onUninstalling() {},
        onInstalling() {},
        onInstalled() {},
        onEnabling() {},
        onEnabled() {},
        onDisabling() {},
        onDisabled() {},
      };
      try {
        addon.manager?.addAddonListener?.(listener);
      } catch {
        // The manager may not expose listeners in this build.
      }
      setTimeout(() => resolve(false), 5000);
    });
    try {
      await addon.uninstall();
    } catch {
      throw fail("the engine refused to uninstall");
    }
    await removed;
    return null;
  },

  async openOptions({ id = "" } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    const url = typeof addon.optionsURL === "string" ? addon.optionsURL : "";
    if (url === "") throw fail("this extension has no options page");
    // `moz-extension://` is not a web address the tab model may hold; open it
    // as a trusted engine page in a normal tab instead.
    try {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (!win) throw new Error("no window");
      win.openTrustedLinkIn(url, "tab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: false,
      });
      return null;
    } catch {
      throw fail("could not open the options page");
    }
  },
};

// Test-only reset: the module holds no state, but the HostAPI reset protocol
// calls this.
export function __resetWebExtensionsForTests() {}
