import { test } from "node:test";
import assert from "node:assert/strict";

import { isPopupWindow } from "./popup.js";

function fakeWindow({ closed = false, toolbarVisible = true, chromehidden = "" } = {}) {
  return {
    closed,
    toolbar: { visible: toolbarVisible },
    document: { documentElement: { getAttribute: () => chromehidden } },
  };
}

test("a browser window is not a popup", () => {
  assert.equal(isPopupWindow(fakeWindow()), false);
});

test("the main window's empty chromehidden is not a popup", () => {
  assert.equal(isPopupWindow(fakeWindow({ chromehidden: "" })), false);
});

test("a window with the toolbar hidden is a popup", () => {
  assert.equal(
    isPopupWindow(fakeWindow({ toolbarVisible: false, chromehidden: "menubar toolbar directories extrachrome " })),
    true,
  );
});

test("the chromehidden marker alone is enough", () => {
  assert.equal(isPopupWindow(fakeWindow({ chromehidden: "menubar toolbar " })), true);
  assert.equal(isPopupWindow(fakeWindow({ chromehidden: "location " })), true);
});

test("a closed or missing window is not a popup to mount into", () => {
  assert.equal(isPopupWindow(null), false);
  assert.equal(isPopupWindow(undefined), false);
  assert.equal(isPopupWindow(fakeWindow({ closed: true })), false);
});

test("a broken window object fails closed as a browser window", () => {
  const win = {
    get toolbar() {
      throw new Error("no toolbar");
    },
  };
  assert.equal(isPopupWindow(win), false);
});
