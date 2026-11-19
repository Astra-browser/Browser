/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Launcher module (v1).
//
// The launcher owns its recorder, so its accelerator is not a Keyboard row
// (`Keymap` leaves `launcher.toggle` out of the editable registry). The
// shortcut lives in the Settings store under `launcher.shortcut`, in the same
// canonical accelerator text the keymap uses, and the chrome key handler reads
// it back to open the launcher.
//
// `registered` is whether that shortcut is live. The browser answers that
// itself: the overlay is part of the app, so a shortcut the app accepted is one
// that opens the launcher. A refusal is reported with the reason the person can
// act on (no modifier, the system's own key, another command's key, or an
// accelerator this platform cannot carry).
//
// Pure logic: no chrome at import time, so Node contract tests can load it.

import { Keymap } from "./Keymap.sys.mjs";
import { Settings } from "./Settings.sys.mjs";
import { emit } from "./Events.sys.mjs";

const SHORTCUT_KEY = "launcher.shortcut";
const DOUBLE_TAP_KEY = "launcher.double-tap";
const DEFAULT_SHORTCUT = "CmdOrCtrl+Shift+Space";
const DOUBLE_TAP_MODES = new Set(["off", "command", "option"]);

/**
 * Whether the desktop took the shortcut. Unknown until the core answers: the
 * first read registers it, so a fresh window reports what the system said
 * rather than guessing.
 */
let _registered = false;

/**
 * Keys the desktop or an application already answers to. Recording one would
 * either be swallowed before it reached us or take a shortcut away from the
 * app in front, so they are refused with the reason rather than accepted.
 */
const SYSTEM_KEYS = new Set([
  "Alt+F4",
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Ctrl+Alt+Delete",
  "Meta+Tab",
  "Meta+Space",
  "Ctrl+Escape",
  "Ctrl+Shift+Escape",
]);

/** Editing and window keys every app answers to; taking one breaks it. */
const APP_KEYS = new Set([
  "Ctrl+A",
  "Ctrl+C",
  "Ctrl+F",
  "Ctrl+N",
  "Ctrl+O",
  "Ctrl+P",
  "Ctrl+R",
  "Ctrl+S",
  "Ctrl+T",
  "Ctrl+V",
  "Ctrl+W",
  "Ctrl+X",
  "Ctrl+Y",
  "Ctrl+Z",
  "Cmd+A",
  "Cmd+C",
  "Cmd+F",
  "Cmd+N",
  "Cmd+O",
  "Cmd+P",
  "Cmd+Q",
  "Cmd+R",
  "Cmd+S",
  "Cmd+T",
  "Cmd+V",
  "Cmd+W",
  "Cmd+X",
  "Cmd+Y",
  "Cmd+Z",
]);

/** `CmdOrCtrl` resolved to the platform's own modifier, for comparisons. */
function platformText(accelerator, mac) {
  if (typeof accelerator !== "string") return "";
  return accelerator.replaceAll("CmdOrCtrl", mac ? "Cmd" : "Ctrl");
}

/**
 * Whether an accelerator names a live modifier. Shift alone types a capital,
 * so it does not make a key global.
 */
function hasModifier(text) {
  return /(^|\+)(Ctrl|Cmd|Alt|Option|Meta|Win|Super)(\+|$)/iu.test(text);
}

function currentPlatform() {
  try {
    const os = globalThis.Services?.appinfo?.OS;
    if (typeof os === "string") return os.toLowerCase().includes("darwin") ? "mac" : "windows";
  } catch {
    // No Services in a test/preview: the module keeps its Windows default.
  }
  return "windows";
}

/** A stable answer for the id the UI keys this row on. */
function state({ shortcut, doubleTap, registered }) {
  return {
    shortcut,
    default_shortcut: DEFAULT_SHORTCUT,
    registered,
    editable: true,
    double_tap: doubleTap,
    // Noticing a modifier tapped twice while another app is in front needs a
    // low-level keyboard hook, which this host does not install.
    double_tap_supported: false,
    accessibility: false,
  };
}

async function storedShortcut() {
  const value = await Settings.get({ key: SHORTCUT_KEY });
  return typeof value === "string" && value !== "" ? value : DEFAULT_SHORTCUT;
}

async function storedDoubleTap() {
  const value = await Settings.get({ key: DOUBLE_TAP_KEY });
  return DOUBLE_TAP_MODES.has(value) ? value : "off";
}

async function currentState() {
  return state({
    shortcut: await storedShortcut(),
    doubleTap: await storedDoubleTap(),
    registered: _registered,
  });
}

/**
 * Hands the shortcut to the core, which registers it with the desktop. The
 * answer is the system's: another application may already hold the key.
 */
async function applyShortcut(accelerator) {
  try {
    const { Boot } = await import("./Boot.sys.mjs");
    const reply = await Boot.launcherShortcut({ accelerator });
    // "cleared" is the recorder standing the hotkey down, not a failure.
    if (reply?.reason === "cleared") return reply;
    _registered = reply?.registered === true;
    return reply ?? { registered: false, reason: "unavailable" };
  } catch {
    _registered = false;
    return { registered: false, reason: "unavailable" };
  }
}

/** Writes a value, and answers whether the store took it. */
async function write(key, value) {
  const result = await Settings.set({ key, value });
  return result?.accepted === true;
}

export const Launcher = {
  async trigger() {
    // Reading is when the shortcut reaches the desktop, so opening Settings
    // (or the app's startup read) registers it and reports the real answer.
    const shortcut = await storedShortcut();
    await applyShortcut(shortcut);
    return currentState();
  },

  /**
   * Hand a page's address to the launcher for editing. The sidebar field is
   * one line wide; the launcher can show the whole URL and its suggestions.
   * The app owns the overlay, so this only announces the edit — the address
   * is untouched until the person submits something.
   *
   * Returns whether the address was handed over. A tab id alone is not
   * enough: the URL is what the field must show, so a missing or non-web
   * address is refused instead of opening an empty launcher.
   */
  async edit({ tab_id = "", tabId = "", url = "" } = {}) {
    // The relay carries wire names (`tab_id`); the binding's camelCase name is
    // accepted too so a direct caller cannot silently be refused.
    const id = typeof tab_id === "string" && tab_id !== "" ? tab_id : tabId;
    if (typeof id !== "string" || id === "") return false;
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return false;
    }
    // The command channel carries the address verbatim, encoded so the `=`
    // inside a query string cannot be mistaken for the separator.
    emit("ui-command", `launcher.edit=${encodeURIComponent(parsed.href)}`);
    return true;
  },

  /**
   * Records a new accelerator. `null` is not a shortcut: the caller resets to
   * the default instead.
   */
  async setShortcut({ accelerator = "" } = {}) {
    const text = typeof accelerator === "string" ? accelerator.trim() : "";
    if (text === "") return null;
    const mac = currentPlatform() === "mac";
    const canonical = await Keymap.canonical(text, mac ? "mac" : "other");
    if (canonical === null) {
      return { type: "rejected", reason: "invalid", trigger: await currentState() };
    }
    const platform = platformText(canonical, mac);
    let reason = null;
    if (SYSTEM_KEYS.has(platform)) reason = "system";
    else if (APP_KEYS.has(platform)) reason = "app_command";
    else if (!hasModifier(canonical)) reason = "needs_modifier";
    else {
      // Another product command already answering to these keys is a
      // conflict, not a silent override: the person chooses which one keeps
      // them, which is what Keyboard settings is for.
      const entries = await Keymap.entries();
      const held = entries.find(
        (entry) =>
          entry.id !== "launcher.toggle" &&
          entry.accelerator !== null &&
          platformText(entry.accelerator, mac) === platform,
      );
      if (held) reason = "unavailable";
    }
    if (reason !== null) {
      return { type: "rejected", reason, trigger: await currentState() };
    }
    // The desktop has the last word: a key another app holds is not applied,
    // so the stored shortcut does not move either.
    const applied = await applyShortcut(canonical);
    if (applied?.registered !== true) {
      await applyShortcut(await storedShortcut());
      return { type: "rejected", reason: "unavailable", trigger: await currentState() };
    }
    if (!(await write(SHORTCUT_KEY, canonical))) {
      return { type: "rejected", reason: "unavailable", trigger: await currentState() };
    }
    return { type: "applied", trigger: await currentState() };
  },

  /**
   * Silences the shortcut while the recorder is listening. The chrome key
   * handler asks this before matching, so the keys reach the recorder; the
   * desktop registration stands down for the same reason.
   */
  async recordShortcut({ active = false } = {}) {
    const listening = active === true;
    await Keymap.record({ active: listening });
    await applyShortcut(listening ? "" : await storedShortcut());
    return undefined;
  },

  /**
   * Hands the stored shortcut to the core again. The core starts after the
   * app, so the first read can arrive before there is anything to register.
   */
  async reapply() {
    return applyShortcut(await storedShortcut());
  },

  async setDoubleTap({ mode = "off" } = {}) {    if (!DOUBLE_TAP_MODES.has(mode)) return currentState();
    await write(DOUBLE_TAP_KEY, mode);
    return currentState();
  },

  // The double-tap row is not offered on this host, so there is no permission
  // to ask for. Answering false keeps the button honest if a build shows it.
  async openAccessibility() {
    return false;
  },
};

/** Test-only: forget what a previous test wrote. */
export function __resetLauncherForTests() {
  return undefined;
}
