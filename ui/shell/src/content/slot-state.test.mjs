// Content slot presentation state. Pure logic, no DOM: run with
// `node --test` (or `bun test`) from the workspace root.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPageUrl, slotStateFor } from "./slot-state.js";

const page = (id, url, loading = false) => ({ id, url, loading });

describe("isPageUrl", () => {
  it("treats a New Tab and a missing address as no page", () => {
    assert.equal(isPageUrl("about:blank"), false);
    assert.equal(isPageUrl(""), false);
    assert.equal(isPageUrl(null), false);
    assert.equal(isPageUrl(undefined), false);
    assert.equal(isPageUrl(42), false);
  });

  it("accepts a real address", () => {
    assert.equal(isPageUrl("https://example.com/"), true);
    assert.equal(isPageUrl("about:preferences"), true);
  });
});

describe("slotStateFor", () => {
  it("shows the stage from the first moment of a load", () => {
    assert.deepEqual(slotStateFor({ type: "nav.started", data: { url: "https://a.example/" } }), {
      hasPage: true,
      loading: true,
    });
  });

  it("keeps a New Tab hidden when a blank load starts", () => {
    assert.deepEqual(slotStateFor({ type: "nav.started", data: { url: "about:blank" } }), {
      hasPage: false,
      loading: false,
    });
  });

  it("paints a committed page without the spinner", () => {
    assert.deepEqual(
      slotStateFor({ type: "nav.committed", data: { url: "https://a.example/", external: true } }),
      { hasPage: true, loading: false },
    );
  });

  it("keeps the cover on the model's own commit, not just a new address", () => {
    // `Navigation.loadURL` commits the address into the model immediately
    // (no `external`) so the address field and the tab row show the target at
    // once. The document is not in front yet, so the skeleton must stay.
    assert.equal(
      slotStateFor({ type: "nav.committed", data: { astra_tab_id: "t1", url: "https://a.example/" } }),
      null,
    );
  });

  it("hands the stage back on a commit to about:blank", () => {
    assert.deepEqual(
      slotStateFor({ type: "nav.committed", data: { url: "about:blank", external: true } }),
      { hasPage: false, loading: false },
    );
  });

  it("stops covering the page at the commit, not at the end of the load", () => {
    const committedUrl = "https://a.example/";
    const event = (tab) => ({
      type: "items-changed",
      data: { active: tab?.id ?? null, tabs: tab ? [tab] : [] },
    });
    // The document committed and is painting; images, fonts or analytics are
    // still arriving. The tab's own loading flag stays true, the stage's cover
    // does not come back — this is the "page arrives, then vanishes behind the
    // skeleton until load end" bug.
    assert.deepEqual(slotStateFor(event(page("t1", committedUrl, true)), { committedUrl }), {
      hasPage: true,
      loading: false,
    });
    // A different address that is still loading is a page the person has not
    // seen yet: cover it.
    assert.deepEqual(
      slotStateFor(event(page("t1", "https://b.example/", true)), { committedUrl }),
      { hasPage: true, loading: true },
    );
    // A projection that names the committed address but no longer loads is
    // still the page.
    assert.deepEqual(slotStateFor(event(page("t1", committedUrl, false)), { committedUrl }), {
      hasPage: true,
      loading: false,
    });
    // The cover belongs up again the moment a new address starts.
    assert.deepEqual(
      slotStateFor(
        { type: "nav.started", data: { astra_tab_id: "t1", url: "https://b.example/" } },
        { activeId: "t1", committedUrl },
      ),
      { hasPage: true, loading: true },
    );
    // The commit belongs to one tab: another tab loading the same address has
    // not been seen yet.
    assert.deepEqual(
      slotStateFor(event(page("t2", committedUrl, true)), { committedId: "t1", committedUrl }),
      { hasPage: true, loading: true },
    );
    assert.deepEqual(
      slotStateFor(event(page("t1", committedUrl, true)), { committedId: "t1", committedUrl }),
      { hasPage: true, loading: false },
    );
  });

  it("follows the active tab's address and load flag", () => {
    const event = (tab) => ({
      type: "items-changed",
      data: { active: tab?.id ?? null, tabs: tab ? [tab] : [] },
    });
    assert.deepEqual(slotStateFor(event(page("t1", "https://a.example/", true))), {
      hasPage: true,
      loading: true,
    });
    assert.deepEqual(slotStateFor(event(page("t1", "https://a.example/", false))), {
      hasPage: true,
      loading: false,
    });
    // A New Tab carries no URL in the projection.
    assert.deepEqual(slotStateFor(event(page("t1", null))), { hasPage: false, loading: false });
  });

  it("clears the stage when the projection has no active tab", () => {
    // The bug this pins: switching to a space with no tabs left the previous
    // space's page in front of the app's New Tab.
    assert.deepEqual(slotStateFor({ type: "items-changed", data: { active: null, tabs: [] } }), {
      hasPage: false,
      loading: false,
    });
    assert.deepEqual(slotStateFor({ type: "items-changed", data: { tabs: [] } }), {
      hasPage: false,
      loading: false,
    });
    // The active id naming a tab that is not in the projection is the same
    // "nothing to show" case, never "keep the old page".
    assert.deepEqual(
      slotStateFor({
        type: "items-changed",
        data: { active: "gone", tabs: [page("t2", "https://b.example/")] },
      }),
      { hasPage: false, loading: false },
    );
  });

  it("hides the engine panel behind a failed page", () => {
    assert.deepEqual(
      slotStateFor({
        type: "items-changed",
        data: {
          active: "t1",
          tabs: [
            {
              id: "t1",
              url: "https://bad.example/",
              failure: { url: "https://bad.example/", reason: "insecure", covers_page: true },
            },
          ],
        },
      }),
      { hasPage: false, loading: false },
    );
  });

  it("ignores navigation in a tab that is not in front", () => {
    const activeId = "tab-2";
    // A restoring background tab must not hide the page being read.
    assert.equal(
      slotStateFor(
        { type: "nav.started", data: { astra_tab_id: "tab-1", url: "https://a.example/" } },
        { activeId },
      ),
      null,
    );
    assert.equal(
      slotStateFor(
        { type: "nav.committed", data: { astra_tab_id: "tab-1", url: "https://a.example/" } },
        { activeId },
      ),
      null,
    );
    // The tab in front still reports.
    assert.deepEqual(
      slotStateFor(
        { type: "nav.started", data: { astra_tab_id: "tab-2", url: "https://a.example/" } },
        { activeId },
      ),
      { hasPage: true, loading: true },
    );
    // Without a known active tab (before the first projection) it reports.
    assert.deepEqual(
      slotStateFor(
        { type: "nav.started", data: { astra_tab_id: "tab-1", url: "https://a.example/" } },
        { activeId: "" },
      ),
      { hasPage: true, loading: true },
    );
  });

  it("says nothing about other events", () => {
    assert.equal(slotStateFor({ type: "tab.updated", data: { url: "https://a.example/" } }), null);
    assert.equal(slotStateFor({ type: "sidebar.changed", data: { width: 240 } }), null);
    assert.equal(slotStateFor(null), null);
    assert.equal(slotStateFor({ type: "items-changed" }), null);
    assert.equal(slotStateFor({ data: {} }), null);
  });
});
