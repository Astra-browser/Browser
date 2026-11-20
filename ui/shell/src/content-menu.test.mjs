// DevTools entry points: which tab the toolbox attaches to, and whether a
// key command opens or closes. Runs against fake chrome objects, so no browser
// is needed: `node --test ui/shell/src`.
//
// Why this exists: a synthetic `<tab>` cannot be found by any tab-strip code
// path, so the toolbox could never be toggled and never closed with its tab,
// and a container tab was reported as the default container. The tests pin the
// real-tab preference and the open/close split.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEVTOOLS_MIN_HEIGHT,
  DEVTOOLS_MIN_WIDTH,
  devTabFor,
  devToolsWindowRect,
  isContentBrowser,
  placeToolboxWindow,
  scheduleToolboxPlacement,
  showDevTools,
  runChromeAction,
} from "./content-menu.js";

/** A chrome window with a tab strip that finds `tab` for any browser. */
function fakeWindow({
  tab = null,
  toolbox = null,
  enabled = true,
  throwOnImport = false,
  toolboxWindow = null,
} = {}) {
  const created = [];
  const win = {
    created,
    opened: null,
    gBrowser: tab === null ? null : { getTabForBrowser: () => tab },
    screenX: 100,
    screenY: 50,
    outerWidth: 1200,
    outerHeight: 800,
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
    Services: toolboxWindow
      ? {
          wm: {
            getMostRecentWindow: (type) =>
              type === "devtools:toolbox" ? toolboxWindow : null,
          },
        }
      : undefined,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    document: {
      createXULElement(name) {
        const element = {
          tagName: name,
          addEventListener() {},
          removeEventListener() {},
          getAttribute() {
            return null;
          },
        };
        created.push(element);
        return element;
      },
    },
    ChromeUtils: {
      importESModule() {
        if (throwOnImport) {
          throw new Error("devtools module missing");
        }
        return {
          DevToolsShim: {
            isEnabled: () => enabled,
            getToolboxForTab: () => toolbox,
            showToolboxForTab: async (target, options) => {
              win.opened = { tab: target, options };
            },
          },
        };
      },
    },
  };
  return win;
}

const browser = { id: "content-browser" };

describe("isContentBrowser", () => {
  it("recognises a browser the window's tabbrowser owns", () => {
    // The native deck docks gBrowser's browser in #tabbrowser-tabbox, so it is
    // no longer inside [data-astra-content]; the old containment-only test let
    // the engine's own page menu answer a right-click.
    const win = {
      gBrowser: {
        getTabForBrowser: (candidate) =>
          candidate?.id === browser.id ? {} : null,
      },
      document: { querySelector: () => null },
    };
    const contentBrowser = { ...browser, hasAttribute: () => false };
    assert.equal(isContentBrowser(win, contentBrowser), true);
  });

  it("refuses a browser from another window", () => {
    const win = {
      gBrowser: { getTabForBrowser: () => null },
      document: { querySelector: () => null },
    };
    assert.equal(isContentBrowser(win, { hasAttribute: () => false }), false);
  });
});

describe("devTabFor", () => {
  it("uses the real tabbrowser tab for a stage browser", () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const win = fakeWindow({ tab });
    assert.equal(devTabFor(win, browser), tab);
    assert.equal(win.created.length, 0);
  });

  it("keeps one stand-in per browser when the tab strip does not own it", () => {
    const win = fakeWindow({ tab: null });
    const first = devTabFor(win, browser);
    const second = devTabFor(win, browser);
    assert.equal(first, second);
    assert.equal(win.created.length, 1);
    assert.equal(first.linkedBrowser, browser);
    assert.equal(first.documentGlobal, win);
    assert.equal(first.userContextId, 0);
  });
});

describe("devToolsWindowRect", () => {
  const browserWindow = {
    screenX: 100,
    screenY: 50,
    outerWidth: 1200,
    outerHeight: 800,
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
  };

  it("grows the engine's 900x320 default into a window the panels fit in", () => {
    // The engine's toolbox window persists its own size; Astra's profile was
    // stuck at 1250x322, where the inspector sidebar is taller than the window.
    const rect = devToolsWindowRect(browserWindow, {
      left: 145,
      top: 316,
      width: 1250,
      height: 322,
    });
    assert.deepEqual(rect, { left: 75, top: 170, width: 1250, height: 560 });
  });

  it("leaves a usable window where the person put it", () => {
    assert.equal(
      devToolsWindowRect(browserWindow, {
        left: 120,
        top: 120,
        width: 1000,
        height: 700,
      }),
      null,
    );
  });

  it("brings a usable window that opened off the work area back on screen", () => {
    // Same size, moved over the browser window: the person's width/height stay.
    assert.deepEqual(
      devToolsWindowRect(browserWindow, {
        left: 2500,
        top: 100,
        width: 1000,
        height: 700,
      }),
      { left: 200, top: 100, width: 1000, height: 700 },
    );
  });

  it("never grows the toolbox past the display it opens on", () => {
    const small = {
      screenX: 0,
      screenY: 0,
      outerWidth: 780,
      outerHeight: 560,
      screen: { availLeft: 0, availTop: 0, availWidth: 800, availHeight: 600 },
    };
    assert.deepEqual(
      devToolsWindowRect(small, { left: 0, top: 0, width: 1250, height: 322 }),
      { left: 0, top: 0, width: 800, height: 560 },
    );
  });
});

describe("placeToolboxWindow", () => {
  it("sizes a sliver toolbox and centres it over the browser window", () => {
    const calls = [];
    const toolboxWindow = {
      screenX: 145,
      screenY: 316,
      outerWidth: 1250,
      outerHeight: 322,
      document: { readyState: "complete" },
      resizeTo(w, h) {
        calls.push(["resize", w, h]);
        this.outerWidth = w;
        this.outerHeight = h;
      },
      moveTo(x, y) {
        calls.push(["move", x, y]);
        this.screenX = x;
        this.screenY = y;
      },
    };
    const win = fakeWindow({ tab: { linkedBrowser: browser }, toolboxWindow });
    assert.deepEqual(placeToolboxWindow(win, toolboxWindow), {
      left: 75,
      top: 170,
      width: 1250,
      height: 560,
    });
    assert.deepEqual(calls, [
      ["resize", 1250, 560],
      ["move", 75, 170],
    ]);
  });

  it("does nothing to a toolbox the person already sized", () => {
    const calls = [];
    const toolboxWindow = {
      screenX: 120,
      screenY: 120,
      outerWidth: 1000,
      outerHeight: 700,
      document: { readyState: "complete" },
      resizeTo: (...args) => calls.push(args),
      moveTo: (...args) => calls.push(args),
    };
    const win = fakeWindow({ tab: { linkedBrowser: browser }, toolboxWindow });
    assert.equal(placeToolboxWindow(win, toolboxWindow), null);
    assert.deepEqual(calls, []);
  });

  it("finds the toolbox window when the caller does not pass one", () => {
    const calls = [];
    const toolboxWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 900,
      outerHeight: 320,
      document: { readyState: "complete" },
      resizeTo(w, h) {
        calls.push([w, h]);
        this.outerWidth = w;
        this.outerHeight = h;
      },
      moveTo() {},
    };
    const win = fakeWindow({ tab: { linkedBrowser: browser }, toolboxWindow });
    placeToolboxWindow(win);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1] >= DEVTOOLS_MIN_HEIGHT);
    assert.ok(calls[0][0] >= DEVTOOLS_MIN_WIDTH);
  });
});

describe("scheduleToolboxPlacement", () => {
  it("keeps checking until the engine's own window restore has landed", () => {
    // The first resize is thrown away by the persisted-size restore; the
    // retry has to see the sliver again and fix it.
    const calls = [];
    const toolboxWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 900,
      outerHeight: 320,
      document: { readyState: "complete" },
      resizeTo(w, h) {
        calls.push([w, h]);
        // first attempt: the engine overwrites it immediately
        this.outerWidth = 900;
        this.outerHeight = calls.length === 1 ? 320 : h;
      },
      moveTo() {},
    };
    const win = fakeWindow({ tab: { linkedBrowser: browser }, toolboxWindow });
    scheduleToolboxPlacement(win);
    assert.ok(calls.length >= 2);
    assert.ok(toolboxWindow.outerHeight >= DEVTOOLS_MIN_HEIGHT);
  });

  it("touches a usable window not at all", () => {
    const calls = [];
    const toolboxWindow = {
      screenX: 120,
      screenY: 120,
      outerWidth: 1000,
      outerHeight: 700,
      document: { readyState: "complete" },
      resizeTo: (...args) => calls.push(args),
      moveTo: (...args) => calls.push(args),
    };
    const win = fakeWindow({ tab: { linkedBrowser: browser }, toolboxWindow });
    scheduleToolboxPlacement(win);
    assert.deepEqual(calls, []);
  });
});

describe("showDevTools", () => {
  it("opens the requested tool on the real tab, in a window", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const destroyed = [];
    const win = fakeWindow({
      tab,
      toolbox: { destroy: () => destroyed.push("toolbox") },
    });
    const result = await showDevTools(win, browser, "inspector");
    assert.deepEqual(result, { accepted: true });
    assert.equal(win.opened.tab, tab);
    assert.equal(win.opened.options.toolId, "inspector");
    assert.equal(win.opened.options.hostType, "window");
    assert.equal(win.opened.options.reason, "ContextMenu");
    // A tool that is already open is raised, never closed.
    assert.deepEqual(destroyed, []);
  });

  it("gives the toolbox window a usable size after it opens", async () => {
    const calls = [];
    const toolboxWindow = {
      screenX: 0,
      screenY: 0,
      outerWidth: 900,
      outerHeight: 320,
      document: { readyState: "complete" },
      resizeTo(w, h) {
        calls.push(["resize", w, h]);
        this.outerWidth = w;
        this.outerHeight = h;
      },
      moveTo(x, y) {
        calls.push(["move", x, y]);
        this.screenX = x;
        this.screenY = y;
      },
    };
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const win = fakeWindow({ tab, toolboxWindow });
    assert.deepEqual(await showDevTools(win, browser, "inspector"), {
      accepted: true,
    });
    assert.equal(calls[0][0], "resize");
    assert.ok(calls[0][2] >= DEVTOOLS_MIN_HEIGHT);
  });

  it("toggles closed when a key command finds an open toolbox", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const destroyed = [];
    const win = fakeWindow({
      tab,
      toolbox: { destroy: () => destroyed.push("toolbox") },
    });
    const result = await showDevTools(win, browser, undefined, {
      reason: "KeyShortcut",
    });
    assert.deepEqual(result, { accepted: true, closed: true });
    assert.deepEqual(destroyed, ["toolbox"]);
    assert.equal(win.opened, null);
  });

  it("toggles open when no toolbox exists", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const win = fakeWindow({ tab, toolbox: null });
    const result = await showDevTools(win, browser, undefined, {
      reason: "KeyShortcut",
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(win.opened.options.toolId, undefined);
    assert.equal(win.opened.options.reason, "KeyShortcut");
  });

  it("refuses without a browser or with DevTools disabled", async () => {
    const win = fakeWindow({ tab: { linkedBrowser: browser } });
    assert.deepEqual(await showDevTools(win, null, undefined), {
      accepted: false,
    });
    const disabled = fakeWindow({
      tab: { linkedBrowser: browser },
      enabled: false,
    });
    assert.deepEqual(await showDevTools(disabled, browser, "inspector"), {
      accepted: false,
    });
  });

  it("leaves a trace instead of swallowing a DevTools failure", async () => {
    const win = fakeWindow({
      tab: { linkedBrowser: browser },
      throwOnImport: true,
    });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      assert.deepEqual(await showDevTools(win, browser, "inspector"), {
        accepted: false,
      });
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /DevTools did not open/);
  });
});

describe("chrome bookmark action privacy", () => {
  function privateWindow(isPrivate) {
    const utils = { isWindowPrivate: () => isPrivate };
    return {
      PrivateBrowsingUtils: utils,
      ChromeUtils: { importESModule: () => ({ PrivateBrowsingUtils: utils }) },
    };
  }
  function hostForBookmarks() {
    const calls = [];
    return {
      calls,
      Tabs: {
        list: async () => ({
          tabs: [
            { selected: true, url: "https://example.test/", title: "Example" },
          ],
        }),
      },
      Bookmarks: {
        call: async () => {
          calls.push("save");
          return { kind: "saved", id: "7" };
        },
      },
      emit() {},
    };
  }

  it("writes no bookmark from a private window", async () => {
    const host = hostForBookmarks();
    const result = await runChromeAction(
      privateWindow(true),
      host,
      "bookmark.current",
    );
    assert.deepEqual(result, { accepted: false });
    assert.deepEqual(host.calls, []);
  });

  it("writes the bookmark in a normal window", async () => {
    const host = hostForBookmarks();
    const result = await runChromeAction(
      privateWindow(false),
      host,
      "bookmark.current",
    );
    assert.equal(result.accepted, true);
    assert.deepEqual(host.calls, ["save"]);
  });
});
