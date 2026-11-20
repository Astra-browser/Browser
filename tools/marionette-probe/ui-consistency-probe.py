"""UI consistency probe: page menu, settings rail, and the narrow-window fold.

Usage: python3 tools/marionette-probe/ui-consistency-probe.py <out-dir>

Launches the packaged dev build on the current display, waits for the app,
opens the page menu from the sidebar (the real right-click path), checks its
material/geometry, runs Settings from that menu, then narrows the window and
checks that the sections rail folded into the page.
"""
import base64
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

HOST, PORT = "127.0.0.1", 2831
FIREFOX = astra_env.BINARY
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/ui-consistency"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


# The boot marker lives on the chrome shell's own root (`true` once the app
# owns the window); the app iframe's document never carries it.
BOOTED = """
  return (() => {
    const shell = document.querySelector('.astra-frame');
    return shell ? shell.getAttribute('data-app-booted') || 'pending' : 'no shell';
  })();
"""

RECT = js("""
  if (!d) return null;
  const b = (sel) => { const el = d.querySelector(sel); if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  return JSON.stringify({
    viewport: [window.innerWidth, window.innerHeight],
    sidebar: b('aside.browser-sidebar'),
    nav: b('.settings-sidebar-navigation'),
    compact: b('.settings-compact-nav'),
    content: b('.settings-shell'),
    menu: b('.shell-menu'),
  });
""")


class M:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection((HOST, port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("marionette did not open")
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError("closed")
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            c = self.f.read(n - len(rest))
            if not c:
                raise EOFError("closed-mid")
            rest += c
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:200]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, name):
        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))

    def size(self, width, height):
        self.cmd("WebDriver:SetWindowRect", {"width": width, "height": height})

    def nudge(self, width, height):
        """Headless weston keeps the last committed frame until something
        forces a new paint; a 1px resize is that something."""
        self.cmd("WebDriver:SetWindowRect", {"width": width + 1, "height": height + 1})
        time.sleep(0.25)
        self.cmd("WebDriver:SetWindowRect", {"width": width, "height": height})
        time.sleep(0.6)


def wait(fn, timeout=30, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-ui-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [
            FIREFOX,
            "-profile",
            profile,
            "-no-remote",
            "-remote-allow-system-access",
            "--marionette",
            "about:blank",
        ],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    results = {"checks": []}
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.size(1200, 820)
        wait(lambda: m.js(BOOTED) == "true", 90)
        results["booted"] = m.js(BOOTED)
        time.sleep(2)
        m.shot("wide-shell.png")

        # The chrome's own right-click path, on the sidebar.
        opened = m.js(js("""
          const a = d.querySelector('aside.browser-sidebar');
          if (!a) return 'no sidebar';
          const r = a.getBoundingClientRect();
          const x = Math.round(r.x + Math.min(120, r.width / 2));
          const y = Math.round(r.y + Math.min(240, r.height / 2));
          const t = d.elementFromPoint(x, y) || a;
          t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: x, clientY: y, button: 2 }));
          return 'sent';
        """))
        results["menu-event"] = opened
        wait(lambda: m.js(js("return !!d.querySelector('.shell-menu');")))
        menu = m.js(js("""
          const el = d.querySelector('.shell-menu');
          if (!el) return null;
          const s = getComputedStyle(el);
          const row = el.querySelector('.shell-menu-item');
          const rs = row ? getComputedStyle(row) : null;
          const sep = el.querySelector('.shell-menu-separator');
          return JSON.stringify({
            bg: s.backgroundColor,
            radius: s.borderRadius,
            shadow: s.boxShadow.slice(0, 80),
            pad: s.padding,
            rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
            rowRadius: rs ? rs.borderRadius : null,
            rowFont: rs ? rs.fontSize : null,
            sepBleed: sep ? getComputedStyle(sep).marginInlineStart : null,
            labels: [...el.querySelectorAll('.shell-menu-item .shell-menu-label')]
              .map((n) => n.textContent.trim()),
          });
        """))
        results["menu"] = json.loads(menu) if menu else None
        m.nudge(1200, 820)
        m.shot("wide-menu.png")

        # Close it, then right-click the tab row and the new tab's own ground:
        # both must be Astra's menu, never the engine's (or nothing at all).
        m.js(js("""
          const row = d.activeElement || d.querySelector('.shell-menu-item');
          if (row) row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          return 'closed';
        """))
        time.sleep(0.3)
        for name, selector in (
            ("tab-menu", "[data-astra-tab-id]"),
            ("newtab-menu", "[data-astra-new-tab]"),
        ):
            sent = m.js(js(f"""
              const host = d.querySelector('{selector}');
              if (!host) return 'no host';
              const r = host.getBoundingClientRect();
              const x = Math.round(r.x + Math.min(r.width / 2, 120));
              const y = Math.round(r.y + Math.min(r.height / 2, 180));
              const target = d.elementFromPoint(x, y) || host;
              target.dispatchEvent(new MouseEvent('contextmenu', {{
                bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2,
              }}));
              return 'sent';
            """))
            opened = wait(
                lambda: m.js(js("return !!d.querySelector('.shell-menu');")),
                5,
            )
            labels = m.js(js("""
              const el = d.querySelector('.shell-menu');
              return el
                ? JSON.stringify([...el.querySelectorAll('.shell-menu-label')].map((n) => n.textContent.trim()))
                : '[]';
            """))
            results[name] = {
                "sent": sent,
                "opened": bool(opened),
                "labels": json.loads(labels) if labels else [],
            }
            m.nudge(1200, 820)
            m.shot(f"wide-{name}.png")
            m.js(js("""
              const row = d.activeElement || d.querySelector('.shell-menu-item');
              if (row) row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return 'closed';
            """))
            time.sleep(0.3)

        # Run Settings from the menu row, the real path.
        m.js(js("""
          const a = d.querySelector('aside.browser-sidebar');
          const r = a.getBoundingClientRect();
          const t = d.elementFromPoint(Math.round(r.x + 120), Math.round(r.y + 240)) || a;
          t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
            clientX: Math.round(r.x + 120), clientY: Math.round(r.y + 240), button: 2 }));
          return 'sent';
        """))
        wait(lambda: m.js(js("return !!d.querySelector('.shell-menu');")))
        m.js(js("""
          const row = [...d.querySelectorAll('.shell-menu-item')]
            .find((n) => n.textContent.trim() === 'Settings');
          if (!row) return 'no settings row';
          row.click();
          return 'clicked';
        """))
        shown = wait(lambda: m.js(js("return !!d.querySelector('.settings-shell');")), 30)
        results["settings-opened"] = bool(shown)
        wait(lambda: m.js(js("return !!d.querySelector('.settings-sidebar-navigation');")), 30)
        m.nudge(1200, 820)
        results["wide"] = json.loads(m.js(RECT))
        m.shot("wide-settings.png")

        # Narrow: the sections rail folds into the page.
        m.size(700, 780)
        time.sleep(1.5)
        results["narrow"] = json.loads(m.js(RECT))
        results["narrow"].update(
            json.loads(
                m.js(js("""
                  const nav = d.querySelector('.settings-sidebar-navigation');
                  const compact = d.querySelector('.settings-compact-nav');
                  const search = d.querySelector('.settings-compact-search input');
                  return JSON.stringify({
                    nav: !!nav,
                    compact: compact ? getComputedStyle(compact).display : null,
                    compactTop: compact ? Math.round(compact.getBoundingClientRect().top) : null,
                    search: !!search,
                    pagePadding: d.querySelector('.settings-page')
                      ? getComputedStyle(d.querySelector('.settings-page')).padding
                      : null,
                  });
                """))
            )
        )
        m.shot("narrow-settings.png")

        # Back wide: the rail returns.
        m.size(1200, 820)
        time.sleep(1.5)
        results["back"] = json.loads(m.js(RECT))
        m.shot("back-wide.png")

    finally:
        try:
            m.cmd("WebDriver:Quit", {})
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
