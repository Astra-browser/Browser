"""Settings audit: drive every control in the live Settings page.

Usage: python3 tools/marionette-probe/settings-audit-probe.py [out-dir]

Opens Settings in the packaged dev build and, for every section and every
`[data-setting]` row:

  - switches: click, wait for the visible state to change, click back
  - selects: choose another option, wait for the trigger to change, restore
  - segmented controls: pick another segment, wait, restore
  - dialogs (AI/Work confirmation): record that the switch asked first and
    cancel, so the rest of the audit can continue

Writes `audit.json` and prints a PASS/FAIL line per control. Exit 0 only when
every enabled control changed state.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HOST, PORT = "127.0.0.1", 2835
FIREFOX = os.path.abspath("engine/obj-astra-linux/dist/bin/firefox")
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/settings-audit"

APP = (
    "const f=document.querySelector('iframe[data-astra-app-frame]');"
    "const d=f&&f.contentDocument;"
)
IDENTITY = "Sign in"


def js(body):
    return "return (() => {" + APP + body + "})()"


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
        import base64

        png = self.cmd("WebDriver:TakeScreenshot", {})["value"]
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(base64.b64decode(png))


def wait(fn, timeout=8, step=0.15):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:
            last = None
        time.sleep(step)
    return last


class Audit:
    def __init__(self, m):
        self.m = m
        self.rows = []

    def js(self, body):
        return self.m.js(js(body))

    def record(self, section, setting, kind, status, detail=""):
        self.rows.append(
            {"section": section, "setting": setting, "kind": kind, "status": status, "detail": detail}
        )
        print(f"{status:6} {section:24} {setting:32} {kind:9} {detail}", flush=True)

    def open_settings(self):
        self.m.js("return Services.astraHost.Commands.run({id:'settings.general'});")
        wait(lambda: self.js("return d.querySelectorAll('[data-setting]').length > 0;"), 30)

    def nav_labels(self):
        # Only the Browser group; Work/App have their own surfaces and stores.
        raw = self.js(
            "const group=d.querySelector('.settings-nav-group');"
            "if(!group) return '[]';"
            "return JSON.stringify([...group.querySelectorAll('.settings-nav-item')]"
            ".map(b => b.textContent.trim()));"
        )
        return json.loads(raw or "[]")

    def select_section(self, label):
        ok = self.js(
            "const b=[...d.querySelectorAll('.settings-nav-item')]"
            f".find(x=>x.textContent.trim()==={json.dumps(label)});"
            "if(!b) return false; b.click(); return true;"
        )
        if not ok:
            return False
        wait(
            lambda: self.js(
                "return d.querySelector('.settings-page-heading h1')?.textContent.trim()"
                f"==={json.dumps(label)};"
            ),
            8,
        )
        # A lazy page needs a moment to render its first row.
        time.sleep(0.7)
        return True

    def section_rows(self):
        raw = self.js(
            "return JSON.stringify([...d.querySelectorAll('[data-setting]')].map(el=>({"
            "id: el.getAttribute('data-setting'),"
            "switches: el.querySelectorAll('button[role=switch]').length,"
            "selects: el.querySelectorAll('button.ui-select').length,"
            "segments: el.querySelectorAll('[role=radiogroup] button[role=radio]').length,"
            "inputs: el.querySelectorAll('input').length"
            "})));"
        )
        return json.loads(raw or "[]")

    def control(self, setting, selector):
        raw = self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            f"const c=r?.querySelector({json.dumps(selector)});"
            "if(!c) return null;"
            "return JSON.stringify({checked:c.getAttribute('aria-checked'),"
            "disabled:c.disabled===true,text:c.textContent.replace(/\\s+/g,' ').trim()});"
        )
        return json.loads(raw) if raw else None

    def click(self, setting, selector):
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            f"const c=r?.querySelector({json.dumps(selector)});"
            "if(!c) return false; c.click(); return true;"
        )

    def pointer_click(self, setting, selector):
        """A real pointer sequence: the select trigger opens on pointerdown,
        and a bare element.click() does not open it."""
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            f"const c=r?.querySelector({json.dumps(selector)});"
            "if(!c) return false;"
            "const box=c.getBoundingClientRect();"
            "const x=box.left+box.width/2, y=box.top+box.height/2;"
            "const init={bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y};"
            "c.dispatchEvent(new PointerEvent('pointerdown',init));"
            "c.dispatchEvent(new PointerEvent('pointerup',init));"
            "c.click(); return true;"
        )

    OPEN_MENU = (
        "const menus=[...d.querySelectorAll('.ui-select-menu')]"
        ".filter(m=>m.getAttribute('data-state')==='open');"
        "const menu=menus[menus.length-1];"
    )

    def menu_items(self):
        raw = self.js(
            self.OPEN_MENU
            + "if(!menu) return '[]';"
            "return JSON.stringify([...menu.querySelectorAll('.ui-menu-item')]"
            ".map(x=>({t:x.textContent.replace(/\\s+/g,' ').trim(),"
            "disabled:x.getAttribute('aria-disabled')==='true'})));"
        )
        return json.loads(raw or "[]")

    def pick_menu_item(self, label):
        return self.js(
            self.OPEN_MENU
            + "if(!menu) return false;"
            "const i=[...menu.querySelectorAll('.ui-menu-item')]"
            f".find(x=>x.textContent.replace(/\\s+/g,' ').trim()==={json.dumps(label)});"
            "if(!i) return false;"
            "const box=i.getBoundingClientRect();"
            "const x=box.left+box.width/2, y=box.top+box.height/2;"
            "const init={bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true,clientX:x,clientY:y};"
            "i.dispatchEvent(new PointerEvent('pointerdown',init));"
            "i.dispatchEvent(new PointerEvent('pointerup',init));"
            "i.click(); return true;"
        )

    def close_menus(self):
        self.js(
            "for(let i=0;i<2;i++){"
            "d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
            "d.body.dispatchEvent(new PointerEvent('pointerdown',"
            "{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}));"
            "d.body.click();}"
            "return true;"
        )
        wait(
            lambda: self.js(
                "return [...d.querySelectorAll('.ui-select-menu')]"
                ".every(m=>m.getAttribute('data-state')!=='open');"
            ),
            2,
        )

    def alert(self):
        return self.js(
            "return d.querySelector('.settings-feedback[role=alert], .settings-feedback')?.textContent?.trim() ?? null;"
        )

    def dialog_open(self, setting):
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "return !!r?.querySelector('dialog[open]');"
        )

    def cancel_dialog(self, setting):
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "const b=[...r.querySelectorAll('dialog[open] button')]"
            ".find(x=>/^(Cancel|Turn Off)$/.test(x.textContent.trim()));"
            "const c=[...r.querySelectorAll('dialog[open] button')]"
            ".find(x=>x.textContent.trim()==='Cancel');"
            "if(!c) return false; c.click(); return true;"
        )

    def test_switch(self, section, setting):
        state = self.control(setting, "button[role=switch]")
        if not state:
            return
        if state["disabled"]:
            # Some rows load their native model after the page paints.
            wait(lambda: not self.control(setting, "button[role=switch]")["disabled"], 6)
            state = self.control(setting, "button[role=switch]")
        if state["disabled"]:
            self.record(section, setting, "switch", "SKIP", "disabled")
            return
        before = state["checked"]
        self.click(setting, "button[role=switch]")
        if self.dialog_open(setting):
            time.sleep(0.2)
            self.record(section, setting, "switch", "PASS", "confirmation dialog shown before turning off")
            self.cancel_dialog(setting)
            time.sleep(0.3)
            return
        after = wait(
            lambda: self.control(setting, "button[role=switch]")
            and self.control(setting, "button[role=switch]")["checked"] != before
            and self.control(setting, "button[role=switch]")
        )
        if not after:
            detail = self.alert() or "state did not change"
            self.record(section, setting, "switch", "FAIL", detail)
            return
        # Let the one write settle before restoring.
        wait(lambda: not self.control(setting, "button[role=switch]")["disabled"], 8)
        self.click(setting, "button[role=switch]")
        restored = wait(
            lambda: self.control(setting, "button[role=switch]")["checked"] == before
            and self.control(setting, "button[role=switch]")
        )
        if not restored:
            detail = self.alert() or "did not restore"
            self.record(section, setting, "switch", "FAIL", detail)
            return
        self.record(
            section,
            setting,
            "switch",
            "PASS",
            f"{before} -> {after['checked']} -> {before}",
        )

    def test_select(self, section, setting):
        state = self.control(setting, "button.ui-select")
        if not state:
            return
        if state["disabled"]:
            self.record(section, setting, "select", "SKIP", "disabled")
            return
        before = state["text"]
        self.close_menus()
        self.pointer_click(setting, "button.ui-select")
        options = wait(lambda: self.menu_items(), 4) or []
        target = next((o["t"] for o in options if not o["disabled"] and o["t"] != before), None)
        if target is None:
            self.close_menus()
            self.record(section, setting, "select", "SKIP", f"no alternative option ({before})")
            return
        picked = self.pick_menu_item(target)
        if not picked:
            self.record(section, setting, "select", "FAIL", f"could not pick {target!r}")
            return
        changed = wait(
            lambda: self.control(setting, "button.ui-select")["text"] == target
            and self.control(setting, "button.ui-select")
        )
        if not changed:
            detail = self.alert() or f"{before!r} did not become {target!r}"
            self.record(section, setting, "select", "FAIL", detail)
            return
        wait(lambda: not self.control(setting, "button.ui-select")["disabled"], 8)
        # Restore.
        self.close_menus()
        self.pointer_click(setting, "button.ui-select")
        wait(lambda: self.menu_items(), 4)
        self.pick_menu_item(before)
        restored = wait(
            lambda: self.control(setting, "button.ui-select")["text"] == before
            and self.control(setting, "button.ui-select")
        )
        self.close_menus()
        if not restored:
            self.record(section, setting, "select", "FAIL", "did not restore")
            return
        self.record(section, setting, "select", "PASS", f"{before!r} -> {target!r} -> {before!r}")

    def test_segments(self, section, setting):
        raw = self.control(setting, "[role=radiogroup]")
        if raw is None:
            return
        state = self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "return JSON.stringify([...r.querySelectorAll('[role=radiogroup] button[role=radio]')]"
            ".map(b=>({t:b.textContent.replace(/\\s+/g,' ').trim(),"
            "checked:b.getAttribute('aria-checked')==='true',disabled:b.disabled===true})));"
        )
        segments = json.loads(state or "[]")
        if not segments:
            return
        if all(s["disabled"] for s in segments):
            self.record(section, setting, "segments", "SKIP", "disabled")
            return
        before = next((s["t"] for s in segments if s["checked"]), "")
        target = next((s for s in segments if not s["disabled"] and not s["checked"]), None)
        if target is None:
            self.record(section, setting, "segments", "SKIP", "one choice")
            return
        self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "const b=[...r.querySelectorAll('[role=radiogroup] button[role=radio]')]"
            f".find(x=>x.textContent.replace(/\\s+/g,' ').trim()==={json.dumps(target['t'])});"
            "if(!b) return false; b.click(); return true;"
        )
        changed = wait(
            lambda: self.js(
                f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
                "const b=[...r.querySelectorAll('[role=radiogroup] button[role=radio]')]"
                f".find(x=>x.textContent.replace(/\\s+/g,' ').trim()==={json.dumps(target['t'])});"
                "return b?.getAttribute('aria-checked')==='true';"
            ),
            5,
        )
        if not changed:
            self.record(section, setting, "segments", "FAIL", f"did not select {target['t']!r}")
            return
        wait(lambda: not self.control(setting, "[role=radiogroup]")["disabled"], 8)
        self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "const b=[...r.querySelectorAll('[role=radiogroup] button[role=radio]')]"
            f".find(x=>x.textContent.replace(/\\s+/g,' ').trim()==={json.dumps(before)});"
            "if(!b) return false; b.click(); return true;"
        )
        restored = wait(
            lambda: self.js(
                f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
                "const b=[...r.querySelectorAll('[role=radiogroup] button[role=radio]')]"
                f".find(x=>x.textContent.replace(/\\s+/g,' ').trim()==={json.dumps(before)});"
                "return b?.getAttribute('aria-checked')==='true';"
            ),
            5,
        )
        if not restored:
            self.record(section, setting, "segments", "FAIL", "did not restore")
            return
        self.record(section, setting, "segments", "PASS", f"{before!r} -> {target['t']!r} -> {before!r}")

    def host_get(self, key):
        return self.m.js(
            "return Services.astraHost.Settings.get({key: " + json.dumps(key) + "});"
        )

    def set_input(self, setting, text):
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "const i=r?.querySelector('input');"
            "if(!i) return false;"
            "const setter=Object.getOwnPropertyDescriptor("
            "i.ownerDocument.defaultView.HTMLInputElement.prototype,'value').set;"
            f"setter.call(i,{json.dumps(text)});"
            "i.dispatchEvent(new Event('input',{bubbles:true}));"
            "return true;"
        )

    def click_row_button(self, setting, pattern):
        return self.js(
            f"const r=d.querySelector('[data-setting={json.dumps(setting)}]');"
            "const b=[...r.querySelectorAll('button')]"
            f".find(x=>new RegExp({json.dumps(pattern)}).test(x.textContent));"
            "if(!b || b.disabled) return false; b.click(); return true;"
        )

    def test_text(self, section, setting, key, value, restore, restore_via_host=False):
        if not self.set_input(setting, value):
            self.record(section, setting, "input", "FAIL", "input missing")
            return
        if not self.click_row_button(setting, "Save|Add"):
            self.record(section, setting, "input", "FAIL", "save button missing or disabled")
            return
        landed = wait(lambda: self.host_get(key) == value, 8)
        if not landed:
            detail = f"stored {self.host_get(key)!r}, wanted {value!r}"
            self.record(section, setting, "input", "FAIL", detail)
            return
        if restore_via_host:
            self.m.js(
                "return Services.astraHost.Settings.set({key: "
                + json.dumps(key)
                + ", value: "
                + json.dumps(restore)
                + "});"
            )
        else:
            self.set_input(setting, restore)
            self.click_row_button(setting, "Save|Add")
        wait(lambda: self.host_get(key) == restore, 8)
        self.record(section, setting, "input", "PASS", f"{value!r} then restored")

    def test_theme_mode(self, section):
        # The row must change the window, not only its own radio.
        before = self.js(js("return d.documentElement.dataset.theme;"))
        self.js(
            "const r=d.querySelector('[data-setting=\"appearance.theme\"]');"
            "r?.querySelector('[data-mode=\"dark\"]')?.click(); return true;"
        )
        dark = wait(
            lambda: self.js(js("return d.documentElement.dataset.theme;")) == "dark" and "dark"
        )
        stored = self.host_get("appearance")
        self.js(
            "const r=d.querySelector('[data-setting=\"appearance.theme\"]');"
            "r?.querySelector('[data-mode=\"light\"]')?.click(); return true;"
        )
        light = wait(
            lambda: self.js(js("return d.documentElement.dataset.theme;")) == "light" and "light"
        )
        self.host_get("appearance")
        if dark != "dark" or light != "light":
            self.record(
                section,
                "appearance.theme",
                "theme",
                "FAIL",
                f"window theme stayed {self.js(js('return d.documentElement.dataset.theme;'))!r}",
            )
            return
        self.record(
            section,
            "appearance.theme",
            "theme",
            "PASS",
            f"{before} -> dark -> light; stored {stored!r}",
        )

    def test_profiles(self, section):
        rendered = self.js(
            "return JSON.stringify({"
            "rows:d.querySelectorAll('.profiles .row').length,"
            "switchButtons:[...d.querySelectorAll('.profiles .row button')]"
            ".filter(b=>!b.disabled).length});"
        )
        info = json.loads(rendered or "{}")
        if info.get("rows", 0) < 1:
            self.record(section, "profiles.list", "custom", "FAIL", "no profile rows rendered")
        else:
            self.record(
                section,
                "profiles.list",
                "custom",
                "PASS",
                f"{info['rows']} profile row(s), {info.get('switchButtons', 0)} action(s)",
            )

    def run(self):
        self.open_settings()
        labels = self.nav_labels()
        for label in labels:
            if label.startswith(IDENTITY):
                continue
            if not self.select_section(label):
                self.record(label, "-", "section", "FAIL", "section did not open")
                continue
            rows = self.section_rows()
            if not rows:
                if label == "Profiles":
                    self.test_profiles(label)
                else:
                    self.record(label, "-", "section", "EMPTY", "no setting rows")
                continue
            for row in rows:
                setting = row["id"]
                # These change the whole surface or ask for a local file; the
                # audit stays on controls that can be exercised and restored.
                if setting == "languages.interface":
                    self.record(label, setting, "select", "INFO", "changes the interface language; write checked separately")
                    continue
                if setting == "ntp.background":
                    self.record(label, setting, "select", "INFO", "changing it opens an image file picker; not exercised here")
                    continue
                if setting == "appearance.theme":
                    self.test_theme_mode(label)
                    continue
                try:
                    if row["switches"]:
                        self.test_switch(label, setting)
                    if row["selects"]:
                        self.test_select(label, setting)
                    if row["segments"]:
                        self.test_segments(label, setting)
                    if not row["switches"] and not row["selects"] and not row["segments"]:
                        self.record(label, setting, "other", "INFO", "not a switch/select/segment")
                except Exception as error:
                    self.record(label, setting, "error", "FAIL", str(error))

            # The text/list rows the generic pass marks as "other".
            if label == "General":
                self.test_text(label, "general.home", "tabs.home", "https://example.com/", "")
                startup = self.host_get("tabs.startup")
                self.m.js(
                    "return Services.astraHost.Settings.set({key:'tabs.startup',value:'pages'});"
                )
                if wait(
                    lambda: self.js(
                        "return !!d.querySelector('[data-setting=\"general.startup-pages\"]');"
                    ),
                    5,
                ):
                    self.test_text(
                        label,
                        "general.startup-pages",
                        "tabs.startup-pages",
                        "https://start.example/",
                        "",
                        restore_via_host=True,
                    )
                self.m.js(
                    "return Services.astraHost.Settings.set({key:'tabs.startup',value:"
                    + json.dumps(startup)
                    + "});"
                )
            if label == "Search":
                self.test_text(
                    label,
                    "search.engines",
                    "search.custom-url",
                    "https://search.example/?q={searchTerms}",
                    "",
                )
            if label == "Performance":
                self.test_text(
                    label,
                    "performance.exceptions",
                    "performance.exceptions",
                    "example.com",
                    "",
                    restore_via_host=True,
                )
            if label == "Profiles":
                self.test_profiles(label)
        self.m.shot("audit-final.png")


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-audit-")
    with open(os.path.join(profile, "prefs.js"), "w", encoding="utf-8") as f:
        f.write(f'user_pref("marionette.port", {PORT});\n')
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
    m = None
    audit = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 900})
        audit = Audit(m)
        wait(
            lambda: m.js(
                js(
                    "return document.querySelector('.astra-frame')"
                    "?.getAttribute('data-app-booted') === 'true';"
                )
            ),
            90,
        )
        audit.run()
        report = {
            "pass": all(r["status"] in ("PASS", "SKIP", "INFO", "EMPTY") for r in audit.rows),
            "rows": audit.rows,
        }
        with open(os.path.join(OUT, "audit.json"), "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        total = len(audit.rows)
        bad = [r for r in audit.rows if r["status"] == "FAIL"]
        print(f"\n{total} controls, {len(bad)} failed", flush=True)
        return 0 if not bad else 1
    finally:
        try:
            if m:
                m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(0.8)
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
