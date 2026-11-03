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
    assert.deepEqual(slotStateFor({ type: "nav.committed", data: { url: "https://a.example/" } }), {
      hasPage: true,
      loading: false,
    });
  });

  it("hands the stage back on a commit to about:blank", () => {
    assert.deepEqual(slotStateFor({ type: "nav.committed", data: { url: "about:blank" } }), {
      hasPage: false,
      loading: false,
    });
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
