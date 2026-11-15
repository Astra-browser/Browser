"""Live Settings audit for the Windows dev build.

Usage:
  python tools/windows/settings-probe.py engine/obj-astra-windows/dist/bin/firefox.exe

Launches the build headless with Marionette and a throwaway profile, then:

  1. opens Settings and walks every navigation page it offers, recording the
     rendered rows, each row's control and disabled state, alerts and console
     errors;
  2. drives one representative control per page and proves the value changed
     and survived leaving the page (a rendered control is not a working one);
  3. cross-checks every binding the Settings feature calls against the host
     route table, so an unimplemented command is a named gap rather than a
     silent no-op.

Checks that must pass: every page renders a heading, no page raises an alert,
every representative control changes and persists, and the set of unrouted
Settings bindings matches the known list (a new one fails the run).

Known gaps that are recorded but do not fail the run: the launcher shortcut
row, the Windows SmartScreen card and its diagnostics button. They are known
unrouted commands; fixing the route should remove them from KNOWN_UNROUTED and
turn the observation into a passing check.

Exit 0 on PASS, 1 on FAIL, 2 when the binary is absent. Stdlib only.
"""

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time

HOST = "127.0.0.1"
PORT = 2852
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(
    ROOT, "engine", "obj-astra-windows", "dist", "bin", "firefox.exe")

BINDINGS = os.path.join(ROOT, "ui", "app", "src", "shared", "ipc", "bindings.ts")
ROUTES = os.path.join(ROOT, "ui", "packages", "bridge", "src", "host-transport.ts")
SETTINGS_DIR = os.path.join(ROOT, "ui", "app", "src", "features", "settings")

# Settings bindings with no host route today. Fix the route, then delete the
# entry: the check below fails on anything new, not on these.
KNOWN_UNROUTED = {
    "favicon_probe",
    "launcher_open_accessibility",
    "launcher_record_shortcut",
    "launcher_set_double_tap",
    "launcher_set_shortcut",
    "launcher_trigger",
    "login_item_open_settings",
    "login_item_set",
    "open_software_update",
    "windows_diagnostics_settings",
    "windows_reputation_managed",
    "work_clear_website_data",
    "work_local_servers",
    "work_screenshot_sites",
    "work_set_screenshot_site",
}

# (nav label, setting id, kind)
REPRESENTATIVE = [
    ("General", "general.startup", "select"),
    ("Appearance", "appearance.density", "select"),
    ("Appearance", "appearance.motion", "switch"),
    ("Tabs", "tabs.duplicates", "switch"),
    ("Tabs", "split.enabled", "switch"),
    ("New Tab", "ntp.wordmark", "switch"),
    ("New Tab", "ntp.clock", "switch"),
    ("Search", "search.suggestions", "switch"),
    ("Extensions", "extensions.per-space", "switch"),
    ("Privacy & security", "privacy.blocking", "switch"),
    ("Privacy & security", "privacy.drm", "switch"),
    ("Privacy & security", "history.scope", "select"),
    ("Time & focus", "focus.breaks", "switch"),
    ("Time & focus", "time.track", "switch"),
    ("Performance", "performance.sleep", "switch"),
    ("Performance", "performance.memory", "select"),
    ("Features", "notes.enabled", "switch"),
    ("Features", "tasks.enabled", "switch"),
    ("Keyboard & accessibility", "accessibility.contrast", "switch"),
    ("About", "about.diagnostics", "button"),
]

APP = ("const f=document.querySelector('iframe[data-astra-app-frame]');"
       "const d=f&&f.contentDocument;")

PAGE_STATE = (
    "return (()=>{" + APP + "if(!d)return '{}';"
    "const q=(s)=>d.querySelector(s);"
    "const controls='button,input,select,textarea,[role=switch],[role=slider],[role=combobox]';"
    "const rows=[...d.querySelectorAll('[data-setting]')].map(r=>{"
    " const cs=[...r.querySelectorAll(controls)];"
    " return {id:r.dataset.setting,"
    "  title:(r.querySelector('h3,h2')?.textContent??r.textContent).trim().split('\\n')[0].slice(0,90),"
    "  disabled:cs.length>0&&cs.every(c=>c.disabled||c.getAttribute('aria-disabled')==='true'),"
    "  control:cs[0]?cs[0].tagName.toLowerCase():null};});"
    "let console=[];try{console=(Services.console.getMessageArray()||[]).map(x=>String(x.message))"
    " .filter(s=>/unknown_command|host_error|unavailable|failed/i.test(s)).slice(-20);}"
    "catch(e){console=[String(e)];}"
    "return JSON.stringify({heading:q('.settings-page-heading h1')?.textContent.trim()??null,"
    " rows,alerts:[...d.querySelectorAll('[role=alert]')].map(e=>e.textContent.trim()).filter(Boolean),"
    " console,text:(q('.settings-content')?.innerText??'').replace(/\\n+/g,' | ').slice(0,600)});})()"
)

ROW_STATE = (
    "return (()=>{" + APP + "const r=d&&d.querySelector('[data-setting=\"'+arguments[0]+'\"]');"
    "if(!r)return null;const sw=r.querySelector('[role=switch]');"
    "const b=r.querySelector('button');"
    "return JSON.stringify({switch:sw?sw.getAttribute('aria-checked'):null,"
    " button:b?b.textContent.trim().slice(0,48):null,"
    " text:r.innerText.replace(/\\n+/g,' | ').slice(0,200)});})()"
)

POINTER = (
    "const box=%s.getBoundingClientRect();"
    "const at={bubbles:true,cancelable:true,composed:true,clientX:box.left+8,clientY:box.top+8,button:0};"
    "%s.dispatchEvent(new PointerEvent('pointerdown',at));"
    "%s.dispatchEvent(new PointerEvent('pointerup',at));"
    "%s.dispatchEvent(new MouseEvent('click',at));"
)


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

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript",
                        {"script": script, "args": args or []})["value"]


def wiring():
    """Settings bindings that no host module routes."""
    text = open(BINDINGS, encoding="utf-8").read()
    to_wire = {}
    for m in re.finditer(r"^\s*(\w+):\s*\([^)]*\)\s*=>.*?__TAURI_INVOKE[^(]*\(\s*\"([a-z0-9_]+)\"",
                         text, re.M):
        to_wire.setdefault(m.group(1), m.group(2))
    routes = set(re.findall(r"^\s+([a-z0-9_]+):\s*\[",
                            open(ROUTES, encoding="utf-8").read(), re.M))
    used = {}
    for base, _, files in os.walk(SETTINGS_DIR):
        for name in files:
            if not name.endswith(".svelte"):
                continue
            body = open(os.path.join(base, name), encoding="utf-8").read()
            for m in re.finditer(r"\bcommands\.(\w+)\s*\(", body):
                used.setdefault(m.group(1), set()).add(name)
    unrouted, wired = set(), 0
    for binding in used:
        wire = to_wire.get(binding)
        if wire is None:
            continue
        if wire in routes:
            wired += 1
        else:
            unrouted.add(wire)
    return wired, unrouted


def main():
    if not os.path.isfile(FIREFOX):
        print(f"SKIP no binary at {FIREFOX}", file=sys.stderr)
        return 2
    failed = 0
    report = {"pages": [], "representative": [], "observations": {}}

    def check(name, cond, detail=None):
        nonlocal failed
        print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" -- {detail}"))
        if not cond:
            failed += 1

    profile = tempfile.mkdtemp(prefix="astra-settings-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-headless",
         "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT)
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        deadline = time.time() + 90
        while time.time() < deadline:
            if m.js("return document.querySelector('.astra-frame')"
                    "?.getAttribute('data-app-booted');") == "true":
                break
            time.sleep(0.3)
        m.js("return Services.astraHost.Commands.run({id:'settings.general'});")
        time.sleep(1.5)

        nav = json.loads(m.js(
            "return (()=>{" + APP + "return JSON.stringify("
            "[...d.querySelectorAll('.settings-nav-item')].map(b=>b.textContent.trim()));})()"))
        # The identity card shares the item class; it is not a page.
        pages = [label for label in nav if label not in ("", "Sign inYour plan and devices")]
        print(f"pages: {len(pages)}")
        check("Settings offers its pages", len(pages) >= 14, nav)

        for index, label in enumerate(pages):
            m.js("return (()=>{" + APP +
                 "const b=[...d.querySelectorAll('.settings-nav-item')]"
                 ".find(x=>x.textContent.trim().startsWith(arguments[0]));b?.click();})()", [label])
            time.sleep(1.0)
            state = json.loads(m.js(PAGE_STATE))
            state["label"] = label
            report["pages"].append(state)
            check(f"{label}: renders a heading", bool(state.get("heading")), state.get("heading"))
            check(f"{label}: no alert", not state.get("alerts"), state.get("alerts"))
            check(f"{label}: no host error in the console",
                  not [c for c in state.get("console") or [] if "unknown_command" in c],
                  state.get("console"))

        def go(label):
            m.js("return (()=>{" + APP + "const b=[...d.querySelectorAll('.settings-nav-item')]"
                 ".find(x=>x.textContent.trim().startsWith(arguments[0]));b?.click();})()", [label])
            time.sleep(0.9)

        for page, sid, kind in REPRESENTATIVE:
            go(page)
            before = m.js(ROW_STATE, [sid])
            check(f"{sid}: row is present", before is not None, before)
            if before is None:
                continue
            before = json.loads(before)
            if kind == "switch":
                clicked = m.js(
                    "return (()=>{" + APP + "const r=d.querySelector('[data-setting=\"'+arguments[0]+'\"]');"
                    "const s=r&&r.querySelector('[role=switch]');if(!s)return 'no-switch';s.click();"
                    "return 'ok';})()", [sid])
            elif kind == "select":
                clicked = m.js(
                    "return (()=>{" + APP + "const r=d.querySelector('[data-setting=\"'+arguments[0]+'\"]');"
                    "const b=r&&r.querySelector('button');if(!b)return 'no-button';"
                    + (POINTER % ("b", "b", "b", "b")) + "return 'ok';})()", [sid])
                time.sleep(0.7)
                m.js(
                    "return (()=>{" + APP + "const o=[...d.querySelectorAll('[role=option]')];"
                    "if(!o.length)return 'none';const cur=o.findIndex(x=>x.getAttribute('aria-selected')==='true');"
                    "const p=o[cur>=0?(cur+1)%o.length:0];"
                    + (POINTER % ("p", "p", "p", "p")) + "return 'ok';})()")
            else:
                clicked = m.js(
                    "return (()=>{" + APP + "const r=d.querySelector('[data-setting=\"'+arguments[0]+'\"]');"
                    "const b=r&&r.querySelector('button');if(!b)return 'no-button';"
                    + (POINTER % ("b", "b", "b", "b")) + "return 'ok';})()", [sid])
            time.sleep(1.1)
            after = m.js(ROW_STATE, [sid])
            after = json.loads(after) if after else None
            go("About")
            go(page)
            revisit = m.js(ROW_STATE, [sid])
            revisit = json.loads(revisit) if revisit else None
            changed = bool(after) and bool(revisit) and (
                after.get("switch") != before.get("switch") or
                after.get("text") != before.get("text"))
            held = bool(after) and bool(revisit) and after.get("switch") == revisit.get("switch") \
                and after.get("text") == revisit.get("text")
            report["representative"].append(
                {"page": page, "id": sid, "kind": kind, "before": before,
                 "after": after, "revisit": revisit})
            check(f"{sid}: {kind} changes", changed, {"before": before, "after": after})
            check(f"{sid}: value survives leaving the page", held, revisit)

        # The three known gaps, recorded rather than asserted.
        go("Keyboard & accessibility")
        report["observations"]["launcher"] = m.js(
            "return (()=>{" + APP + "const c=d.querySelector('.settings-content');"
            "const h=[...c.querySelectorAll('h3')].find(x=>/Open the launcher/.test(x.textContent));"
            "return h?h.parentElement.innerText.replace(/\\n+/g,' | ').slice(0,200):null;})()")
        go("Privacy & security")
        report["observations"]["smartscreen"] = m.js(
            "return (()=>{" + APP + "const r=d.querySelector('[data-setting=\"privacy.smartscreen\"]');"
            "return r?r.innerText.replace(/\\n+/g,' | ').slice(0,200):null;})()")
        report["observations"]["reputation"] = m.js(
            "return Services.astraHost.System.windowsReputationManaged()"
            ".then(v=>JSON.stringify({reputation:v}),e=>JSON.stringify({error:String(e)}));")

        wired, unrouted = wiring()
        print(f"settings bindings routed: {wired}; unrouted: {len(unrouted)}")
        check("no new unrouted Settings binding", unrouted <= KNOWN_UNROUTED,
              sorted(unrouted - KNOWN_UNROUTED))
        report["wiring"] = {"routed": wired, "unrouted": sorted(unrouted)}
    except Exception as e:  # pragma: no cover - probe harness
        print(f"FAIL probe error: {e}", file=sys.stderr)
        failed += 1
    finally:
        os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
        with open(os.path.join(ROOT, "out", "settings-probe.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1, ensure_ascii=False)
        if m is not None:
            try:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
            except Exception:
                pass
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.kill()
        log.close()
    print(f"{'PASS' if failed == 0 else 'FAIL'} ({failed} failed)")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
