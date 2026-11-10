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

import { addEventListener, emit } from "./Events.sys.mjs";
import { __tabsState } from "./Tabs.sys.mjs";
import {
  ChromeExtensions,
  __resetChromeExtensionsForTests,
  isChromePackagePath,
  storeIdFromUrl,
} from "./ChromeExtensions.sys.mjs";

const REVIEWS = new Map();
let _nextReview = 0;
// The person's pinned toolbar actions. A pref, not a file: it is a view
// preference, not extension state.
const PINNED_PREF = "astra.webext.pinned";

function pinnedIds() {
  try {
    const raw = Services.prefs.getStringPref(PINNED_PREF, "[]");
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id) => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function savePinnedIds(ids) {
  try {
    Services.prefs.setStringPref(PINNED_PREF, JSON.stringify([...ids]));
  } catch {
    // No profile prefs (Node tests).
  }
}

// ---------------------------------------------------------------------------
// Install prompt bridge
//
// The engine's own add-on prompt is a PopupNotification panel. Astra owns the
// only UI, so this module takes that panel before it is shown and publishes
// the same prompt to the app. `answerPrompt` resolves the engine's promise
// with the person's answer and the two optional install choices.
// ---------------------------------------------------------------------------

const PROMPTS = new Map();
let _nextPrompt = 0;
let _activePrompt = null;
let _autoAnswer = null;

const ACTION_WINDOWS = new Set();
let _actionRevision = 0;
let _actionPublish = Promise.resolve();
let _actionTimer = null;
let _actionsOff = null;

function promptStub(promptId) {
  return {
    id: `addon-webext-permissions-${promptId}`,
    state: "open",
    remove() {
      const entry = PROMPTS.get(promptId);
      if (!entry) return;
      PROMPTS.delete(promptId);
      if (_activePrompt?.prompt_id === promptId) _activePrompt = null;
      try {
        entry.secondaryActions?.[0]?.callback?.();
      } catch {
        // The engine promise is already gone.
      }
      emit("web-extension-prompt-changed", { prompt: null });
    },
  };
}

function applyInstallChoices(
  custom,
  { privateWindows = false, technicalData = true } = {},
) {
  if (custom?.showIncognitoCheckbox === true) {
    try {
      custom.onPrivateBrowsingAllowedChanged?.(privateWindows === true);
    } catch {
      // The native prompt object changed shape; the install still proceeds.
    }
  }
  if (custom?.showTechnicalAndInteractionCheckbox === true) {
    try {
      custom.onTechnicalAndInteractionDataChanged?.(technicalData !== false);
    } catch {
      // Same as above.
    }
  }
}

function permissionPrompt(win, { mainAction, secondaryActions, options }) {
  const custom = options?.customElementOptions ?? {};
  const strings = custom.strings ?? {};
  const name = String(options?.name ?? strings.addonName ?? "");
  const choice = _autoAnswer;
  if (choice !== null && (choice.name === "" || choice.name === name)) {
    _autoAnswer = null;
    applyInstallChoices(custom, choice);
    try {
      mainAction?.callback?.();
    } catch {
      // The install was cancelled by the engine.
    }
    return promptStub("auto");
  }

  const promptId = `ext-prompt-${++_nextPrompt}`;
  const prompt = {
    prompt_id: promptId,
    kind: strings.acceptText === "Update" ? "update" : "install",
    name,
    header: String(
      strings.header ?? (name === "" ? "Add extension" : `Add ${name}`),
    ).replaceAll("<>", name),
    messages: Array.isArray(strings.msgs) ? strings.msgs.map(String) : [],
    data_collection:
      typeof strings.dataCollectionPermissions?.msg === "string"
        ? strings.dataCollectionPermissions.msg
        : null,
    icon:
      typeof options?.popupIconURL === "string" ? options.popupIconURL : null,
    unsigned:
      options?.popupIconClass === "addon-warning-icon" ||
      options?.popupIconURL === "chrome://global/skin/icons/warning.svg",
    accept_text: String(strings.acceptText ?? "Add"),
    cancel_text: String(strings.cancelText ?? "Cancel"),
    show_private: custom.showIncognitoCheckbox === true,
    private_allowed: custom.grantPrivateBrowsingAllowed === true,
    show_technical: custom.showTechnicalAndInteractionCheckbox === true,
    technical_allowed:
      custom.grantTechnicalAndInteractionDataCollection !== false,
  };
  PROMPTS.set(promptId, {
    window: win,
    mainAction,
    secondaryActions,
    options,
    custom,
    prompt,
  });
  _activePrompt = prompt;
  emit("web-extension-prompt-changed", { prompt });
  return promptStub(promptId);
}

function installConfirmationPrompt(
  win,
  { message, mainAction, secondaryActions, options },
) {
  const promptId = `ext-prompt-${++_nextPrompt}`;
  const name = String(options?.name ?? message ?? "Add-on");
  const prompt = {
    prompt_id: promptId,
    kind: "install",
    name,
    header: String(message ?? `Add ${name}`),
    messages: [],
    data_collection: null,
    icon:
      typeof options?.popupIconURL === "string" ? options.popupIconURL : null,
    unsigned: false,
    accept_text: String(mainAction?.label ?? "Add"),
    cancel_text: String(secondaryActions?.[0]?.label ?? "Cancel"),
    show_private: false,
    private_allowed: false,
    show_technical: false,
    technical_allowed: true,
  };
  PROMPTS.set(promptId, {
    window: win,
    mainAction,
    secondaryActions,
    options,
    custom: {},
    prompt,
  });
  _activePrompt = prompt;
  emit("web-extension-prompt-changed", { prompt });
  return promptStub(promptId);
}

function hookPromptWindow(win) {
  const popups = win?.PopupNotifications;
  if (
    !popups ||
    typeof popups.show !== "function" ||
    popups.__astraExtensionPromptHooked
  ) {
    return popups?.__astraExtensionPromptHooked === true;
  }
  const original = popups.show;
  popups.__astraExtensionOriginalShow = original;
  popups.show = function show(
    browser,
    id,
    message,
    anchor,
    mainAction,
    secondaryActions,
    options,
  ) {
    if (id === "addon-webext-permissions") {
      return permissionPrompt(win, { mainAction, secondaryActions, options });
    }
    if (id === "addon-install-confirmation") {
      return installConfirmationPrompt(win, {
        message,
        mainAction,
        secondaryActions,
        options,
      });
    }
    return original.apply(this, arguments);
  };
  popups.__astraExtensionPromptHooked = true;
  return true;
}

function unhookPromptWindow(win) {
  const popups = win?.PopupNotifications;
  if (!popups?.__astraExtensionPromptHooked) return;
  try {
    popups.show = popups.__astraExtensionOriginalShow;
  } catch {
    // The window is already going away.
  }
  delete popups.__astraExtensionPromptHooked;
  delete popups.__astraExtensionOriginalShow;
  for (const [promptId, entry] of PROMPTS) {
    if (entry.window !== win) continue;
    PROMPTS.delete(promptId);
    if (_activePrompt?.prompt_id === promptId) _activePrompt = null;
    try {
      entry.secondaryActions?.[0]?.callback?.();
    } catch {
      // The window is going away.
    }
  }
  emit("web-extension-prompt-changed", { prompt: null });
}

async function installPermissionDetails(install) {
  const addon = install?.addon ?? null;
  if (!addon) return {};
  let strings = null;
  try {
    const { ExtensionData } = ChromeUtils.importESModule(
      "resource://gre/modules/Extension.sys.mjs",
    );
    strings = ExtensionData.formatPermissionStrings(
      {
        addon,
        permissions: addon.installPermissions,
        type: "install",
        unsigned: addon.signedState <= 0,
      },
      { fullDomainsList: true },
    );
  } catch {
    strings = null;
  }
  const data = strings?.dataCollectionPermissions ?? null;
  const manager = await addonManager();
  let showPrivate = false;
  try {
    showPrivate = !!(
      manager &&
      Number(addon.permissions ?? 0) &
        manager.PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS
    );
  } catch {
    showPrivate = false;
  }
  let privateAllowed = false;
  try {
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    );
    privateAllowed = PrivateBrowsingUtils.permanentPrivateBrowsing === true;
  } catch {
    privateAllowed = false;
  }
  let showTechnical = false;
  try {
    showTechnical =
      Services.prefs.getBoolPref(
        "extensions.dataCollectionPermissions.enabled",
        false,
      ) === true && data?.collectsTechnicalAndInteractionData === true;
  } catch {
    showTechnical = false;
  }
  return {
    warnings: Array.isArray(strings?.msgs) ? strings.msgs.map(String) : [],
    data_collection: typeof data?.msg === "string" ? data.msg : null,
    show_private: showPrivate,
    private_allowed: privateAllowed,
    show_technical: showTechnical,
    technical_allowed: true,
  };
}

function mostRecentBrowserWindow() {
  try {
    return Services.wm.getMostRecentWindow("navigator:browser");
  } catch {
    return null;
  }
}

function emptyActions(revision, profileId = "default", tabId = null) {
  return {
    projection_revision: revision,
    profile_id: profileId,
    tab_id: tabId,
    actions: [],
  };
}

async function actionsForWindow(win, revision) {
  const manager = await addonManager();
  const selected = win?.gBrowser?.selectedTab ?? null;
  const state = __tabsState();
  const tabId =
    selected?.getAttribute?.("astra-tab-id") || state.selectedId || null;
  let profileId = "default";
  try {
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    );
    if (PrivateBrowsingUtils.isWindowPrivate(win)) profileId = "incognito";
  } catch {
    // Default profile.
  }
  if (!manager || !selected || tabId === null)
    return emptyActions(revision, profileId, tabId);

  let IconDetails = null;
  try {
    ({ IconDetails } = ChromeUtils.importESModule(
      "resource://gre/modules/ExtensionParent.sys.mjs",
    ));
  } catch {
    IconDetails = null;
  }

  const addons = await manager.getAddonsByTypes(["extension"]);
  const actions = [];
  for (const addon of addons) {
    if (
      !addon ||
      addon.isActive !== true ||
      addon.userDisabled === true ||
      addon.appDisabled === true ||
      addon.hidden === true
    ) {
      continue;
    }
    let policy = null;
    try {
      policy = globalThis.WebExtensionPolicy?.getByID(addon.id) ?? null;
    } catch {
      policy = null;
    }
    const manifest = policy?.manifest ?? null;
    if (!policy) continue;
    let api = null;
    try {
      api = win.gUnifiedExtensions?.browserActionFor?.(policy) ?? null;
    } catch {
      api = null;
    }
    const action = api?.action ?? null;
    if (!action) continue;
    let data = null;
    try {
      data = action?.getContextData(selected) ?? null;
    } catch {
      data = null;
    }
    let enabled = true;
    try {
      enabled = action ? action.isShownForTab(selected) !== false : true;
    } catch {
      enabled = true;
    }
    const title =
      data?.title ||
      manifest.action?.default_title ||
      manifest.browser_action?.default_title ||
      addon.name ||
      addon.id ||
      "";
    const popup =
      data?.popup ||
      manifest.action?.default_popup ||
      manifest.browser_action?.default_popup ||
      "";
    let iconUrl = typeof addon.iconURL === "string" ? addon.iconURL : null;
    try {
      const icons =
        data?.icon && typeof data.icon === "object"
          ? data.icon
          : (manifest.icons ?? {});
      const preferred = IconDetails?.getPreferredIcon(
        icons,
        policy.extension,
        32,
      )?.icon;
      if (typeof preferred === "string" && preferred !== "")
        iconUrl = preferred;
    } catch {
      // Keep the package icon.
    }
    actions.push({
      runtime: { install_id: addon.id, generation: "0000000000000001" },
      revision,
      label: String(title).slice(0, 64),
      badge: String(data?.badgeText ?? "").slice(0, 4),
      icon_rgba_base64: null,
      icon_url: iconUrl,
      enabled,
      presents_popup: String(popup) !== "",
      unread_badge: false,
    });
  }
  actions.sort((a, b) => a.label.localeCompare(b.label));
  return {
    projection_revision: revision,
    profile_id: profileId,
    tab_id: tabId,
    actions,
  };
}

function publishActions() {
  _actionPublish = _actionPublish
    .then(async () => {
      const windows = [...ACTION_WINDOWS].filter(
        (win) => win && win.closed !== true,
      );
      if (windows.length === 0) return;
      const revision = String(++_actionRevision).padStart(32, "0");
      for (const win of windows) {
        try {
          const view = await actionsForWindow(win, revision);
          emit("extension-actions-changed", view);
        } catch {
          // One window's projection must not stop another's.
        }
      }
    })
    .catch(() => {});
  return _actionPublish;
}

function scheduleActions() {
  if (_actionTimer !== null) return;
  _actionTimer = setTimeout(() => {
    _actionTimer = null;
    void publishActions();
  }, 40);
}

async function openActionPopup(win, api, popupUrl, anchor) {
  const document = win.document;
  const popup = api.getPopup(win, popupUrl);
  const panel = document.createXULElement("panel");
  panel.setAttribute("type", "arrow");
  panel.setAttribute("neverhidden", "true");
  panel.setAttribute("data-astra-extension-popup", "true");
  const view = document.createXULElement("vbox");
  view.setAttribute("closemenu", "none");
  panel.appendChild(view);
  const host =
    document.getElementById("mainPopupSet") ?? document.documentElement;
  host.appendChild(panel);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      popup.destroy();
    } catch {
      // Already gone.
    }
    try {
      panel.remove();
    } catch {
      // Already gone.
    }
  };
  panel.addEventListener("popuphidden", cleanup, { once: true });
  try {
    await popup.attach(view);
    if (closed) return;
    const x = Math.round(
      (win.mozInnerScreenX ?? win.screenX ?? 0) + Number(anchor.x ?? 0),
    );
    const y = Math.round(
      (win.mozInnerScreenY ?? win.screenY ?? 0) +
        Number(anchor.y ?? 0) +
        Number(anchor.h ?? 0),
    );
    panel.openPopupAtScreen(x, y, false);
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function fileUtils() {
  try {
    return ChromeUtils.importESModule(
      "resource://gre/modules/FileUtils.sys.mjs",
    ).FileUtils;
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
    icon:
      typeof addon.iconURL === "string" && addon.iconURL !== ""
        ? addon.iconURL
        : null,
    update: false,
    from_file: fromFile === true,
  };
}

async function addonManager() {
  try {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
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
    if (Array.isArray(permissions.origins) && permissions.origins.length > 0)
      return true;
    return Array.isArray(permissions.permissions)
      ? permissions.permissions.some((name) => name.endsWith("://*/"))
      : false;
  } catch {
    return false;
  }
}

/** Pure mapper, exported for the contract test. */
export function viewForAddon(
  addon,
  { profileId = "default", pinned = false } = {},
) {
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
    icon:
      typeof addon.iconURL === "string" && addon.iconURL !== ""
        ? addon.iconURL
        : null,
    state: disabled ? "off" : failed ? "failed" : "running",
    error: null,
    warnings: [],
    limitations: [],
    access: "all",
    sites: [],
    site_scoped: hasSiteAccess(addon),
    has_options:
      typeof addon.optionsURL === "string" && addon.optionsURL !== "",
    held_update: addon.pendingUpgrade?.version ?? null,
    sideloaded: addon.foreignInstall === true,
    pinned: pinned === true,
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
  /** Install the prompt bridge and action projection for one chrome window. */
  install({ window: win = null } = {}) {
    if (!win) return false;
    hookPromptWindow(win);
    ACTION_WINDOWS.add(win);
    if (!_actionsOff) {
      _actionsOff = addEventListener((event) => {
        if (
          event?.type === "items-changed" ||
          String(event?.type ?? "").startsWith("tab.")
        ) {
          scheduleActions();
        }
      });
    }
    try {
      if (!win.__astraExtensionPromptUnload) {
        win.__astraExtensionPromptUnload = true;
        win.addEventListener(
          "unload",
          () => void WebExtensions.uninstall({ window: win }),
          {
            once: true,
          },
        );
      }
    } catch {
      // A preview window has no event target.
    }
    if (_activePrompt)
      emit("web-extension-prompt-changed", { prompt: _activePrompt });
    void publishActions();
    return true;
  },

  uninstall({ window: win = null } = {}) {
    if (!win) return false;
    unhookPromptWindow(win);
    ACTION_WINDOWS.delete(win);
    try {
      delete win.__astraExtensionPromptUnload;
    } catch {
      // Nothing to clear.
    }
    if (ACTION_WINDOWS.size === 0 && _actionsOff) {
      _actionsOff();
      _actionsOff = null;
    }
    return true;
  },

  /** Answer the engine's install/update permission prompt. */
  async answerPrompt({
    prompt_id = "",
    accept = false,
    private_windows = false,
    technical_data = true,
  } = {}) {
    const entry =
      String(prompt_id) === "" ? null : PROMPTS.get(String(prompt_id));
    if (!entry) throw fail("this prompt is no longer available");
    PROMPTS.delete(String(prompt_id));
    if (_activePrompt?.prompt_id === prompt_id) _activePrompt = null;
    try {
      if (accept === true) {
        applyInstallChoices(entry.custom, {
          privateWindows: private_windows === true,
          technicalData: technical_data !== false,
        });
        entry.mainAction?.callback?.();
      } else {
        entry.secondaryActions?.[0]?.callback?.();
      }
    } catch {
      throw fail("the engine refused the answer");
    }
    emit("web-extension-prompt-changed", { prompt: null });
    scheduleActions();
    return null;
  },

  /** Invoke the action Astra projects for the active tab. */
  async invokeAction({
    profile_id = "",
    install_id = "",
    installId = "",
    runtime_generation = "",
    action_revision = "",
    anchor_x = 0,
    anchor_y = 0,
    anchor_width = 0,
    anchor_height = 0,
  } = {}) {
    const id = String(install_id || installId || "");
    if (id === "") throw fail("no such extension");
    const win = mostRecentBrowserWindow();
    if (!win?.gBrowser) throw fail("no browser window");
    let policy = null;
    try {
      policy = globalThis.WebExtensionPolicy?.getByID(id) ?? null;
    } catch {
      policy = null;
    }
    if (!policy) throw fail("no such extension");
    let api = null;
    try {
      api = win.gUnifiedExtensions?.browserActionFor?.(policy) ?? null;
    } catch {
      api = null;
    }
    const action = api?.action;
    if (!action) throw fail("this extension has no action");
    const tab = win.gBrowser.selectedTab;
    if (!tab) throw fail("no active tab");
    try {
      if (action.isShownForTab(tab) === false) throw new Error("disabled");
    } catch {
      throw fail("this action is disabled on the current page");
    }
    let popupUrl = "";
    try {
      popupUrl =
        action.triggerClickOrPopup(tab, { button: 0, modifiers: [] }) ?? "";
    } catch {
      throw fail("the extension action could not be invoked");
    }
    if (popupUrl !== "") {
      await openActionPopup(win, api, popupUrl, {
        x: Number(anchor_x) || 0,
        y: Number(anchor_y) || 0,
        h: Number(anchor_height) || 0,
      });
    }
    return { accepted: true };
  },

  async list() {
    const manager = await addonManager();
    if (!manager) return [];
    try {
      const addons = await manager.getAddonsByTypes(["extension"]);
      const pinned = pinnedIds();
      const views = addons
        .filter(
          (addon) =>
            addon &&
            addon.isSystem !== true &&
            addon.isBuiltin !== true &&
            addon.hidden !== true &&
            typeof addon.id === "string",
        )
        .map((addon) => viewForAddon(addon, { pinned: pinned.has(addon.id) }))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      // Chrome provenance (source, verdict, security, how the package
      // survives a restart) comes from Astra's record, not AddonManager.
      const decorated = await ChromeExtensions.decorate(views);
      scheduleActions();
      return decorated;
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
      await ChromeExtensions.setEnabled({ id, enabled }).catch(() => {});
      scheduleActions();
      return null;
    } catch {
      throw fail("the engine refused the change");
    }
  },

  async uninstall({ id = "" } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    const manager = await addonManager();
    let timer = 0;
    const removed = new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        try {
          manager?.removeAddonListener?.(listener);
        } catch {
          // Already gone.
        }
        resolve(value);
      };
      const listener = {
        onUninstalled(uninstalled) {
          if (uninstalled?.id === id) finish(true);
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
        manager?.addAddonListener?.(listener);
      } catch {
        // The manager may not expose listeners in this build.
      }
      timer = setTimeout(() => finish(false), 5000);
    });
    try {
      await addon.uninstall();
    } catch {
      throw fail("the engine refused to uninstall");
    }
    await removed;
    await ChromeExtensions.forget({ id }).catch(() => {});
    scheduleActions();
    return null;
  },

  /** Review an extension package on disk without installing it yet. */
  async prepareFile({ path = "" } = {}) {
    if (typeof path !== "string" || path === "")
      throw fail("no package selected");
    if (isChromePackagePath(path)) {
      return ChromeExtensions.prepareFile({ path, source: "chrome" });
    }
    const manager = await addonManager();
    const FileUtils = await fileUtils();
    if (!manager || !FileUtils)
      throw fail("the engine cannot install extensions");
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
    Object.assign(review, await installPermissionDetails(install));
    REVIEWS.set(reviewId, { install, review });
    return review;
  },

  /** Install the package the review named. */
  async confirm({
    id = "",
    review_id = "",
    reviewId = "",
    private_windows = false,
    technical_data = true,
  } = {}) {
    const key = review_id || reviewId;
    const choice = {
      name: "",
      privateWindows: private_windows === true,
      technicalData: technical_data !== false,
    };
    if (String(key).startsWith("chrome-review-")) {
      const entry = REVIEWS.get(key);
      choice.name = String(entry?.review?.name ?? "");
      _autoAnswer = choice;
      try {
        return await ChromeExtensions.confirm({ review_id: key });
      } finally {
        _autoAnswer = null;
      }
    }
    const entry = REVIEWS.get(key);
    if (!entry) throw fail("this review is no longer available");
    if (id !== "" && entry.review.id !== "" && id !== entry.review.id) {
      throw fail("the package does not match the review");
    }
    REVIEWS.delete(review_id || reviewId);
    choice.name = String(entry.review.name ?? "");
    // A Firefox package has no manifest details before the engine downloads
    // it. Its permission prompt is the review, so it must reach the app.
    _autoAnswer = entry.review.warnings.length > 0 ? choice : null;
    try {
      await entry.install.install();
      scheduleActions();
      return null;
    } catch {
      throw fail("the engine refused the install");
    } finally {
      _autoAnswer = null;
    }
  },

  /** Drop a review without installing. */
  async cancel({ review_id = "", reviewId = "" } = {}) {
    const key = review_id || reviewId;
    if (String(key).startsWith("chrome-review-")) {
      return ChromeExtensions.cancel({ review_id: key });
    }
    const entry = REVIEWS.get(key);
    if (!entry) return undefined;
    REVIEWS.delete(review_id || reviewId);
    try {
      entry.install.cancel();
    } catch {
      // Already cancelled or installed.
    }
    return undefined;
  },

  /** Pin or unpin an extension's toolbar action. */
  async setPinned({ id = "", pinned = false } = {}) {
    if (typeof id !== "string" || id === "") throw fail("no such extension");
    const ids = pinnedIds();
    if (pinned === true) ids.add(id);
    else ids.delete(id);
    if (ids.size > 3) throw fail("at most three actions can be pinned");
    savePinnedIds(ids);
    scheduleActions();
    return null;
  },

  /** Reload a failed extension, which re-runs its startup. */
  async retry({ install_id = "", installId = "", id = "" } = {}) {
    const key = install_id || installId || id;
    const addon = await findAddon(key);
    if (!addon) {
      const record = await ChromeExtensions.record({ id: key }).catch(
        () => null,
      );
      if (record) {
        await ChromeExtensions.restore();
        return null;
      }
      throw fail("no such extension");
    }
    try {
      await addon.reload();
      return null;
    } catch {
      throw fail("the engine could not restart the extension");
    }
  },

  /**
   * Change what an extension may reach. Only permissions the extension
   * declared as optional can be granted or revoked; a manifest grant is fixed
   * and the engine refuses, which is reported rather than hidden.
   */
  async setAccess({ id = "", mode = "", sites = [] } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    let permissions = null;
    try {
      permissions = ChromeUtils.importESModule(
        "resource://gre/modules/ExtensionPermissions.sys.mjs",
      ).ExtensionPermissions;
    } catch {
      permissions = null;
    }
    if (!permissions) throw fail("the engine cannot change site access");
    const origins = Array.isArray(sites)
      ? sites.filter((site) => typeof site === "string")
      : [];
    try {
      if (mode === "all") {
        await permissions.add(id, {
          permissions: ["<all_urls>"],
          origins: ["<all_urls>"],
        });
      } else if (mode === "sites" && origins.length > 0) {
        await permissions.add(id, { permissions: [], origins });
      } else {
        const current = await permissions.get(id);
        const revoke = [...(current?.origins ?? []), ...origins];
        if (revoke.length > 0) {
          await permissions.remove(id, { permissions: [], origins: revoke });
        }
      }
      return null;
    } catch {
      throw fail("this extension's site access is fixed by its manifest");
    }
  },

  /**
   * The store listing's own button is drawn by Astra's chrome, so the host has
   * nothing to move; answering `true` keeps the caller honest about delivery.
   */
  async storeButton() {
    return true;
  },

  /** The access prompt is Astra's own; accepting it needs no native step. */
  async answerAccess() {
    return null;
  },

  /**
   * Review the extension a store listing in `tabId` offers. Chrome Web Store
   * packages (CRX) are not installable by this engine; AMO listings resolve to
   * their signed XPI.
   */
  async prepare({ tab_id = "", tabId = "" } = {}) {
    const { tabs } = __tabsState();
    const tab = tabs.get(String(tab_id || tabId));
    // A tab created a moment ago can be selected while the model has not
    // recorded its URL yet. The listing is the tab, not the selection; give
    // the commit a short grace period instead of failing on an empty string.
    let url = tab?.url ?? "";
    for (let attempt = 0; attempt < 12 && url === ""; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      url = tab?.url ?? "";
    }
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:")
      throw fail("this page is not an extension listing");
    const manager = await addonManager();
    if (!manager) throw fail("the engine cannot install extensions");
    if (storeIdFromUrl(url)) {
      return ChromeExtensions.prepareStore({ url });
    }
    let xpi = "";
    if (
      parsed.hostname === "addons.mozilla.org" ||
      parsed.hostname === "addons-dev.allizom.org"
    ) {
      const slug =
        /^\/(?:[^/]+\/)?(?:firefox\/)?addon\/([^/]+)/.exec(
          parsed.pathname,
        )?.[1] ?? "";
      if (slug === "") throw fail("this page is not an extension listing");
      xpi = `${parsed.origin}/firefox/downloads/latest/${slug}/latest.xpi`;
    } else {
      throw fail("this page is not an extension listing");
    }
    let install = null;
    try {
      install = await manager.getInstallForURL(xpi, {});
    } catch {
      install = null;
    }
    if (!install) throw fail("the listing's package could not be read");
    _nextReview += 1;
    const reviewId = `ext-review-${_nextReview}`;
    const review = reviewFor(reviewId, install, false);
    Object.assign(review, await installPermissionDetails(install));
    if (review.name === "" && /^[\w.-]+$/u.test(slug)) {
      review.name = slug.replaceAll("-", " ").replaceAll("_", " ");
    }
    REVIEWS.set(reviewId, { install, review });
    return review;
  },

  /** Review a pending update for an installed extension. */
  async reviewUpdate({ id = "" } = {}) {
    const addon = await findAddon(id);
    if (!addon) throw fail("no such extension");
    const pending = addon.pendingUpgrade ?? null;
    if (!pending) throw fail("this extension has no update waiting");
    _nextReview += 1;
    const reviewId = `ext-review-${_nextReview}`;
    const review = {
      ...reviewFor(reviewId, { addon: pending }, false),
      id: String(addon.id ?? ""),
      update: true,
    };
    REVIEWS.set(reviewId, {
      install: { install: () => pending.install?.() ?? Promise.resolve() },
      review,
    });
    return review;
  },

  /** Native picker: a folder (temporary add-on) or an .xpi file to review. */
  async chooseFile({ folder = false } = {}) {
    const manager = await addonManager();
    if (!manager) throw fail("the engine cannot install extensions");
    try {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker,
      );
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      // nsIFilePicker.init is typed against a BrowsingContext in this engine.
      const context = win?.browsingContext ?? null;
      if (!context) return null;
      picker.init(
        context,
        folder ? "Choose extension folder" : "Choose extension package",
        folder ? Ci.nsIFilePicker.modeGetFolder : Ci.nsIFilePicker.modeOpen,
      );
      if (!folder) picker.appendFilter("Extensions", "*.xpi;*.crx;*.zip");
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
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
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
export function __resetWebExtensionsForTests() {
  __resetChromeExtensionsForTests();
  PROMPTS.clear();
  _activePrompt = null;
  _autoAnswer = null;
  _nextPrompt = 0;
  ACTION_WINDOWS.clear();
  _actionRevision = 0;
  _actionPublish = Promise.resolve();
  if (_actionTimer !== null) clearTimeout(_actionTimer);
  _actionTimer = null;
  if (_actionsOff) _actionsOff();
  _actionsOff = null;
}
