"""DOM-fullscreen probe: a video's fullscreen page must own the pointer.

Owner report (2026-11-20): fullscreen a video on any site (YouTube included)
and an invisible, transparent wall takes every move and press. The page never
sees hover, so its own controls never come up; clicks do nothing.

Root cause: the Astra content slot (`.astra-content`) is the rectangle the
native deck is docked over. In DOM fullscreen the chrome stylesheet raised
that empty, transparent slot to `z-index: 10` so the page could "fill the
window" - but the deck paints at `z-index: 2`, so the slot ended up above the
page across the whole window. It is transparent, so the video stayed visible,
and it takes the pointer, so the page saw nothing.

This probe drives a real page in the dev build:

  1. normal window: the page browser is the topmost element over the stage
  2. `requestFullscreen()` from the page enters DOM fullscreen and the deck
     fills the window
  3. every sampled point over the window resolves to the page browser, never
     to `.astra-content`; the slot reports `pointer-events: none`
  4. a synthetic pointer move reaches the page (its own hover listener fires)
  5. a synthetic press reaches the page (click count rises)
  6. leaving fullscreen restores the normal stage and the page still gets the
     pointer

Usage:
  python3 tools/marionette-probe/fullscreen-probe.py [--binary PATH] [--keep-open]

Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST = "127.0.0.1"
PORT = 2831
DEFAULT_BINARY = astra_env.BINARY

PAGE = """<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #102030; }
  #stage { position: absolute; inset: 0; background: #26482f; color: #fff;
           display: grid; place-items: center; font: 700 42px system-ui; }
</style>
<div id="stage">PAGE</div>
<script>
  window.__moves = [];
  window.__clicks = 0;
  document.addEventListener("mousemove", (event) => {
    window.__moves.push({ x: event.clientX, y: event.clientY,
                          target: event.target.id || event.target.tagName });
    if (window.__moves.length > 50) window.__moves.shift();
  }, true);
  document.addEventListener("click", () => { window.__clicks++; }, true);
</script>
"""

# Chrome-document read: what is on top where, and what the slot does with the
# pointer. Also mirrors the stage rectangle the shell publishes.
STATE_JS = """return JSON.stringify((() => {
  const q = (s) => document.querySelector(s);
  const slot = q('.astra-content');
  const mount = q('.astra-app-mount');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return { at: [x, y], chain: '' };
    const chain = [];
    let n = el;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      chain.push(n.id ? '#' + n.id
        : (n.className && String(n.className).split(' ')[0]
            ? '.' + String(n.className).split(' ')[0]
            : n.tagName));
    }
    return { at: [x, y], chain: chain.join(' < ') };
  };
  const w = innerWidth;
  const h = innerHeight;
  const slotCs = cs(slot);
  return {
    win: [w, h],
    inDOMFullscreen: document.documentElement.hasAttribute('inDOMFullscreen'),
    winFullScreen: (() => { try { return window.fullScreen; } catch (e) { return false; } })(),
    stage: document.documentElement.getAttribute('data-astra-stage'),
    stageRect: ['--astra-stage-x', '--astra-stage-y', '--astra-stage-w', '--astra-stage-h']
      .map((k) => document.documentElement.style.getPropertyValue(k) || '0px'),
    slotPointer: slotCs ? slotCs.pointerEvents : null,
    slotZ: slotCs ? slotCs.zIndex : null,
    mountDisplay: cs(mount) ? cs(mount).display : null,
    hits: [
      hit(w / 2, h / 2),
      hit(w / 4, h / 4),
      hit(10, 10),
      hit(w - 10, 10),
      hit(w / 2, h - 10),
    ],
  };
})())"""


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("server closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("server closed mid-message")
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def context(self, value):
        self.cmd("Marionette:SetContext", {"value": value})

    def state(self):
        return json.loads(self.js(STATE_JS))

    def move(self, x, y):
        self.cmd("WebDriver:PerformActions", {"actions": [{
            "type": "pointer", "id": "mouse",
            "parameters": {"pointerType": "mouse"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                {"type": "pointerMove", "duration": 10, "x": x + 2, "y": y + 2,
                 "origin": "viewport"},
            ],
        }]})

    def click(self, x, y):
        self.cmd("WebDriver:PerformActions", {"actions": [{
            "type": "pointer", "id": "mouse",
            "parameters": {"pointerType": "mouse"},
            "actions": [
                {"type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"},
                {"type": "pointerDown", "button": 0},
                {"type": "pointerUp", "button": 0},
            ],
        }]})


def wait_port(proc, port, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        try:
            return Marionette(port)
        except Exception:
            time.sleep(0.5)
    return None


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
    return bool(ok)


def centre_is_page(state):
    """The stage's centre landed on the native page browser."""
    hit = (state.get("hits") or [{}])[0]
    chain = hit.get("chain") or ""
    return "#tabbrowser-tabbox" in chain and ".astra-content" not in chain


def hits_are_page(state):
    """Every sample landed on the native page browser, not on Astra chrome."""
    hits = state.get("hits") or []
    return bool(hits) and all(
        "#tabbrowser-tabbox" in (h.get("chain") or "") and ".astra-content" not in (h.get("chain") or "")
        for h in hits
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default=os.environ.get("ASTRA_BINARY", DEFAULT_BINARY))
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--keep-open", action="store_true")
    args = parser.parse_args()

    firefox = os.path.abspath(args.binary)
    if not os.path.isfile(firefox):
        print(f"SKIP no binary at {firefox}", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="astra-fullscreen-")
    page = os.path.join(work, "video.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write(PAGE.replace("\n", "\r\n"))
    profile = os.path.join(work, "profile")
    os.makedirs(profile, exist_ok=True)
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {args.port});\n')
        f.write('user_pref("astra.onboarding.force", "skip");\n')
        f.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        # A probe cannot produce a transient activation gesture in content.
        f.write('user_pref("full-screen-api.allow-trusted-requests-only", false);\n')
        f.write('user_pref("full-screen-api.transition-duration.enter", "0 0");\n')
        f.write('user_pref("full-screen-api.transition-duration.leave", "0 0");\n')

    log = open(os.path.join(work, "stderr.log"), "wb")
    cmd = [firefox, "-profile", profile, "-no-remote", "-remote-allow-system-access",
           "--marionette", "file:///" + os.path.abspath(page).replace("\\", "/")]
    proc = subprocess.Popen(cmd, cwd=os.path.dirname(firefox),
                            stdout=log, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid} binary={firefox}", flush=True)
    failures = []
    m = None

    def require(name, ok, detail=""):
        if not check(name, ok, detail):
            failures.append(name)

    try:
        m = wait_port(proc, args.port, 90)
        if m is None:
            print("FAIL no Marionette port")
            return 1
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.context("chrome")
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 860})

        def wait_for_page(timeout):
            deadline = time.time() + timeout
            while time.time() < deadline:
                state = m.state()
                if state.get("stage") == "page":
                    return state
                time.sleep(0.5)
            return m.state()

        before = wait_for_page(30)
        if before.get("stage") != "page":
            # The startup URL can land while the app is still adopting it; the
            # probe must ask for the page itself instead of failing on timing.
            print("stage is %r after boot; loading the probe page again"
                  % before.get("stage"), flush=True)
            uri = "file:///" + os.path.abspath(page).replace("\\", "/")
            m.js("const b = gBrowser.selectedBrowser;"
                 f"b.loadURI(Services.io.newURI({json.dumps(uri)}),"
                 " { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });")
            before = wait_for_page(45)
        time.sleep(1.0)
        before = m.state()
        require("a page owns the stage before fullscreen",
                before.get("stage") == "page", str(before.get("stage")))
        require("the page browser is topmost over the stage",
                centre_is_page(before), json.dumps(before.get("hits"))[:300])

        m.context("content")
        for attempt in range(5):
            try:
                m.js("window.__moves = []; window.__clicks = 0;"
                     "document.documentElement.requestFullscreen();")
            except Exception as e:
                print(f"fullscreen request {attempt + 1}: {e}", flush=True)
            time.sleep(1.0)
            m.context("chrome")
            if m.state().get("inDOMFullscreen"):
                break
            m.context("content")
        time.sleep(1.0)
        m.context("chrome")
        full = m.state()
        print("FULLSCREEN: " + json.dumps({k: full.get(k) for k in
              ("win", "inDOMFullscreen", "winFullScreen", "stage", "stageRect",
               "slotPointer", "slotZ", "mountDisplay")}), flush=True)
        w, h = full.get("win") or [0, 0]
        require("the engine entered DOM fullscreen",
                full.get("inDOMFullscreen") is True and full.get("winFullScreen") is True,
                f"inDOMFullscreen={full.get('inDOMFullscreen')} "
                f"fullScreen={full.get('winFullScreen')}")
        require("the stage fills the window",
                [x for x in full.get("stageRect") or []] == ["0px", "0px", f"{w}px", f"{h}px"],
                str(full.get("stageRect")))
        require("the app frame is out of the way in fullscreen",
                full.get("mountDisplay") == "none", str(full.get("mountDisplay")))
        require("the empty content slot does not take the pointer",
                full.get("slotPointer") == "none", str(full.get("slotPointer")))
        require("no chrome is above the fullscreen page",
                hits_are_page(full), json.dumps(full.get("hits"))[:400])

        m.move(w // 2, h // 2)
        time.sleep(0.6)
        m.context("content")
        moves = json.loads(m.js("return JSON.stringify(window.__moves);") or "[]")
        require("the fullscreen page receives hover (its controls can appear)",
                bool(moves) and moves[-1].get("target") is not None,
                json.dumps(moves[-2:])[:240])
        m.context("chrome")
        m.click(w // 2, h // 2)
        time.sleep(0.6)
        m.context("content")
        clicks = m.js("return window.__clicks;")
        require("the fullscreen page receives a click", int(clicks or 0) >= 1, str(clicks))

        m.js("document.exitFullscreen();")
        time.sleep(1.5)
        m.context("chrome")
        after = m.state()
        require("leaving fullscreen restores the window chrome",
                after.get("inDOMFullscreen") is False
                and after.get("mountDisplay") not in (None, "none"),
                f"inDOMFullscreen={after.get('inDOMFullscreen')} "
                f"mount={after.get('mountDisplay')}")
        require("the normal stage is back over the window",
                after.get("stageRect") == before.get("stageRect"),
                f"{after.get('stageRect')} vs {before.get('stageRect')}")
        m.move(w // 2, h // 2 - 100)
        time.sleep(0.5)
        m.context("content")
        moves = json.loads(m.js("return JSON.stringify(window.__moves);") or "[]")
        require("the page still receives hover after leaving fullscreen",
                bool(moves), json.dumps(moves[-1:])[:200])

        print(f"{'PASS' if not failures else 'FAIL'} "
              f"({len(failures)} failed)" + (f": {failures}" if failures else ""), flush=True)
        return 0 if not failures else 1
    finally:
        if m is not None and not args.keep_open:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        if not args.keep_open:
            try:
                proc.wait(timeout=15)
            except Exception:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except Exception:
                    proc.kill()
        else:
            print("LEAVING BROWSER OPEN", flush=True)
        log.close()


if __name__ == "__main__":
    sys.exit(main())
