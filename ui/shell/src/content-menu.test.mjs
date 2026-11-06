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
import { devTabFor, isContentBrowser, showDevTools } from "./content-menu.js";

/** A chrome window with a tab strip that finds `tab` for any browser. */
function fakeWindow({ tab = null, toolbox = null, enabled = true, throwOnImport = false } = {}) {
  const created = [];
  const win = {
    created,
    opened: null,
    gBrowser: tab === null ? null : { getTabForBrowser: () => tab },
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
      gBrowser: { getTabForBrowser: (candidate) => (candidate?.id === browser.id ? {} : null) },
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

describe("showDevTools", () => {
  it("opens the requested tool on the real tab, in a window", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const destroyed = [];
    const win = fakeWindow({ tab, toolbox: { destroy: () => destroyed.push("toolbox") } });
    const result = await showDevTools(win, browser, "inspector");
    assert.deepEqual(result, { accepted: true });
    assert.equal(win.opened.tab, tab);
    assert.equal(win.opened.options.toolId, "inspector");
    assert.equal(win.opened.options.hostType, "window");
    assert.equal(win.opened.options.reason, "ContextMenu");
    // A tool that is already open is raised, never closed.
    assert.deepEqual(destroyed, []);
  });

  it("toggles closed when a key command finds an open toolbox", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const destroyed = [];
    const win = fakeWindow({ tab, toolbox: { destroy: () => destroyed.push("toolbox") } });
    const result = await showDevTools(win, browser, undefined, { reason: "KeyShortcut" });
    assert.deepEqual(result, { accepted: true, closed: true });
    assert.deepEqual(destroyed, ["toolbox"]);
    assert.equal(win.opened, null);
  });

  it("toggles open when no toolbox exists", async () => {
    const tab = { linkedBrowser: browser, tagName: "tab" };
    const win = fakeWindow({ tab, toolbox: null });
    const result = await showDevTools(win, browser, undefined, { reason: "KeyShortcut" });
    assert.deepEqual(result, { accepted: true });
    assert.equal(win.opened.options.toolId, undefined);
    assert.equal(win.opened.options.reason, "KeyShortcut");
  });

  it("refuses without a browser or with DevTools disabled", async () => {
    const win = fakeWindow({ tab: { linkedBrowser: browser } });
    assert.deepEqual(await showDevTools(win, null, undefined), { accepted: false });
    const disabled = fakeWindow({ tab: { linkedBrowser: browser }, enabled: false });
    assert.deepEqual(await showDevTools(disabled, browser, "inspector"), { accepted: false });
  });

  it("leaves a trace instead of swallowing a DevTools failure", async () => {
    const win = fakeWindow({ tab: { linkedBrowser: browser }, throwOnImport: true });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      assert.deepEqual(await showDevTools(win, browser, "inspector"), { accepted: false });
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /DevTools did not open/);
  });
});
