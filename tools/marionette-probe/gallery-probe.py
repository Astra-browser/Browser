"""Gallery probe: the page, its grid, the viewer and its settings.

Usage: python tools/marionette-probe/gallery-probe.py [out-dir]

The probe copies a few real PNGs into a scratch folder, points the gallery at
that folder only (the default folders are excluded so the result is stable on
any machine), then drives the packaged build over Marionette:
  - the rail's Gallery entry opens the page;
  - the scan lists the pictures and only the pictures;
  - a tile paints a resized, cached preview, not the original file;
  - clicking a tile opens the viewer, arrows step, Escape closes;
  - search narrows the grid;
  - Manage folders lands on the gallery settings and its warning.
"""

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2837
FIREFOX = astra_env.BINARY
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "gallery-probe")

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


BOOTED = """
  return (() => {
    const shell = document.querySelector('.astra-frame');
    return shell ? shell.getAttribute('data-app-booted') || 'pending' : 'no shell';
  })();
"""


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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, name):
        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))

    def size(self, width, height):
        self.cmd("WebDriver:SetWindowRect", {"width": width, "height": height})


def wait(fn, timeout=30, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def prepare_folder():
    folder = os.path.join(ROOT, "out", "gallery-probe", "pictures")
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(os.path.join(folder, "holiday", "deep"), exist_ok=True)
    assets = os.path.join(ROOT, "overlay", "astra", "chrome", "app", "assets")
    sources = [
        (os.path.join(ROOT, "overlay", "astra", "chrome", "app", "astra-icon.png"), "one.png", 0),
        (os.path.join(ROOT, "overlay", "astra", "chrome", "app", "astra-icon@2x.png"), "two.png", 1),
        (os.path.join(assets, "frost-night-DhE0dVcz.png"), os.path.join("holiday", "deep", "four.png"), 2),
        (os.path.join(assets, "frost-day-Qm8PBHsg.png"), os.path.join("holiday", "three.png"), 3),
    ]
    for source, name, order in sources:
        if not os.path.isfile(source):
            continue
        target = os.path.join(folder, name)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
        stamp = time.time() - (10 - order) * 3600
        os.utime(target, (stamp, stamp))
    with open(os.path.join(folder, "notes.txt"), "w", encoding="utf-8") as f:
        f.write("not a picture\n")
    return folder


def main():
    os.makedirs(OUT, exist_ok=True)
    folder = prepare_folder()
    profile = tempfile.mkdtemp(prefix="astra-gallery-")
    custom = json.dumps([folder])
    excluded = json.dumps(["downloads", "documents", "pictures"])
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(
            f'user_pref("marionette.port", {PORT});\n'
            'user_pref("astra.onboarding.force", "skip");\n'
            'user_pref("astra.gallery.enabled", true);\n'
            f'user_pref("astra.gallery.custom", {json.dumps(custom)});\n'
            f'user_pref("astra.gallery.excluded", {json.dumps(excluded)});\n'
        )
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
    checks = []

    def check(name, ok, detail=None):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name + (f" ({detail})" if detail and not ok else ""))

    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.size(1320, 860)
        booted = wait(lambda: m.js(BOOTED) == "true", 90)
        if not booted:
            print("boot marker:", m.js(BOOTED))
        check("app boots", bool(booted))
        # The rail's own Gallery entry, not a remote command.
        opened = m.js(js("""
          const buttons = [...d.querySelectorAll('button')];
          const paint = buttons.find((b) => b.getAttribute('aria-label') === 'Gallery');
          if (!paint) return 'no entry';
          paint.click();
          return 'clicked';
        """))
        check("the rail opens the gallery", opened == "clicked", opened)
        check(
            "the gallery page mounts",
            bool(wait(lambda: m.js(js("return !!d.querySelector('.gallery-shell');")), 20)),
        )

        tiles = wait(
            lambda: (m.js(js("return d.querySelectorAll('[data-gallery-tile]').length;")) or 0) == 4,
            40,
        )
        check("the scan lists four pictures", bool(tiles))
        names = m.js(js("""
          return JSON.stringify([...d.querySelectorAll('[data-gallery-tile]')]
            .map((tile) => tile.getAttribute('title')));
        """))
        parsed = json.loads(names) if names else []
        check("the newest picture is first", parsed and parsed[0] == "three.png", parsed)
        check("nested folders are included", "four.png" in parsed, parsed)
        check("a text file is not a picture", "notes.txt" not in parsed, parsed)

        painted = wait(
            lambda: (
                m.js(js("""
                  return [...d.querySelectorAll('[data-gallery-tile] img.photo')]
                    .filter((img) => (img.getAttribute('src') || '').startsWith('data:image/')).length;
                """)) or 0
            )
            == 4,
            40,
        )
        check("every tile has a host preview", bool(painted))
        source = m.js(js("""
          const img = d.querySelector('[data-gallery-tile] img.photo');
          return img ? img.getAttribute('src') : '';
        """))
        check("the grid shows a resized data image, not a file path", str(source).startswith("data:image/"))
        m.shot("grid.png")

        # Search debounces and the host filters the cached index.
        m.js(js("""
          const input = d.querySelector('.controls input');
          input.focus();
          input.select();
          // A real edit command fires the same input event a keystroke does.
          d.execCommand('insertText', false, 'three');
          return input.value;
        """))
        narrowed = wait(
            lambda: (m.js(js("return d.querySelectorAll('[data-gallery-tile]').length;")) or 0) == 1,
            20,
        )
        check("search narrows the grid", bool(narrowed))
        m.js(js("""
          const input = d.querySelector('.controls input');
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'cleared';
        """))
        wait(lambda: (m.js(js("return d.querySelectorAll('[data-gallery-tile]').length;")) or 0) == 4, 20)

        # The viewer: filename, date, system opener, full preview, arrows, Escape.
        m.js(js("""
          const tile = d.querySelector('[data-gallery-tile]');
          tile.click();
          return 'clicked';
        """))
        check(
            "a tile opens the viewer",
            bool(wait(lambda: m.js(js("return !!d.querySelector('.viewer');")), 15)),
        )
        header = wait(
            lambda: m.js(js("""
              const panel = d.querySelector('.viewer .panel');
              if (!panel || !panel.querySelector('.identity h2')) return null;
              return JSON.stringify({
                name: panel.querySelector('.identity h2')?.textContent?.trim(),
                date: panel.querySelector('.identity span')?.textContent?.trim(),
                open: panel.querySelector('.open')?.textContent?.trim(),
                image: panel.querySelector('.picture')?.getAttribute('src')?.slice(0, 16),
                scrim: getComputedStyle(panel).backgroundColor,
                radius: getComputedStyle(panel).borderRadius,
              });
            """)),
            15,
        )
        info = json.loads(header) if header else {}
        check("the viewer names the picture", info.get("name") == "three.png", info)
        check("the viewer shows a relative date", bool(info.get("date")), info)
        check("the viewer offers the system opener", info.get("open") == "Open in Photos", info)
        check("the viewer paints a preview", str(info.get("image", "")).startswith("data:image/"), info)
        check("the viewer uses the overlay ground", info.get("radius") not in (None, "", "0px"), info)
        time.sleep(0.45)
        m.shot("viewer.png")

        before = info.get("name")
        m.js(js("""
          const target = d.activeElement || d.body;
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', bubbles: true, cancelable: true,
          }));
          return 'sent';
        """))
        after = wait(
            lambda: m.js(js("return d.querySelector('.viewer .identity h2')?.textContent?.trim();")),
            10,
        )
        check("the arrow steps to the next picture", after and after != before, f"{before}->{after}")

        m.js(js("""
          const target = d.activeElement || d.body;
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
          }));
          return 'sent';
        """))
        escaped = wait(lambda: m.js(js("return !d.querySelector('.viewer');")), 10)
        check("Escape closes the viewer", bool(escaped))

        # Manage folders is a real route to Settings' gallery section.
        manage = m.js(js("""
          const buttons = [...d.querySelectorAll('button')];
          const entry = buttons.find((b) => b.getAttribute('aria-label') === 'Manage folders');
          if (entry) entry.click();
          return entry ? 'clicked' : 'no button';
        """))
        opened_settings = wait(
            lambda: m.js(js("return !!d.querySelector('.settings-shell');")),
            15,
        )
        check("Manage folders opens Settings", manage == "clicked" and bool(opened_settings))
        warning = wait(
            lambda: m.js(js("""
              const shell = d.querySelector('.settings-shell');
              return shell && shell.textContent.includes('More folders cost more');
            """)),
            15,
        )
        check("the folder warning is on the page", bool(warning))
        folders = m.js(js("return d.querySelectorAll('[data-gallery-folder]').length;")) or 0
        check("the watched folder is listed", folders == 1, f"folders={folders}")
        m.shot("settings.png")

        results = {
            "build": astra_env.describe(),
            "folder": folder,
            "checks": checks,
            "passed": sum(1 for c in checks if c["ok"]),
            "failed": sum(1 for c in checks if not c["ok"]),
        }
        with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(f"\ngallery: {results['passed']} passed, {results['failed']} failed")
        return 0 if results["failed"] == 0 else 1
    finally:
        try:
            proc.terminate()
        except OSError:
            pass
        log.close()


if __name__ == "__main__":
    sys.exit(main())
