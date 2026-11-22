#!/usr/bin/env node
// Window-close handshake contract.
//
// What this catches: a close that is never held (the app cannot flush), a close
// that is held forever (an app that never answers traps the window), an answer
// that closes the wrong window, and a refusal that closes anyway.
//
// Usage: node tests/contract/close_handshake.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const { Close, bindClose, __resetCloseForTests, __setAskTimeoutForTests } = await import(
  pathToFileURL(path.join(HOST, "Close.sys.mjs")).href
);
const { eventsSince, __resetEventsForTests } = await import(
  pathToFileURL(path.join(HOST, "Events.sys.mjs")).href
);

function fakeWindow() {
  const listeners = new Map();
  return {
    closed: false,
    prevented: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, target) {
      const event = {
        type,
        target: target ?? this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
      if (event.defaultPrevented) this.prevented += 1;
      return event;
    },
    close() {
      this.closed = true;
      // A real window dispatches `close` again when the close goes through.
      this.dispatch("close");
    },
  };
}

const tokenOf = (type) => {
  const found = eventsSince(0).events.filter((event) => event.type === type).pop();
  return found?.data ?? null;
};

// --- one window asks first ---------------------------------------------------
__resetEventsForTests();
__resetCloseForTests();
__setAskTimeoutForTests(5_000);
const win = fakeWindow();
bindClose(win);

const event = win.dispatch("close");
check("the close is held while the app flushes", event.defaultPrevented === true);
check("the window did not close yet", win.closed === false);
const token = tokenOf("resource-close");
check("the app is asked with a token", typeof token === "string" && token.length > 0);

const accepted = await Close.ready({ token, success: true });
check("a successful flush is accepted", accepted === true);
check("the window closes after the flush", win.closed === true);
check("the second close event is not held", win.prevented === 1);

// --- a refusal keeps the window open -----------------------------------------
__resetEventsForTests();
__resetCloseForTests();
const win2 = fakeWindow();
bindClose(win2);
win2.dispatch("close");
const token2 = tokenOf("resource-close");
const refused = await Close.ready({ token: token2, success: false });
check("a refusal is accepted as an answer", refused === true);
check("the window stays open on refusal", win2.closed === false);
check("the app is told the close was cancelled", tokenOf("resource-close-cancelled") === token2);

// --- a stale token cannot close a window it never saw ------------------------
check("a stale token is refused", (await Close.ready({ token: "close-9999", success: true })) === false);

// --- a second close request is held, not asked twice ------------------------
__resetEventsForTests();
__resetCloseForTests();
const win3 = fakeWindow();
bindClose(win3);
win3.dispatch("close");
win3.dispatch("close");
const asked = eventsSince(0).events.filter((event) => event.type === "resource-close");
check("one handshake per window", asked.length === 1);
check("the repeated close is still held", win3.prevented === 2);
await Close.ready({ token: asked[0].data, success: true });
check("the window closes once after the answer", win3.closed === true);

// --- an app that never answers cannot trap the window -----------------------
__resetEventsForTests();
__resetCloseForTests();
__setAskTimeoutForTests(10);
const win4 = fakeWindow();
bindClose(win4);
win4.dispatch("close");
check("the window is held at first", win4.closed === false);
await new Promise((resolve) => setTimeout(resolve, 30));
check("the deadline closes the window anyway", win4.closed === true);

// --- a dialog's close event is not the window closing ----------------------
// A `<dialog>` in the chrome-privileged app frame dispatches `close`, which
// reaches this capture listener. Treating it as a window close shut the
// browser when the split picker closed (live probe, 2026-11-22).
__resetEventsForTests();
__resetCloseForTests();
const win5 = fakeWindow();
bindClose(win5);
const dialog = { tagName: "DIALOG" };
const dialogEvent = win5.dispatch("close", dialog);
check("a dialog close is not held", dialogEvent.defaultPrevented === false);
check("a dialog close does not close the window", win5.closed === false);
check("a dialog close asks nothing", tokenOf("resource-close") === null);

__setAskTimeoutForTests(12_500);
__resetCloseForTests();
console.log(`\nclose handshake: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
