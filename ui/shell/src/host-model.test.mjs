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

/** The smallest chrome-shaped DOM `Content.mount` accepts. */
function makeDom() {
  const doc = {
    defaultView: {
      Services: {
        scriptSecurityManager: { getSystemPrincipal: () => ({ principal: "system" }) },
      },
    },
    createElementNS: (_ns, tag) => makeElement(tag),
  };
  const container = makeElement("div");
  container.ownerDocument = doc;
  return { container, doc };
}

const browsersIn = (container) => container.children.filter((node) => node.tagName === "browser");

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
    // One entry, not two: Back has nowhere to go rather than landing on the
    // same address (which is the "Back does nothing" bug).
    assert.equal(back.went_back, false);
    assert.equal(back.url, "https://a.example/");
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

  it("stores an unsafe create as a New Tab", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const made = await Tabs.create({
      request_id: "c1",
      url: "data:text/html,<title>ASTRA-DATA</title>",
    });
    assert.equal(made.url, "about:blank");
    const tab = (await Tabs.get({ request_id: "g1", astra_tab_id: made.astra_tab_id })).tab;
    assert.equal(tab.url, "about:blank");

    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      assert.equal(browsersIn(container).length, 0);
      assert.equal(mounted.browser, null);
    } finally {
      mounted.detach();
    }
  });

  it("refuses an unsafe address that reaches the model anyway", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const { container, doc } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      const id = __itemsSnapshot().tabs[0].id;
      await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
      const page = mounted.browser;
      assert.deepEqual(page.loads, ["https://a.example/"]);

      // The projection (not `create`) carries the forbidden address: the
      // gate sits in `show`, on the one path to fixupAndLoadURIString.
      __applyExternalUpdate(id, { url: "file:///etc/hostname" });
      assert.equal(mounted.browser, null, "nothing unsafe is in front");
      assert.deepEqual(page.loads, ["https://a.example/"], "the browser was not pointed at it");
      assert.match(doc.defaultView.__astraLastRelayError ?? "", /content refused/);
    } finally {
      mounted.detach();
    }
  });
});

describe("content binding lifetime", () => {
  it("keeps one browser per page tab and none for a New Tab", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      assert.equal(browsersIn(container).length, 0, "a New Tab has no page browser");
      assert.equal(mounted.browser, null);

      const id = __itemsSnapshot().tabs[0].id;
      await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
      assert.equal(browsersIn(container).length, 1);
      assert.equal(mounted.browser?.requested, "https://a.example/");
      assert.equal(mounted.browser?.getAttribute("data-astra-browser"), "content");

      // A second report for the same tab must not create a second browser.
      await Tabs.setTitle({ request_id: "t1", astra_tab_id: id, title: "A" });
      await Tabs.setMuted({ request_id: "t2", astra_tab_id: id, muted: true });
      assert.equal(browsersIn(container).length, 1);
    } finally {
      mounted.detach();
    }
  });

  it("parks the stage when the projection has no active tab", async () => {
    // The reported bug: a new (empty) space left the previous space's page
    // painted on the stage.
    __resetForTests();
    await Tabs.bootstrap({});
    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      const first = __itemsSnapshot().tabs[0].id;
      await Navigation.loadURL({ request_id: "n1", astra_tab_id: first, url: "https://a.example/" });
      const page = mounted.browser;
      assert.equal(page?.hasAttribute("data-astra-browser"), true);

      await Tabs.createSpace({ request_id: "s1", name: "Two" });
      assert.equal(mounted.browser, null, "nothing of the old space is in front");
      assert.equal(page.hasAttribute("data-astra-browser-parked"), true);
      assert.equal(page.hasAttribute("data-astra-browser"), false);
      assert.equal(browsersIn(container).length, 1, "the page is kept, not reloaded");
    } finally {
      mounted.detach();
    }
  });

  it("forgets a closed tab and releases what it owned", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      const first = __itemsSnapshot().tabs[0].id;
      await Navigation.loadURL({ request_id: "n1", astra_tab_id: first, url: "https://a.example/" });
      const page = mounted.browser;
      assert.ok(page.listeners.get("oop-browser-crashed")?.size > 0, "crash listener attached");

      await Tabs.create({ request_id: "c1", url: "https://b.example/" });
      assert.equal(browsersIn(container).length, 2);

      const second = __itemsSnapshot().tabs.find((tab) => tab.url === "https://b.example/").id;
      await Tabs.close({ request_id: "c2", astra_tab_id: second });
      assert.equal(browsersIn(container).length, 1, "the closed tab's browser is gone");
      assert.equal(page.removed, false);
    } finally {
      mounted.detach();
    }
    // Detach is the window teardown path: every element and listener goes.
    assert.equal(browsersIn(container).length, 0);
    assert.equal(mounted.browsers.size, 0);
  });

  it("reloads a tab whose content process crashed", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    try {
      const id = __itemsSnapshot().tabs[0].id;
      await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
      const page = mounted.browser;
      assert.deepEqual(page.loads, ["https://a.example/"]);

      // The element still reports the address it died on; only the crash
      // signal says the page is gone.
      for (const handler of page.listeners.get("oop-browser-crashed") ?? []) {
        handler();
      }
      await Tabs.select({ request_id: "s1", astra_tab_id: id });
      assert.deepEqual(page.loads, ["https://a.example/", "https://a.example/"]);
    } finally {
      mounted.detach();
    }
  });

  it("detach clears listeners the binding added", async () => {
    __resetForTests();
    await Tabs.bootstrap({});
    const { container } = makeDom();
    const mounted = await Content.mount(container, { request_id: "m1" });
    const id = __itemsSnapshot().tabs[0].id;
    await Navigation.loadURL({ request_id: "n1", astra_tab_id: id, url: "https://a.example/" });
    const page = mounted.browser;
    assert.ok(page.listeners.get("oop-browser-crashed")?.size > 0);

    mounted.detach();
    assert.equal(page.listeners.get("oop-browser-crashed")?.size ?? 0, 0);
  });
});
