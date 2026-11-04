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

const REVIEWS = new Map();
let _nextReview = 0;

async function fileUtils() {
  try {
    return ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs").FileUtils;
  } catch {
    return null;
  }
}

function reviewFor(id, install, fromFile) {
  const addon = install?.addon ?? {};
  return {
    review_id: id,
    id: String(addon.id ?? install?.id ?? ""),
    name: String(addon.name ?? install?.name ?? ""),
    version: String(addon.version ?? install?.version ?? ""),
    description: String(addon.description ?? ""),
    warnings: [],
    limitations: [],
    icon: typeof addon.iconURL === "string" && addon.iconURL !== "" ? addon.iconURL : null,
    update: false,
    from_file: fromFile === true,
  };
}

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

  /** Review an extension package on disk without installing it yet. */
  async prepareFile({ path = "" } = {}) {
    if (typeof path !== "string" || path === "") throw fail("no package selected");
    const manager = await addonManager();
    const FileUtils = await fileUtils();
    if (!manager || !FileUtils) throw fail("the engine cannot install extensions");
    let install = null;
    try {
      install = await manager.getInstallForFile(new FileUtils.File(path), null);
    } catch {
      install = null;
    }
    if (!install) throw fail("the package could not be read");
    _nextReview += 1;
    const reviewId = `ext-review-${_nextReview}`;
    const review = reviewFor(reviewId, install, true);
    REVIEWS.set(reviewId, { install, review });
    return review;
  },

  /** Install the package the review named. */
  async confirm({ id = "", reviewId = "" } = {}) {
    const entry = REVIEWS.get(reviewId);
    if (!entry) throw fail("this review is no longer available");
    if (id !== "" && entry.review.id !== "" && id !== entry.review.id) {
      throw fail("the package does not match the review");
    }
    REVIEWS.delete(reviewId);
    try {
      await entry.install.install();
      return null;
    } catch {
      throw fail("the engine refused the install");
    }
  },

  /** Drop a review without installing. */
  async cancel({ reviewId = "" } = {}) {
    const entry = REVIEWS.get(reviewId);
    if (!entry) return undefined;
    REVIEWS.delete(reviewId);
    try {
      entry.install.cancel();
    } catch {
      // Already cancelled or installed.
    }
    return undefined;
  },

  /** Native picker: a folder (temporary add-on) or an .xpi file to review. */
  async chooseFile({ folder = false } = {}) {
    const manager = await addonManager();
    if (!manager) throw fail("the engine cannot install extensions");
    try {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      picker.init(
        win,
        folder ? "Choose extension folder" : "Choose extension package",
        folder ? Ci.nsIFilePicker.modeGetFolder : Ci.nsIFilePicker.modeOpen
      );
      if (!folder) picker.appendFilter("Extensions", "*.xpi");
      const result = await new Promise((resolve) => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK) return null;
      if (folder === true) {
        await manager.installTemporaryAddon(picker.file);
        return null;
      }
      return await WebExtensions.prepareFile({ path: picker.file.path });
    } catch (e) {
      if (e instanceof Error) throw e;
      throw fail("the picker could not open");
    }
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
