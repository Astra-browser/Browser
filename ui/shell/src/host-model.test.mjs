// Live-seam model tests for the shell's content and tab surfaces. These
// import the chrome host modules by relative path — they are pure logic (no
// Firefox internals at import time), which is why `tests/contract` can do the
// same thing. They live here because the shell lane owns them and `tests/` is
// another lane's file scope.
//
// Run with `node --test ui/shell/src` (or this file) from the repo root.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  Tabs,
  Navigation,
  Sidebar,
  __resetForTests,
  addEventListener,
} from "../../../overlay/astra/host/HostAPI.sys.mjs";
import { Content, isLoadableUrl } from "../../../overlay/astra/host/Content.sys.mjs";
import {
  __applyExternalUpdate,
  __itemsSnapshot,
  safeTabUrl,
} from "../../../overlay/astra/host/Tabs.sys.mjs";

/** A `<browser>` stand-in that records what the binding does to it. */
function makeElement(tag) {
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    tagName: tag,
    children: [],
    parent: null,
    attributes,
    listeners,
    isLoading: false,
    contentTitle: "",
    currentURI: null,
    requested: "",
    loads: [],
    removed: false,
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    append(child) {
      child.parent = element;
      element.children.push(child);
    },
    remove() {
      element.removed = true;
      if (element.parent) {
        element.parent.children = element.parent.children.filter((node) => node !== element);
        element.parent = null;
      }
    },
    addEventListener(type, fn, options) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
      if (options && options.signal) {
        options.signal.addEventListener("abort", () => set.delete(fn), { once: true });
      }
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    // Stands in for `fixupAndLoadURIString`: the page is now the current URI
    // and the document stays in flight until the test says otherwise.
    fixupAndLoadURIString(uri) {
      element.requested = uri;
      element.loads.push(uri);
      element.currentURI = { spec: uri };
      element.isLoading = true;
    },
    get webProgress() {
      return {
        get isLoadingDocument() {
          return element.isLoading;
        },
      };
    },
  };
  return element;
}


afterEach(() => {
  __resetForTests();
});

describe("tab selection stays inside the active space", () => {
  it("creates the new space with its own New Tab", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const first = __itemsSnapshot();
    assert.equal(first.tabs.length, 1);

    const made = await Tabs.createSpace({ request_id: "s1", name: "Two" });
    assert.equal(made.accepted, true);
    const second = __itemsSnapshot();
    assert.notEqual(second.active_space_id, first.active_space_id);
    assert.equal(second.tabs.length, 1, "the active space always has a tab");
    assert.equal(second.active, second.tabs[0].id, "the projection has something in front");
    assert.equal(second.tabs[0].url, null, "it is a New Tab, not about:blank");
  });

  it("replaces the last tab of the active space with a New Tab", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const only = __itemsSnapshot().tabs[0].id;
    await Navigation.loadURL({ request_id: "n1", astra_tab_id: only, url: "https://a.example/" });

    const res = await Tabs.close({ request_id: "c1", astra_tab_id: only });
    assert.equal(res.closed, true);
    const after = __itemsSnapshot();
    assert.equal(after.tabs.length, 1);
    assert.notEqual(after.tabs[0].id, only);
    assert.equal(after.active, after.tabs[0].id);
    assert.equal(after.tabs[0].url, null);
  });

  it("never selects a tab from another space when closing", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const inFirst = __itemsSnapshot().tabs[0].id;
    await Tabs.createSpace({ request_id: "s1", name: "Two" });
    const inSecond = __itemsSnapshot().tabs[0].id;
    // Back to space one, then close its only tab: the fallback must be a New
    // Tab in space one, not the live tab that belongs to space two.
    await Tabs.switchSpace({ request_id: "s2", space: "space-1" });
    const spaceOne = __itemsSnapshot().active_space_id;

    await Tabs.close({ request_id: "c1", astra_tab_id: inFirst });
    const after = __itemsSnapshot();
    assert.equal(after.active_space_id, spaceOne);
    assert.equal(after.tabs.length, 1);
    assert.notEqual(after.tabs[0].id, inSecond);
    assert.equal(after.active, after.tabs[0].id);
    const stillSecond = (await Tabs.list({})).tabs.find((tab) => tab.astra_tab_id === inSecond);
    assert.equal(stillSecond.space_id, "space-2");
    assert.equal(stillSecond.selected, false);
  });

  it("brings a tab's space forward when it is selected", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const first = __itemsSnapshot().tabs[0].id;
    await Tabs.createSpace({ request_id: "s1", name: "Two" });
    const secondSpace = __itemsSnapshot().active_space_id;

    const res = await Tabs.select({ request_id: "sel", astra_tab_id: first });
    assert.equal(res.url, "");
    const after = __itemsSnapshot();
    assert.equal(after.active_space_id, "space-1");
    assert.equal(after.active, first);
    assert.notEqual(secondSpace, after.active_space_id);
  });

  it("switching back to an emptied space lands on its New Tab", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    await Tabs.createSpace({ request_id: "s1", name: "Two" });
    const emptySpace = __itemsSnapshot().active_space_id;
    // Move the only tab of the active space to space one: this space is left
    // with nothing, and it is still the space in front.
    const only = __itemsSnapshot().tabs[0].id;
    await Tabs.moveTabToSpace({ request_id: "m1", tab: only, space: "space-1" });

    const afterMove = __itemsSnapshot();
    assert.equal(afterMove.active_space_id, emptySpace);
    assert.equal(afterMove.tabs.length, 1);
    assert.notEqual(afterMove.tabs[0].id, only);
    assert.equal(afterMove.active, afterMove.tabs[0].id);

    // And switching away and back keeps exactly one tab waiting there.
    await Tabs.switchSpace({ request_id: "s2", space: "space-1" });
    await Tabs.switchSpace({ request_id: "s3", space: emptySpace });
    const back = __itemsSnapshot();
    assert.equal(back.active_space_id, emptySpace);
    assert.equal(back.tabs.length, 1);
  });
  it("remembers which tab was in front in each space", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    await Tabs.create({ request_id: "c0", url: "https://a.example/" });
    const inFirst = __itemsSnapshot().active;

    await Tabs.createSpace({ request_id: "s1", name: "Two" });
    await Tabs.create({ request_id: "c1", url: "https://b.example/" });
    const inSecond = __itemsSnapshot().active;
    const newTab = __itemsSnapshot().tabs.find((tab) => tab.id !== inSecond)?.id;
    assert.ok(newTab, "the new space still has its New Tab");

    await Tabs.switchSpace({ request_id: "s2", space: "space-1" });
    assert.equal(__itemsSnapshot().active, inFirst, "space one returns to its tab");
    await Tabs.switchSpace({ request_id: "s3", space: "space-2" });
    assert.equal(__itemsSnapshot().active, inSecond, "space two returns to its tab");

    // Choosing the New Tab is remembered too, not reset to the first tab.
    await Tabs.select({ request_id: "sel", astra_tab_id: newTab });
    await Tabs.switchSpace({ request_id: "s4", space: "space-1" });
    await Tabs.switchSpace({ request_id: "s5", space: "space-2" });
    assert.equal(__itemsSnapshot().active, newTab);
  });

  it("closing the active tab selects the next one in its space", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const first = __itemsSnapshot().active;
    const second = (await Tabs.create({ request_id: "c1", url: "https://2.example/" })).astra_tab_id;
    const third = (await Tabs.create({ request_id: "c2", url: "https://3.example/" })).astra_tab_id;
    await Tabs.select({ request_id: "s", astra_tab_id: second });
    await Tabs.close({ request_id: "x", astra_tab_id: second });
    assert.equal(__itemsSnapshot().active, third, "the tab that took its place comes next");

    await Tabs.close({ request_id: "y", astra_tab_id: third });
    assert.equal(__itemsSnapshot().active, first, "closing the last falls back to the previous");
  });
});

describe("projection follows the model", () => {
  it("announces a title the page reported", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const id = __itemsSnapshot().tabs[0].id;
    const seen = [];
    const off = addEventListener((event) => {
      if (event.type === "items-changed") seen.push(event.data);
    });
    try {
      await Tabs.setTitle({ request_id: "t1", astra_tab_id: id, title: "Clicked title" });
    } finally {
      off();
    }
    const last = seen[seen.length - 1];
    assert.ok(last, "setTitle reaches the projection");
    assert.equal(last.tabs.find((tab) => tab.id === id).title, "Clicked title");
  });

  it("announces a duplicate with the source title", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const id = __itemsSnapshot().tabs[0].id;
    await Tabs.setTitle({ request_id: "t1", astra_tab_id: id, title: "Source" });
    const dup = await Tabs.duplicate({ request_id: "d1", astra_tab_id: id, background: true });
    assert.equal(dup.error, undefined, "a New Tab can be duplicated");
    const after = __itemsSnapshot();
    const copy = after.tabs.find((tab) => tab.id === dup.astra_tab_id);
    assert.equal(copy?.title, "Source");
    assert.equal(copy?.url, null, "the copy is a New Tab, not about:blank");
  });
});

describe("history", () => {
  it("treats a load of the address already in the bar as a reload", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const id = __itemsSnapshot().tabs[0].id;
    await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
    await Navigation.loadURL({ request_id: "n2", astra_tab_id: id, url: "https://a.example/" });

    const back = await Navigation.goBack({ request_id: "n3", astra_tab_id: id });
    // One entry, not two: the second load reloads in place, so Back steps off
    // the first page onto the New Tab the tab started on (owner report #9)
    // instead of landing on a second copy of the same address.
    assert.equal(back.went_back, true);
    assert.equal(back.url, "about:blank");
    const tab = (await Tabs.get({ request_id: "g1", astra_tab_id: id })).tab;
    assert.equal(tab.canGoBack, false);
  });

  it("still pushes a genuinely different address", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const id = __itemsSnapshot().tabs[0].id;
    await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
    await Navigation.loadURL({ request_id: "n2", astra_tab_id: id, url: "https://b.example/" });
    const back = await Navigation.goBack({ request_id: "n3", astra_tab_id: id });
    assert.equal(back.went_back, true);
    assert.equal(back.url, "https://a.example/");
  });
});

describe("sidebar reports", () => {
  it("refuses a negative column", async () => {
    __resetForTests();
    const res = await Sidebar.setWidth({ request_id: "w1", width: -40 });
    assert.equal(res.error?.code, "invalid_width");
    assert.equal((await Sidebar.get({})).width, null);
  });

  it("ignores a publisher from before the current revision", async () => {
    __resetForTests();
    await Sidebar.setWidth({ request_id: "w1", width: 240, animate: false, revision: 20 });
    const stale = await Sidebar.setWidth({ request_id: "w2", width: 400, revision: 19 });
    assert.equal(stale.width, 240, "an older publisher cannot move the page");
    const next = await Sidebar.setWidth({ request_id: "w3", width: 300, revision: 21 });
    assert.equal(next.width, 300);
    assert.equal((await Sidebar.get({})).width, 300);
  });
});

describe("content URL gate", () => {
  it("loads web addresses and nothing else", () => {
    for (const url of ["https://a.example/", "http://a.example/", "HTTPS://A.example/path"]) {
      assert.equal(isLoadableUrl(url), true, url);
      assert.equal(safeTabUrl(url), url, url);
    }
    for (const url of [
      "data:text/html,<title>x</title><script>1</script>",
      "file:///etc/hostname",
      "javascript:alert(1)",
      "blob:https://a.example/0b1c",
      "chrome://browser/content/browser.xhtml",
      "resource://astra/host/Content.sys.mjs",
      "view-source:https://a.example/",
      "about:blank",
      "about:preferences",
      "example.com",
      "",
    ]) {
      assert.equal(isLoadableUrl(url), false, url);
      assert.equal(safeTabUrl(url), "about:blank", url);
    }
    assert.equal(isLoadableUrl(null), false);
    assert.equal(safeTabUrl(undefined), "about:blank");
    assert.equal(safeTabUrl("about:blank"), "about:blank");
  });

});
