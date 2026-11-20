"""Utility bar probe: the column's head holds the tools, and the page gets the
old rail's width back.

Usage: python3 tools/marionette-probe/utility-bar-probe.py <profile-dir> <out-dir>

Checks, against a fresh packaged dev build:
  * no 44px rail; the sidebar is the column alone (260px at rest),
  * the media/downloads/notes/spaces/sleeping marks and the one extension
    door sit on one row inside the column at 260px, headed by the header's
    shape toggle (the four-column grid is for a column at or under 220px),
  * the extension hub opens opaque over the tab list,
  * the media popover opens under the bar and inside the column,
  * opening a tool keeps a 56px column with the same marks, and the panel head
    (a narrow container) reflows them into the four-column grid,
  * the compact media popover stays inside those 56px,
  * the toggle hides the column and the edge brings it back as the card.

Exit 0 on PASS, 1 on any failed check.
"""
import base64
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
FIREFOX = astra_env.BINARY
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


class M:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            c = self.f.read(1)
            if not c:
                raise EOFError
            data += c
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            rest += self.f.read(n - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            m = self._read()
            if isinstance(m, list) and len(m) == 4 and m[1] == self._id:
                if m[2]:
                    raise RuntimeError(m)
                return m[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]

    def shot(self, path):
        value = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(value))


CLICK = lambda label: js(f"""
  if (!d) return 'no doc';
  const b = [...d.querySelectorAll('button')].find(
    (x) => x.getAttribute('aria-label') === {json.dumps(label)});
  if (!b) return 'no {label}';
  b.click();
  return 'ok';
""")

STATE = js("""
  if (!d) return null;
  const box = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width),
             h: Math.round(b.height), right: Math.round(b.right) };
  };
  const aside = d.querySelector('aside.browser-sidebar');
  const main = d.querySelector('.sidebar-main');
  const bar = d.querySelector('.utility-bar');
  const column = d.querySelector('.sidebar-browser-column');
  const host = d.querySelector('.sidebar-tool-host');
  const panel = d.querySelector('.bar-popover');
  const extensionPanel = d.querySelector('.extension-popover');
  const items = bar ? [...bar.querySelectorAll('button')].map((b) => ({
    name: b.getAttribute('aria-label'), ...box(b),
  })) : [];
  // The plates on the bar's own row: direct buttons plus each disclosure's
  // trigger, not the rows inside a tray that is always rendered.
  const plates = bar ? [...bar.querySelectorAll(
    ':scope > button, :scope > .ui-disclosure > button, :scope > .rail-spaces > button',
  )].map((b) => ({ name: b.getAttribute('aria-label'), ...box(b) })) : [];
  return JSON.stringify({
    hidden: !!(aside && aside.hasAttribute('data-hidden')),
    peek: !!(aside && aside.hasAttribute('data-peek')),
    oldRail: !!d.querySelector('.utility-rail'),
    sidebar: box(aside),
    main: box(main),
    column: box(column),
    host: box(host),
    bar: box(bar),
    display: bar ? getComputedStyle(bar).display : null,
    gridColumns: bar ? getComputedStyle(bar).gridTemplateColumns : null,
    gridAutoFlow: bar ? getComputedStyle(bar).gridAutoFlow : null,
    compact: bar ? bar.hasAttribute('data-compact') : null,
    extensions: bar
      ? [...bar.querySelectorAll('button')].filter(
          (b) => b.getAttribute('aria-label') === 'Extensions').length
      : 0,
    items,
    plates,
    panel: panel ? { ...box(panel), open: panel.getAttribute('data-open') } : null,
    extensionPanel: extensionPanel
      ? {
          ...box(extensionPanel),
          open: extensionPanel.getAttribute('data-open'),
          material: extensionPanel.getAttribute('data-menu-material'),
          background: getComputedStyle(extensionPanel).backgroundColor,
        }
      : null,
    columnBar: !!d.querySelector('.sidebar-browser-column .utility-bar'),
    headerToggle: !!d.querySelector('.sidebar-top button[aria-label="Toggle sidebar"]'),
    barParentWidth: bar && bar.parentElement
      ? Math.round(bar.parentElement.getBoundingClientRect().width) : null,
    toolClose: !!d.querySelector('.sidebar-tool-host .shared-tool-header button[aria-label="Close tool"]'),
    railSearch: !!d.querySelector('.sidebar-browser-column .rail-search button'),
    modeSwitch: !!d.querySelector('.mode-switch'),
    railSpaces: d.querySelectorAll('.rail-spaces').length,
    animations: bar
      ? [...bar.children].map((el) => getComputedStyle(el).animationName)
      : [],
  });
""")


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile), "-no-remote",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=log, stderr=subprocess.STDOUT)
    m = None
    for _ in range(60):
        try:
            m = M(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("FAIL no Marionette")
        proc.terminate()
        return 1

    results = []

    def check(name, ok, detail=None):
        results.append(ok)
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"))

    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        for _ in range(40):
            time.sleep(1)
            try:
                if m.js(js("return !!d.querySelector('.utility-bar') ? 'yes' : 'no';")) == "yes":
                    break
            except Exception:
                pass
        time.sleep(1.5)

        expanded = json.loads(m.js(STATE))
        names = {item["name"] for item in expanded["items"]}
        aside = expanded["sidebar"] or {}
        check("no route beside the column", expanded["oldRail"] is False)
        check("the page inset is the column alone", aside.get("w") == 260, aside)
        plates = expanded["plates"]
        check(
            "the bar keeps every mark in one row at the default width",
            expanded["display"] == "flex"
            and len({item["y"] for item in plates}) == 1,
            {"display": expanded["display"], "plates": plates},
        )
        check(
            "every utility is in the bar",
            {"Media", "Downloads", "Notes", "All Spaces", "Sleeping tabs", "Extensions"}
            <= names,
            names,
        )
        check("the shape toggle heads the column", expanded["headerToggle"] is True, expanded)
        check("one extension door", expanded["extensions"] == 1, expanded["extensions"])
        check(
            "no mark leaves the column",
            all(item["right"] <= aside.get("right", 0) for item in expanded["items"]),
            expanded["items"],
        )
        check(
            "the plates settle in with motion",
            all(name.endswith("bar-plate-in") for name in expanded["animations"]),
            expanded["animations"],
        )
        m.shot(os.path.join(outdir, "utility-bar-expanded.png"))

        check("extensions opens", m.js(CLICK("Extensions")) == "ok")
        time.sleep(1.0)
        hub = json.loads(m.js(STATE))
        hub_panel = hub["extensionPanel"] or {}
        check(
            "the extension hub is opaque over the tab list",
            hub_panel.get("open") == "true"
            and hub_panel.get("material") == "opaque"
            and "rgba" not in (hub_panel.get("background") or ""),
            hub_panel,
        )
        m.shot(os.path.join(outdir, "utility-bar-extensions.png"))
        m.js(CLICK("Extensions"))
        time.sleep(0.4)

        check("media opens", m.js(CLICK("Media")) == "ok")
        time.sleep(0.7)
        media = json.loads(m.js(STATE))
        panel = media["panel"] or {}
        check(
            "the media list opens under the bar, inside the column",
            panel.get("open") == "true"
            and panel.get("x", 0) >= aside.get("x", 0)
            and panel.get("right", 0) <= aside.get("right", 0) + 1,
            panel,
        )
        m.shot(os.path.join(outdir, "utility-bar-media.png"))
        m.js(CLICK("Media"))

        check("downloads opens", m.js(CLICK("Downloads")) == "ok")
        time.sleep(1.2)
        tool = json.loads(m.js(STATE))
        column = tool["column"] or {}
        host = tool["host"] or {}
        bar = tool["bar"] or {}
        check("a tool keeps the 56px tab column", column.get("w") == 56, column)
        check("the utilities leave the tab column", tool["columnBar"] is False)
        check(
            "the utilities head the panel",
            tool["display"] == "grid" and tool["gridAutoFlow"] == "column",
            {"display": tool["display"], "flow": tool["gridAutoFlow"],
             "columns": tool["gridColumns"]},
        )
        check(
            "the utilities span the panel's head",
            bar.get("x", 0) >= host.get("x", 0)
            and bar.get("right", 0) <= host.get("right", 0) + 1,
            {"bar": bar, "host": host},
        )
        check("the tab column keeps its search", tool["railSearch"] is True)
        check("the panel header carries a close control", tool["toolClose"] is True)
        names = {item["name"] for item in tool["items"]}
        check("no shape toggle crowds the panel head", "Toggle sidebar" not in names, names)
        check("the mode switch leaves the tool rail", tool["modeSwitch"] is False)
        check("one spaces switcher remains", tool["railSpaces"] == 1, tool["railSpaces"])
        check(
            "the panel starts at the window's top edge",
            host.get("y") == 8 and host.get("x") == column.get("x", 0) + 64,
            host,
        )
        m.shot(os.path.join(outdir, "utility-bar-tool.png"))

        check("media opens", m.js(CLICK("Media")) == "ok")
        time.sleep(0.7)
        inside = json.loads(m.js(STATE))
        panel = inside["panel"] or {}
        host = inside["host"] or {}
        check(
            "the media list opens under the panel's head, inside the panel",
            panel.get("open") == "true"
            and panel.get("x", 0) >= host.get("x", 0)
            and panel.get("right", 0) <= host.get("right", 0) + 1,
            panel,
        )
        m.shot(os.path.join(outdir, "utility-bar-tool-media.png"))
        m.js(CLICK("Media"))
        check("the panel header close works", m.js(CLICK("Close tool")) == "ok")
        time.sleep(1.0)
        closed = json.loads(m.js(STATE))
        check(
            "the panel closes back to the expanded head",
            closed["host"] is None
            and (closed["sidebar"] or {}).get("w") == 260
            and closed["headerToggle"] is True,
            closed,
        )
        m.shot(os.path.join(outdir, "utility-bar-expanded-again.png"))

        check("the toggle hides the column", m.js(CLICK("Toggle sidebar")) == "ok")
        time.sleep(1.2)
        hidden = json.loads(m.js(STATE))
        check("the column goes away", hidden["hidden"] is True, hidden["hidden"])
        m.shot(os.path.join(outdir, "utility-bar-hidden.png"))

        m.js(js("""
          const w = d.defaultView;
          w.dispatchEvent(new w.CustomEvent('astra:sidebar-edge', { detail: { near: true } }));
          return 'ok';
        """))
        time.sleep(1.5)
        peek = json.loads(m.js(STATE))
        check("the edge brings the card back", peek["peek"] is True, peek["peek"])
        m.shot(os.path.join(outdir, "utility-bar-peek.png"))
    finally:
        proc.terminate()

    passed = all(results)
    print(("VERDICT: PASS" if passed else "VERDICT: FAIL") + f" ({sum(results)}/{len(results)})")
    return 0 if passed else 1


sys.exit(main())
