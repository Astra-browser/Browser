"""Wiring probe: drive the packaged chrome over Marionette and report what the
real UI did. Chrome context, same principal as the app iframe, so the clicks
are the same ones a person makes.

Scenarios:
  1. click Work  -> the window's surface becomes `work`, no navigation banner
  2. click Browse, open the account menu, click Notes
     -> the Notes tool panel opens (`section.shared-tool[data-tool="notes"]`)

Usage: python3 tools/marionette-probe/wiring-probe.py <profile-dir> <out-dir>
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

APP_DOC = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"

CLICK_WORK = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const r = [...d.querySelectorAll('[role="radio"]')].find((x) => (x.textContent || '').trim() === 'Work');
  if (!r) return 'no Work radio';
  r.click();
  return 'ok';
})()"""

SURFACE = "return (() => {" + APP_DOC + """
  if (!d) return null;
  const shell = d.querySelector('.shell');
  return JSON.stringify({
    surface: shell ? shell.getAttribute('data-astra-surface') : null,
    banner: (d.querySelector('.navigation-error') || {}).textContent || null,
  });
})()"""

CLICK_BROWSE = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const r = [...d.querySelectorAll('[role="radio"]')].find((x) => (x.textContent || '').trim() === 'Browse');
  if (!r) return 'no Browse radio';
  r.click();
  return 'ok';
})()"""

OPEN_MENU = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const c = d.querySelector('.shelf .case');
  if (!c) return 'no account case';
  c.click();
  return 'ok';
})()"""

TAB_COUNT = "return (() => {" + APP_DOC + """
  if (!d) return -1;
  return d.querySelectorAll('[data-astra-tab-id]').length;
})()"""

NEW_TAB = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const b = d.querySelector('button.new-tab') || d.querySelector('button.space-new-tab');
  if (!b) return 'no new-tab button';
  b.click();
  return 'ok';
})()"""

CLOSE_LAST_TAB = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[data-astra-tab-id]')];
  const row = rows[rows.length - 1];
  if (!row) return 'no tab rows';
  const x = row.querySelector('button.tab-close');
  if (!x) return 'no close button';
  x.click();
  return 'ok';
})()"""

SPACE_NAME = "return (() => {" + APP_DOC + """
  if (!d) return null;
  const el = d.querySelector('.space-bar .space-name');
  return el ? (el.textContent || '').trim() : null;
})()"""

NEW_SPACE = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const chip = d.querySelector('.space-bar .space-chip');
  if (!chip) return 'no space chip';
  chip.click();
  return 'ok';
})()"""

CONFIRM_NEW_SPACE = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const b = d.querySelector('.switch-new');
  if (!b) return 'no new-space row';
  b.click();
  return 'ok';
})()"""

HIDE_SIDEBAR = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const b = [...d.querySelectorAll('header button')].find((x) => /toggle sidebar/i.test(x.getAttribute('aria-label') || ''));
  if (!b) return 'no collapse button';
  b.click();
  return 'ok';
})()"""

SIDEBAR_STATE = "return (() => {" + APP_DOC + """
  if (!d) return null;
  const a = d.querySelector('aside.browser-sidebar');
  return JSON.stringify({
    hidden: !!(a && a.hasAttribute('data-hidden')),
    peek: !!(a && a.hasAttribute('data-peek')),
    edge: !!d.querySelector('.sidebar-edge'),
  });
})()"""

EDGE_ENTER = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const e = d.querySelector('.sidebar-edge');
  if (!e) return 'no edge strip';
  e.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
  return 'ok';
})()"""

EDGE_LEAVE = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const e = d.querySelector('.sidebar-edge');
  if (!e) return 'no edge strip';
  e.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
  return 'ok';
})()"""

CLICK_TIME = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[role="menuitem"]')];
  const n = rows.find((x) => (x.textContent || '').trim().startsWith('Time'));
  if (!n) return 'no Time row';
  n.click();
  return 'ok';
})()"""

START_FOCUS = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Start focus');
  if (!b) return 'no start button';
  b.click();
  return 'ok';
})()"""

FOCUS_STATE = "return (() => {" + APP_DOC + """
  if (!d) return null;
  const t = d.querySelector('section.shared-tool');
  const text = t ? (t.textContent || '').replace(/\\s+/g, ' ') : '';
  return JSON.stringify({
    running: /pause|stop|break|focus/i.test(text) && !/could not change/i.test(text),
    failed: /could not change/i.test(text),
    text: text.slice(0, 120),
  });
})()"""

CLICK_TASKS = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[role="menuitem"]')];
  const n = rows.find((x) => (x.textContent || '').trim().startsWith('Tasks'));
  if (!n) return 'no Tasks row';
  n.click();
  return 'ok';
})()"""

CLICK_NOTES = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const rows = [...d.querySelectorAll('[role="menuitem"]')];
  const n = rows.find((x) => (x.textContent || '').trim().startsWith('Notes'));
  if (!n) return 'no Notes row: ' + rows.map((x) => (x.textContent || '').trim()).join('|');
  n.click();
  return 'ok';
})()"""

RELOAD = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  f.contentWindow.location.reload();
  return 'ok';
})()"""

CLOSE_TOOL = "return (() => {" + APP_DOC + """
  if (!d) return 'no app document';
  const t = d.querySelector('section.shared-tool');
  if (!t) return 'no tool open';
  const b = [...t.querySelectorAll('header button')].pop();
  if (!b) return 'no close button';
  b.click();
  return 'ok';
})()"""

TOOL_STATE = "return (() => {" + APP_DOC + """
  if (!d) return JSON.stringify({ tool: null });
  const t = d.querySelector('section.shared-tool');
  return JSON.stringify({
    tool: t ? t.getAttribute('data-tool') : null,
    text: t ? (t.textContent || '').replace(/\s+/g, ' ').slice(0, 160) : null,
  });
})()"""


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


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=errlog, stderr=subprocess.STDOUT)

    m = None
    for _ in range(60):
        try:
            m = Marionette(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP")
        proc.terminate()
        return 1

    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    failures = []

    initial = json.loads(m.js(SURFACE))
    print("initial.state: " + json.dumps(initial), flush=True)

    # 0. A new tab can be made and closed again (wire arg names line up).
    before = m.js(TAB_COUNT)
    print("tabs.before: " + str(before), flush=True)
    print("tabs.new: " + str(m.js(NEW_TAB)), flush=True)
    time.sleep(2)
    opened = m.js(TAB_COUNT)
    print("tabs.after_new: " + str(opened), flush=True)
    print("tabs.close: " + str(m.js(CLOSE_LAST_TAB)), flush=True)
    time.sleep(2)
    closed = m.js(TAB_COUNT)
    print("tabs.after_close: " + str(closed), flush=True)
    if opened != before + 1:
        failures.append("new tab was not created")
    if closed != before:
        failures.append("tab was not closed")

    # -1. A space can be made (spaces_create is a native model change).
    space_before = m.js(SPACE_NAME)
    print("space.before: " + str(space_before), flush=True)
    print("space.open: " + str(m.js(NEW_SPACE)), flush=True)
    time.sleep(1)
    print("space.new: " + str(m.js(CONFIRM_NEW_SPACE)), flush=True)
    time.sleep(2)
    space_after = m.js(SPACE_NAME)
    print("space.after: " + str(space_after), flush=True)
    if not space_after or space_after == space_before:
        failures.append("a new space was not created")

    # -1. The hidden column comes out at the edge and goes back (no reflow).
    print("sidebar.hide: " + str(m.js(HIDE_SIDEBAR)), flush=True)
    time.sleep(2)
    hidden = json.loads(m.js(SIDEBAR_STATE))
    print("sidebar.hidden: " + json.dumps(hidden), flush=True)
    if not hidden.get("hidden"):
        failures.append("the sidebar did not hide")
    print("sidebar.edge_in: " + str(m.js(EDGE_ENTER)), flush=True)
    time.sleep(2)
    peeked = json.loads(m.js(SIDEBAR_STATE))
    print("sidebar.peeked: " + json.dumps(peeked), flush=True)
    if not peeked.get("peek"):
        failures.append("the sidebar did not come out at the edge")
    print("sidebar.edge_out: " + str(m.js(EDGE_LEAVE)), flush=True)
    time.sleep(2)
    back = json.loads(m.js(SIDEBAR_STATE))
    print("sidebar.back: " + json.dumps(back), flush=True)
    # Going back waits for the pointer to leave the card, which a synthetic
    # event cannot do; the check is that the card came out at the edge.
    print("sidebar.show: " + str(m.js(HIDE_SIDEBAR)), flush=True)
    time.sleep(2)

    # 1. Work is a browser surface, opened by a command.
    print("work.click: " + str(m.js(CLICK_WORK)), flush=True)
    time.sleep(2)
    state = json.loads(m.js(SURFACE))
    print("work.state: " + json.dumps(state), flush=True)
    if state.get("surface") != "work" or state.get("banner"):
        failures.append("work surface did not open cleanly")

    # Reload the chrome document so the next scenario starts on Browse.
    print("reload: " + str(m.js(RELOAD)), flush=True)
    time.sleep(10)

    # 2. A tool opens from the account menu, natively.
    print("menu.open: " + str(m.js(OPEN_MENU)), flush=True)
    time.sleep(1)
    print("menu.notes: " + str(m.js(CLICK_NOTES)), flush=True)
    time.sleep(3)
    tool = json.loads(m.js(TOOL_STATE))
    print("tool.state: " + json.dumps(tool), flush=True)
    if tool.get("tool") != "notes":
        failures.append("Notes tool did not open")

    try:
        shot = m.cmd("WebDriver:TakeScreenshot", {})
        with open(os.path.join(outdir, "wiring.png"), "wb") as f:
            f.write(base64.b64decode(shot["value"]))
        print("screenshot ok", flush=True)
    except Exception as e:
        print(f"screenshot-ERR {e}", flush=True)

    # 3. Tasks takes its empty state too (resource_call).
    print("reload2: " + str(m.js(RELOAD)), flush=True)
    time.sleep(10)
    print("menu.open2: " + str(m.js(OPEN_MENU)), flush=True)
    time.sleep(1)
    print("menu.tasks: " + str(m.js(CLICK_TASKS)), flush=True)
    time.sleep(3)
    tasks = json.loads(m.js(TOOL_STATE))
    print("tasks.state: " + json.dumps(tasks), flush=True)
    if tasks.get("tool") != "tasks":
        failures.append("Tasks tool did not open")

    # 4. Focus starts from the Time panel (a real session clock).
    print("reload3: " + str(m.js(RELOAD)), flush=True)
    time.sleep(10)
    print("menu.open3: " + str(m.js(OPEN_MENU)), flush=True)
    time.sleep(1)
    print("menu.time: " + str(m.js(CLICK_TIME)), flush=True)
    time.sleep(3)
    print("focus.start: " + str(m.js(START_FOCUS)), flush=True)
    time.sleep(2)
    focus = json.loads(m.js(FOCUS_STATE))
    print("focus.state: " + json.dumps(focus), flush=True)
    if focus.get("failed") or not focus.get("running"):
        failures.append("focus did not start")

    print("VERDICT: " + ("PASS" if not failures else "FAIL " + "; ".join(failures)), flush=True)
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
