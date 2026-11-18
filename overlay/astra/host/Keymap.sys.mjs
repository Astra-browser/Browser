/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Keymap module (v1). The product command registry and the person's
// keymap, ported from `crates/astra-core/src/commands.rs`: one list feeds the
// menus, the palette, the launcher, the key handler and Keyboard settings, so
// a shortcut, a menu item and a button are one command rather than three
// paths.
//
// `entries` is what Keyboard settings draws; `bind`/`reset` are its writes.
// A conflict is reported, never resolved silently: the person decides what
// loses its key, and `replace` takes it from the other command in the same
// change. Durable storage belongs to astra-core (plan §5.4); until the
// sidecar is wired into the shell, bindings live in this window's session so
// the UI can read back what it wrote instead of silently reverting.
//
// Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";

/** How long an accelerator or command id may be, as in the native store. */
const MAX_ACCELERATOR_BYTES = 64;
const MAX_COMMAND_ID_BYTES = 64;

/** Default keys per platform. Conventions differ (Show All History is
 *  Command-Y on macOS but Ctrl+Y is Redo on Windows), so each side is
 *  declared rather than derived. */
const NONE = Object.freeze({ mac: null, other: null });
const same = (keys) => ({ mac: keys, other: keys });
const split = (mac, other) => ({ mac, other });
const macOnly = (keys) => ({ mac: keys, other: null });
const otherOnly = (keys) => ({ mac: null, other: keys });

function command(id, title, keys, group) {
  return { id, title, keys, group, alternateOf: null };
}

/** Another key for a command: it runs that command and is listed beside it
 *  in Keyboard settings. */
function alternate(id, title, keys, of) {
  return { id, title, keys, group: "keys", alternateOf: of };
}

/**
 * The canonical registry, in the order the native menus use. Every id, title,
 * default key per platform and group is the one in `commands.rs`.
 */
const REGISTRY = [
  command("browser.settings", "Settings…", same("CmdOrCtrl+,"), "app"),
  command("tab.new", "New Tab", same("CmdOrCtrl+T"), "file"),
  command(
    "window.newPrivate",
    "New Private Window",
    same("CmdOrCtrl+Shift+N"),
    "file",
  ),
  command("window.closePrivate", "Close Private Window", NONE, "file"),
  // The private window is a session the one window shows beside the regular
  // one. Toggling starts it when there is none, so the key is never dead;
  // the other two name a side, for the Window menu's checked entries.
  command(
    "window.togglePrivate",
    "Toggle Private Window",
    same("CmdOrCtrl+Shift+P"),
    "window",
  ),
  command("window.showRegular", "Regular Window", NONE, "window"),
  command("window.showPrivate", "Private Window", NONE, "window"),
  // Ctrl+Alt is AltGr on many Windows and Linux layouts, so only macOS gets
  // a default here.
  command("note.new", "New Note", macOnly("CmdOrCtrl+Alt+N"), "file"),
  command("split.choose", "Split View…", NONE, "file"),
  command("page.save", "Save Page As…", same("CmdOrCtrl+S"), "file"),
  command("page.print", "Print…", same("CmdOrCtrl+P"), "file"),
  command("tab.close", "Close Tab", same("CmdOrCtrl+W"), "file"),
  command("find.show", "Find…", same("CmdOrCtrl+F"), "edit"),
  command("find.next", "Find Next", same("CmdOrCtrl+G"), "edit"),
  command("find.previous", "Find Previous", same("CmdOrCtrl+Shift+G"), "edit"),
  command("page.copy", "Copy", same("CmdOrCtrl+C"), "edit"),
  command("page.cut", "Cut", same("CmdOrCtrl+X"), "edit"),
  command("page.paste", "Paste", same("CmdOrCtrl+V"), "edit"),
  command("page.copyLink", "Copy Link", same("CmdOrCtrl+Shift+C"), "edit"),
  command("page.autofillPassword", "AutoFill Password…", NONE, "edit"),
  command(
    "sidebar.toggleCompact",
    "Toggle Sidebar",
    same("CmdOrCtrl+Shift+S"),
    "view",
  ),
  command("nav.reload", "Reload Page", same("CmdOrCtrl+R"), "view"),
  alternate(
    "nav.reload.alt",
    "Reload Page (Alternate)",
    otherOnly("F5"),
    "nav.reload",
  ),
  command("nav.hardReload", "Hard Reload", same("CmdOrCtrl+Shift+R"), "view"),
  alternate(
    "nav.hardReload.alt",
    "Hard Reload (Alternate)",
    otherOnly("Ctrl+F5"),
    "nav.hardReload",
  ),
  alternate(
    "nav.hardReload.alt2",
    "Hard Reload (Second Alternate)",
    otherOnly("Shift+F5"),
    "nav.hardReload",
  ),
  command("nav.stop", "Stop Loading", same("CmdOrCtrl+."), "view"),
  command("page.viewSource", "View Page Source", same("CmdOrCtrl+U"), "view"),
  command(
    "page.devtools",
    "Developer Tools",
    split("CmdOrCtrl+Alt+I", "Ctrl+Shift+I"),
    "view",
  ),
  alternate(
    "page.devtools.alt",
    "Developer Tools (Alternate)",
    otherOnly("F12"),
    "page.devtools",
  ),
  // macOS has its own full screen key, and F11 there shows the desktop.
  command("window.fullscreen", "Full Screen", otherOnly("F11"), "keys"),
  command("url.focus", "Open Location", same("CmdOrCtrl+L"), "view"),
  command("zoom.in", "Zoom In", same("CmdOrCtrl+="), "view"),
  command("zoom.out", "Zoom Out", same("CmdOrCtrl+-"), "view"),
  command("zoom.reset", "Actual Size", same("CmdOrCtrl+0"), "view"),
  command("nav.back", "Back", same("CmdOrCtrl+["), "history"),
  command("nav.forward", "Forward", same("CmdOrCtrl+]"), "history"),
  command(
    "nav.home",
    "Home Page",
    split("CmdOrCtrl+Shift+H", "Alt+Home"),
    "history",
  ),
  // Alt+Arrow is text editing on macOS, where Command+[ and ] go back.
  alternate(
    "nav.back.alt",
    "Back (Alternate)",
    otherOnly("Alt+Left"),
    "nav.back",
  ),
  alternate(
    "nav.forward.alt",
    "Forward (Alternate)",
    otherOnly("Alt+Right"),
    "nav.forward",
  ),
  command(
    "tab.reopen",
    "Reopen Closed Tab",
    same("CmdOrCtrl+Shift+T"),
    "history",
  ),
  command(
    "browser.history",
    "Show All History",
    split("CmdOrCtrl+Shift+Y", "Ctrl+Shift+H"),
    "history",
  ),
  command(
    "bookmark.add",
    "Bookmark This Page",
    same("CmdOrCtrl+D"),
    "bookmarks",
  ),
  command(
    "tool.bookmarks",
    "Show Bookmarks",
    split("CmdOrCtrl+Shift+B", "Ctrl+Shift+O"),
    "bookmarks",
  ),
  command("tab.next", "Next Tab", same("Ctrl+Tab"), "window"),
  command("tab.previous", "Previous Tab", same("Ctrl+Shift+Tab"), "window"),
  alternate(
    "tab.next.alt",
    "Next Tab (Alternate)",
    split("CmdOrCtrl+Shift+]", "Ctrl+PageDown"),
    "tab.next",
  ),
  alternate(
    "tab.previous.alt",
    "Previous Tab (Alternate)",
    split("CmdOrCtrl+Shift+[", "Ctrl+PageUp"),
    "tab.previous",
  ),
  // The same walk down the sidebar as Ctrl+Tab, on the arrows that point
  // along it. Ctrl+Alt stays clear of text: only letters and digits are
  // AltGr's.
  command("tab.above", "Select Tab Above", same("CmdOrCtrl+Alt+Up"), "window"),
  command(
    "tab.below",
    "Select Tab Below",
    same("CmdOrCtrl+Alt+Down"),
    "window",
  ),
  // The tool panels, each on Shift and its own letter, as Bookmarks is.
  // Never Alt on Windows: Ctrl+Alt is AltGr on many layouts. History takes
  // the browser's own key; its full page moves to Shift.
  command(
    "tool.notes",
    "Notes",
    split("CmdOrCtrl+Shift+E", "Ctrl+Shift+E"),
    "window",
  ),
  command("tool.ai", "Ask Astra", same("CmdOrCtrl+E"), "window"),
  command(
    "tool.tasks",
    "Tasks",
    split("CmdOrCtrl+Shift+K", "Ctrl+Shift+K"),
    "window",
  ),
  command(
    "tool.time",
    "Time",
    split("CmdOrCtrl+Shift+U", "Ctrl+Shift+F"),
    "window",
  ),
  command("tool.history", "History", split("CmdOrCtrl+Y", "Ctrl+H"), "window"),
  command(
    "tool.downloads",
    "Downloads",
    split("CmdOrCtrl+Shift+J", "Ctrl+J"),
    "window",
  ),
  command("browser.tasks", "Show All Tasks", NONE, "window"),
  command("browser.notes", "Show All Notes", NONE, "window"),
  command("browser.time", "Show Time", NONE, "window"),
  command("settings.shortcuts", "Keyboard Shortcuts", NONE, "help"),
  command(
    "settings.clearData",
    "Clear Browsing Data…",
    split("CmdOrCtrl+Shift+Backspace", "Ctrl+Shift+Delete"),
    "keys",
  ),
  command("tab.select.1", "Select Tab 1", same("CmdOrCtrl+1"), "keys"),
  command("tab.select.2", "Select Tab 2", same("CmdOrCtrl+2"), "keys"),
  command("tab.select.3", "Select Tab 3", same("CmdOrCtrl+3"), "keys"),
  command("tab.select.4", "Select Tab 4", same("CmdOrCtrl+4"), "keys"),
  command("tab.select.5", "Select Tab 5", same("CmdOrCtrl+5"), "keys"),
  command("tab.select.6", "Select Tab 6", same("CmdOrCtrl+6"), "keys"),
  command("tab.select.7", "Select Tab 7", same("CmdOrCtrl+7"), "keys"),
  command("tab.select.8", "Select Tab 8", same("CmdOrCtrl+8"), "keys"),
  command("tab.select.last", "Select Last Tab", same("CmdOrCtrl+9"), "keys"),
  command(
    "space.select.1",
    "Switch to Space 1",
    split("Ctrl+1", "Ctrl+Shift+1"),
    "keys",
  ),
  command(
    "space.select.2",
    "Switch to Space 2",
    split("Ctrl+2", "Ctrl+Shift+2"),
    "keys",
  ),
  command(
    "space.select.3",
    "Switch to Space 3",
    split("Ctrl+3", "Ctrl+Shift+3"),
    "keys",
  ),
  command(
    "space.select.4",
    "Switch to Space 4",
    split("Ctrl+4", "Ctrl+Shift+4"),
    "keys",
  ),
  command(
    "space.select.5",
    "Switch to Space 5",
    split("Ctrl+5", "Ctrl+Shift+5"),
    "keys",
  ),
  command(
    "space.select.6",
    "Switch to Space 6",
    split("Ctrl+6", "Ctrl+Shift+6"),
    "keys",
  ),
  command(
    "space.select.7",
    "Switch to Space 7",
    split("Ctrl+7", "Ctrl+Shift+7"),
    "keys",
  ),
  command(
    "space.select.8",
    "Switch to Space 8",
    split("Ctrl+8", "Ctrl+Shift+8"),
    "keys",
  ),
  command(
    "space.select.9",
    "Switch to Space 9",
    split("Ctrl+9", "Ctrl+Shift+9"),
    "keys",
  ),
  command("space.next", "Next Space", same("CmdOrCtrl+Alt+Right"), "keys"),
  command(
    "space.previous",
    "Previous Space",
    same("CmdOrCtrl+Alt+Left"),
    "keys",
  ),
  command("work.pane.close", "Close Pane", same("Escape"), "work"),
  command(
    "work.pane.openInBrowse",
    "Open Pane in Browse",
    same("CmdOrCtrl+Shift+Return"),
    "work",
  ),
  // Starts and stops dictation in the Work bar; elsewhere it does nothing.
  command("work.dictate", "Dictate", same("CmdOrCtrl+Shift+D"), "keys"),
  command(
    "launcher.toggle",
    "Toggle Launcher",
    same("CmdOrCtrl+Shift+Space"),
    "global",
  ),
  command("theme.system", "Appearance: System", NONE, "global"),
  command("theme.light", "Appearance: Light", NONE, "global"),
  command("theme.dark", "Appearance: Dark", NONE, "global"),
];

/**
 * The feature switch a command belongs to (`ai`, `work`, `notes`, `tasks`,
 * `time`), so a command whose feature is off is neither offered nor run.
 */
export function featureOf(id) {
  switch (id) {
    case "work.dictate":
    case "tool.ai":
    case "mode.choose":
      return "ai";
    case "browser.work":
    case "mode.work":
      return "work";
    case "tool.notes":
    case "browser.notes":
    case "note.new":
      return "notes";
    case "tool.tasks":
    case "browser.tasks":
      return "tasks";
    case "tool.time":
    case "browser.time":
    case "settings.focus":
      return "time";
    default:
      if (typeof id !== "string") {
        return null;
      }
      if (id.startsWith("work.")) {
        return "work";
      }
      if (id.startsWith("focus.")) {
        return "time";
      }
      return null;
  }
}

function get(id) {
  return REGISTRY.find((command) => command.id === id) ?? null;
}

/** Keyboard settings may rebind everything but the launcher, which owns its
 *  own recorder, and Work bindings, which are fixed to the pane. */
function customizable(spec) {
  return spec.id !== "launcher.toggle" && spec.group !== "work";
}

function platformOf(platform) {
  return platform === "mac" ? "mac" : "other";
}

/**
 * The platform the window is running on, read from the chrome global when
 * there is one (the modules stay importable in Node, where it is absent).
 * The UI asks for the keymap without naming a platform, so the answer has to
 * be the machine's own.
 */
function currentPlatform() {
  try {
    const os = globalThis.Services?.appinfo?.OS;
    if (typeof os === "string") {
      return os.toLowerCase().includes("darwin") ? "mac" : "other";
    }
  } catch {
    // No Services in a test/preview: fall through to the non-mac default.
  }
  return "other";
}

// --- Accelerators ---------------------------------------------------------
//
// One parser serves the registry defaults, the person's bindings and the
// conflict check, so a shortcut means the same keys wherever it is read.
// Canonical text is platform-specific modifier names in a fixed order, as in
// the native accelerator module.

const NAMED_KEYS = new Map([
  ["TAB", "Tab"],
  ["SPACE", "Space"],
  ["ENTER", "Enter"],
  ["RETURN", "Enter"],
  ["ESCAPE", "Escape"],
  ["ESC", "Escape"],
  ["BACKSPACE", "Backspace"],
  ["DELETE", "Delete"],
  ["UP", "Up"],
  ["ARROWUP", "Up"],
  ["DOWN", "Down"],
  ["ARROWDOWN", "Down"],
  ["LEFT", "Left"],
  ["ARROWLEFT", "Left"],
  ["RIGHT", "Right"],
  ["ARROWRIGHT", "Right"],
  ["HOME", "Home"],
  ["END", "End"],
  ["PAGEUP", "PageUp"],
  ["PAGEDOWN", "PageDown"],
  ["COMMA", ","],
  ["PERIOD", "."],
  ["MINUS", "-"],
  ["EQUAL", "="],
  ["PLUS", "="],
  ["BRACKETLEFT", "["],
  ["BRACKETRIGHT", "]"],
  ["SEMICOLON", ";"],
  ["QUOTE", "'"],
  ["SLASH", "/"],
  ["BACKSLASH", "\\"],
  ["BACKQUOTE", "`"],
]);

const PUNCTUATION = new Set([
  ",",
  ".",
  "-",
  "=",
  "[",
  "]",
  ";",
  "'",
  "/",
  "\\",
  "`",
]);

function keyToken(token) {
  const upper = token.toUpperCase();
  if (upper.length === 1) {
    const char = upper;
    if (/[A-Z0-9]/u.test(char)) {
      return char;
    }
    if (PUNCTUATION.has(char)) {
      return char;
    }
    return null;
  }
  // Physical key codes, as a recorder reads them from a key event.
  const code = /^KEY([A-Z])$/u.exec(upper);
  if (code) {
    return code[1];
  }
  const digit = /^DIGIT([0-9])$/u.exec(upper);
  if (digit) {
    return digit[1];
  }
  const functionKey = /^F([1-9]|1[0-2])$/u.exec(upper);
  if (functionKey) {
    return `F${functionKey[1]}`;
  }
  const mouse = /^MOUSE([3-5])$/u.exec(upper);
  if (mouse) {
    return `Mouse${mouse[1]}`;
  }
  return NAMED_KEYS.get(upper) ?? null;
}

/** Canonical accelerator text for `platform`, or null when it is not one. */
function canonicalAccelerator(text, platform = "other") {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > MAX_ACCELERATOR_BYTES
  ) {
    return null;
  }
  const mac = platformOf(platform) === "mac";
  // "Ctrl++" names the plus key; splitting on '+' would lose it.
  let modifiers;
  let last;
  if (text.endsWith("++")) {
    modifiers = text.slice(0, -2);
    last = "+";
  } else {
    const at = text.lastIndexOf("+");
    modifiers = at === -1 ? "" : text.slice(0, at);
    last = at === -1 ? text : text.slice(at + 1);
  }
  const flags = { meta: false, ctrl: false, alt: false, shift: false };
  for (const part of modifiers.split("+").filter((part) => part !== "")) {
    const upper = part.toUpperCase();
    let flag;
    switch (upper) {
      case "CMDORCTRL":
      case "COMMANDORCONTROL":
        flag = mac ? "meta" : "ctrl";
        break;
      case "CMD":
      case "COMMAND":
      case "SUPER":
      case "META":
        // The system key is never ours outside macOS.
        if (!mac) {
          return null;
        }
        flag = "meta";
        break;
      case "CTRL":
      case "CONTROL":
        flag = "ctrl";
        break;
      case "ALT":
      case "OPTION":
        flag = "alt";
        break;
      case "SHIFT":
        flag = "shift";
        break;
      default:
        return null;
    }
    if (flags[flag]) {
      return null;
    }
    flags[flag] = true;
  }
  const key = keyToken(last === "+" ? "=" : last);
  if (key === null) {
    return null;
  }
  const parts = [];
  if (flags.meta) {
    parts.push("Cmd");
  }
  if (flags.ctrl) {
    parts.push("Ctrl");
  }
  if (flags.alt) {
    parts.push(mac ? "Option" : "Alt");
  }
  if (flags.shift) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

function defaultAccelerator(spec, platform) {
  return canonicalAccelerator(spec.keys[platformOf(platform)], platform);
}

// --- Session state --------------------------------------------------------

/** id -> canonical text, or null when the person unbound it. An id with no
 *  override uses its platform default. */
const _overrides = new Map();
const OVERRIDES_PREF = "astra.keymap.overrides";
let _loaded = false;
let _recording = false;

function loadOverrides() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = globalThis.Services?.prefs?.getStringPref(OVERRIDES_PREF, "");
    if (typeof raw !== "string" || raw === "") return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [id, value] of Object.entries(parsed)) {
      if (
        typeof id === "string" &&
        (typeof value === "string" || value === null)
      ) {
        _overrides.set(id, value);
      }
    }
  } catch {
    // A malformed preference falls back to the defaults.
  }
}

function saveOverrides() {
  try {
    const prefs = globalThis.Services?.prefs;
    if (!prefs) return;
    if (_overrides.size === 0) {
      prefs.clearUserPref(OVERRIDES_PREF);
      return;
    }
    prefs.setStringPref(
      OVERRIDES_PREF,
      JSON.stringify(Object.fromEntries(_overrides)),
    );
  } catch {
    // The in-memory map still applies for this session.
  }
}

function binding(spec, platform) {
  loadOverrides();
  if (_overrides.has(spec.id)) {
    return _overrides.get(spec.id);
  }
  return defaultAccelerator(spec, platform);
}

function outcome(kind) {
  return { kind };
}

export const Keymap = {
  /**
   * Canonical text for `text` on `platform`, or null when it is not an
   * accelerator. Lets the launcher validate its own recorder against the same
   * grammar the registry uses.
   */
  canonical(text, platform = null) {
    return canonicalAccelerator(
      text,
      platformOf(platform ?? currentPlatform()),
    );
  },

  /**
   * Every registry command with its current keys and defaults, sorted by id.
   * `accelerator` is the person's binding or the platform default;
   * `default_accelerator` is the registry default for that platform.
   */
  async entries({ platform = null } = {}) {
    const at = platformOf(platform ?? currentPlatform());
    return REGISTRY.map((spec) => {
      const fallback = defaultAccelerator(spec, at);
      const accelerator = binding(spec, at);
      return {
        id: spec.id,
        title: spec.title,
        group: spec.group,
        accelerator,
        default_accelerator: fallback,
        customizable: customizable(spec),
        customized: accelerator !== fallback,
      };
    }).sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  },

  /**
   * Binds `id` to `accelerator`, or unbinds it when null. A conflict names the
   * command that holds the keys; `replace` takes them from that command in the
   * same change. Returns the KeymapOutcome the UI consumes.
   */
  async bind({
    id = "",
    accelerator = null,
    replace = false,
    platform = null,
  } = {}) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_COMMAND_ID_BYTES ||
      (accelerator !== null && typeof accelerator !== "string")
    ) {
      return outcome("invalid");
    }
    const spec = get(id);
    if (spec === null) {
      // The native KeymapError::UnknownCommand is reported as `invalid`.
      return outcome("invalid");
    }
    if (!customizable(spec)) {
      return outcome("fixed");
    }
    const at = platformOf(platform ?? currentPlatform());
    const canonical =
      accelerator === null ? null : canonicalAccelerator(accelerator, at);
    if (accelerator !== null && canonical === null) {
      return outcome("invalid");
    }

    let displaced = null;
    if (canonical !== null) {
      const other = REGISTRY.find(
        (candidate) =>
          candidate.id !== id && binding(candidate, at) === canonical,
      );
      if (other !== undefined) {
        if (!replace || !customizable(other)) {
          return { kind: "conflict", command: other.id };
        }
        displaced = other.id;
      }
    }

    // Choosing the default again is a reset, so a later change to the default
    // reaches this person too.
    const fallback = defaultAccelerator(spec, at);
    if (canonical === fallback) {
      _overrides.delete(id);
    } else {
      _overrides.set(id, canonical);
    }
    if (displaced !== null) {
      _overrides.set(displaced, null);
    }
    saveOverrides();
    emit("keymap-changed", { version: 1 });
    return outcome("applied");
  },

  /**
   * Restores one command's default, or every default when `id` is null.
   * Returns false for an unknown id.
   */
  async reset({ id = null } = {}) {
    loadOverrides();
    if (id === null || id === undefined) {
      _overrides.clear();
      saveOverrides();
      emit("keymap-changed", { version: 1 });
      return true;
    }
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_COMMAND_ID_BYTES
    ) {
      return false;
    }
    if (get(id) === null) {
      return false;
    }
    _overrides.delete(id);
    saveOverrides();
    emit("keymap-changed", { version: 1 });
    return true;
  },

  /**
   * Starts or ends recording in Keyboard settings. Chrome ends it on every
   * exit path: a recorded key, Escape, losing focus, and leaving the page.
   * Window-level key handling belongs to the shell; this only holds the flag
   * it reads and acknowledges the change.
   */
  async record({ active = false } = {}) {
    _recording = active === true;
    return true;
  },
};

// Test-only: whether Keyboard settings is recording.
export function __keymapRecording() {
  return _recording;
}

// Test-only reset so contract tests start from a clean slate.
export function __resetKeymapForTests() {
  _overrides.clear();
  _loaded = false;
  _recording = false;
}
