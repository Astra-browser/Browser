#!/usr/bin/env python3
"""P3-T21 contract test (live side): the product UI is real chrome.

The app must run as a first-party `chrome://astra/` document inside the main
window — not as a `file://` page in an out-of-process browser with a message
relay. This test launches the built binary, switches to Marionette chrome
context, and asserts:

  1. the shell embeds an iframe whose document is
     `chrome://astra/content/app/browser-chrome.html` (same principal);
  2. that document's Svelte root actually rendered (#root has children), which
     is only possible when the `chrome://astra/` sanitization exemption
     (patch ASTRA-0006) is in the built engine;
  3. the bridge booted in host mode with no relay (`#root[data-bridge-mode]`);
  4. the shell retired its fallback chrome (`data-app-booted="true"`, titlebar
     and toolbar computed display:none);
  5. no `file://` app browser and no relay framescript remain in the window.

Usage: python3 tests/contract/shell_app_chrome.py
Exit 0 on PASS, 1 on FAIL, 2 on SKIP (no built binary). Stdlib only.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine"))
OBJDIR = os.path.join(ENGINE, "obj-astra-linux")
FIREFOX = os.environ.get("ASTRA_BINARY", os.path.join(OBJDIR, "dist", "bin", "firefox"))
PORT = int(os.environ.get("ASTRA_CHROME_PORT", "2829"))

FAILS = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


class Marionette:
    def __init__(self, port, timeout=60):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
                break
            except OSError as error:
                last = error
                time.sleep(1)
        else:
            raise RuntimeError(f"marionette never came up: {last}")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:400]}")
                return msg[3]


PROBE = """return JSON.stringify((() => {
  const shell = document.querySelector('.astra-frame');
  const frame = document.querySelector('iframe.astra-app-frame');
  const titlebar = document.querySelector('.astra-titlebar');
  const toolbar = document.querySelector('.astra-toolbar');
  const disp = (el) => el ? getComputedStyle(el).display : null;
  let app = null;
  try {
    const d = frame && frame.contentDocument;
    if (d) {
      const root = d.getElementById('root');
      app = {
        url: d.documentURI,
        title: d.title,
        bridgeMode: root ? root.dataset.bridgeMode ?? null : null,
        rootKids: root ? root.children.length : null,
        visible: root ? (root.style.opacity || "1") !== "0" : false,
        revealMs: d.documentElement ? (d.documentElement.dataset.astraReveal ?? null) : null,
        sidebar: !!d.querySelector('[data-astra-sidebar], aside'),
        newTab: !!d.querySelector('[data-astra-new-tab]'),
        // The first paint must already carry these: they used to arrive a
        // frame or two late (Space header, essentials drop target, account).
        // Real selectors from the app: SpaceBar + essentials drop + TabRow.
        // (textContent, not innerText: the root is hidden until first paint.)
        spaceHeader: !!d.querySelector('.space-bar')
          || /\bSpace\b/.test(d.body ? d.body.textContent : ''),
        dropTarget: !!d.querySelector('[data-essentials-drop]'),
        accountFoot: !!d.querySelector('.shelf .case, .utility-rail .rail-profile'),
        tabRow: d.querySelectorAll('[data-astra-tab-id]').length > 0,
        alerts: [...d.querySelectorAll('[role=alert]')].map(a => a.textContent.slice(0, 160)),
      };
    }
  } catch (e) { app = { error: String(e) }; }
  return {
    shellBooted: shell ? shell.getAttribute('data-app-booted') : null,
    titlebarDisplay: disp(titlebar),
    toolbarDisplay: disp(toolbar),
    frameSrc: frame ? frame.getAttribute('src') : null,
    // The duct-tape path must be gone: no XUL browser pointed at file://,
    // no relay framescript mounted on it.
    fileBrowsers: [...document.querySelectorAll('browser')]
      .map(b => { try { return b.currentURI.spec; } catch (e) { return 'ERR'; } })
      .filter(s => s && s.startsWith('file://')),
    relayScripts: document.querySelectorAll('[data-astra-relay]').length,
    app,
  };
})())"""


def main():
    if not os.path.exists(FIREFOX):
        print("SKIP no built binary at " + FIREFOX)
        return 2

    profile = tempfile.mkdtemp(prefix="astra-chrome-profile-")
    # `-marionette-port` is not a recognised flag in this build; the port
    # comes from the pref, so pin it before launch.
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as prefs:
        prefs.write(f'user_pref("marionette.port", {PORT});\n')
    errlog = open(os.path.join(profile, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [
            os.path.abspath(FIREFOX),
            "-profile", os.path.abspath(profile),
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(os.path.abspath(FIREFOX)),
        stdout=errlog,
        stderr=subprocess.STDOUT,
    )
    try:
        m = Marionette(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})

        state = None
        deadline = time.time() + 90
        first_doc = None
        complete = None
        # Snapshot the exact state at the moment the app becomes visible: that
        # frame must already contain every sidebar section.
        first_visible = None
        while time.time() < deadline:
            raw = m.cmd("WebDriver:ExecuteScript", {"script": PROBE, "args": []})["value"]
            state = json.loads(raw)
            app = state.get("app") or {}
            now = time.time()
            if first_doc is None and app.get("url"):
                first_doc = now
            if app.get("visible"):
                if first_visible is None:
                    first_visible = dict(app)
                complete = now
                break
            time.sleep(0.05)

        app = state.get("app") or {}
        check("app frame is a chrome:// document",
              (state.get("frameSrc") or "").startswith("chrome://astra/"),
              str(state.get("frameSrc")))
        check("app document loaded", bool(app.get("url")),
              str(app.get("error") or app))
        check("Svelte root rendered (sanitizer exemption live)",
              (app.get("rootKids") or 0) > 0, f"rootKids={app.get('rootKids')}")
        check("bridge booted host mode (no relay)",
              app.get("bridgeMode") == "host", str(app.get("bridgeMode")))
        check("app painted its own chrome",
              bool(app.get("sidebar")) and bool(app.get("newTab")),
              f"sidebar={app.get('sidebar')} newTab={app.get('newTab')}")
        # First-paint completeness: these sections are the ones that used to
        # appear a beat after the rest of the UI.
        fv = first_visible or {}
        check("first visible frame is complete (Space bar, tab row, drop target, account foot)",
              bool(fv.get("spaceHeader")) and bool(fv.get("tabRow"))
              and bool(fv.get("dropTarget")) and bool(fv.get("accountFoot")),
              f"space={fv.get('spaceHeader')} tab={fv.get('tabRow')} "
              f"drop={fv.get('dropTarget')} account={fv.get('accountFoot')}")
        check("Space section present", bool(app.get("spaceHeader")), str(app.get("spaceHeader")))
        check("essentials drop target present", bool(app.get("dropTarget")), str(app.get("dropTarget")))
        check("tab row present", bool(app.get("tabRow")), str(app.get("tabRow")))
        # "Instant" is measurable: the full sidebar must be on screen shortly
        # after the app document exists (no late Space section / drop target).
        elapsed_ms = None if (first_doc is None or complete is None) else round((complete - first_doc) * 1000)
        reveal_ms = app.get("revealMs")
        # The private Weston/pixman compositor used by hidden CI runs adds a
        # software-composition tax; the real-display contract stays 1200 ms.
        virtual = os.environ.get("ASTRA_TEST_VIRTUAL") == "1"
        reveal_budget = 2000 if virtual else 1200
        check(f"first complete frame revealed within {reveal_budget}ms of document start"
              + (" (virtual display)" if virtual else ""),
              reveal_ms is not None and int(reveal_ms) <= reveal_budget,
              f"reveal={reveal_ms}ms")
        check("sidebar complete within 1200ms of the app document",
              elapsed_ms is not None and elapsed_ms <= 1200,
              f"elapsed={elapsed_ms}ms")
        check("no app error alert", not app.get("alerts"), str(app.get("alerts"))[:200])
        check("shell retired fallback chrome",
              state.get("shellBooted") == "true", str(state.get("shellBooted")))
        check("fallback titlebar hidden", state.get("titlebarDisplay") == "none",
              str(state.get("titlebarDisplay")))
        check("fallback toolbar hidden", state.get("toolbarDisplay") == "none",
              str(state.get("toolbarDisplay")))
        check("no file:// app browser remains",
              not state.get("fileBrowsers"), str(state.get("fileBrowsers")))
        check("no relay framescript remains",
              (state.get("relayScripts") or 0) == 0, str(state.get("relayScripts")))
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        errlog.close()
        shutil.rmtree(profile, ignore_errors=True)

    if FAILS:
        print(f"shell_app_chrome: FAIL ({len(FAILS)} checks)")
        return 1
    print("shell_app_chrome: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
