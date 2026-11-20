"""Parity probe: site permissions, browsing data, blocker honesty, the sleep
driver, time reporting, and search bangs/custom engines in the live build.

Usage: python3 tools/marionette-probe/settings-parity-probe.py [out-dir]
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

HOST, PORT = "127.0.0.1", 2843
FIREFOX = astra_env.BINARY
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/settings-parity"

APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
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


def wait(fn, timeout=12, step=0.2):
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


results = {"checks": [], "pass": False}


def check(name, ok, detail=None):
    results["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" -- {detail}"), flush=True)


def host(m, expr):
    return m.js("return Services.astraHost." + expr)


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-parity-")
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
    m = None
    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        m.cmd("WebDriver:SetWindowRect", {"width": 1280, "height": 900})
        wait(
            lambda: m.js(
                js(
                    "return document.querySelector('.astra-frame')"
                    "?.getAttribute('data-app-booted') === 'true';"
                )
            ),
            90,
        )
        time.sleep(1)

        # --- site permissions ---------------------------------------------
        seeded = m.js(
            "const p=Services.scriptSecurityManager"
            ".createContentPrincipalFromOrigin('https://perm-probe.example');"
            "Services.perms.addFromPrincipal(p,'camera',"
            "Ci.nsIPermissionManager.ALLOW_ACTION,"
            "Ci.nsIPermissionManager.EXPIRE_NEVER); return true;"
        )
        listed = host(m, "Permissions.listSites({origin:'https://perm-probe.example'})")
        entries = listed.get("entries", []) if isinstance(listed, dict) else []
        camera = next((e for e in entries if e.get("kind") == "camera"), None)
        check("site permissions list a seeded camera decision", camera is not None, listed)
        check(
            "the listed decision is Allow",
            camera is not None and camera.get("decision") == "allow",
            camera,
        )
        changed = host(
            m,
            "Permissions.setSite({origin:'https://perm-probe.example',"
            "kind:'camera',decision:'block'})",
        )
        capability = m.js(
            "const p=Services.scriptSecurityManager"
            ".createContentPrincipalFromOrigin('https://perm-probe.example');"
            "const o=Services.perms.getPermissionObject(p,'camera',false);"
            "return o?o.capability:null;"
        )
        check(
            "site permissions write Block back to Services.perms",
            changed.get("accepted") is True and capability == 2,
            {"result": changed, "capability": capability},
        )
        removed = host(
            m,
            "Permissions.setSite({origin:'https://perm-probe.example',"
            "kind:'camera',decision:null})",
        )
        left = m.js(
            "const p=Services.scriptSecurityManager"
            ".createContentPrincipalFromOrigin('https://perm-probe.example');"
            "return Services.perms.getPermissionObject(p,'camera',false)===null;"
        )
        check("removing a site permission clears it", left is True, removed)

        # --- clear browsing data -----------------------------------------
        m.js(
            "const p=Services.scriptSecurityManager"
            ".createContentPrincipalFromOrigin('https://clear-probe.example');"
            "Services.perms.addFromPrincipal(p,'camera',"
            "Ci.nsIPermissionManager.ALLOW_ACTION,"
            "Ci.nsIPermissionManager.EXPIRE_NEVER);"
            "Services.cookies.add('clear-probe.example','/','k','v',false,false,false,"
            "Date.now()/1000+3600,{},Ci.nsICookie.SAMESITE_NONE,"
            "Ci.nsICookie.SCHEME_HTTPS); return true;"
        )
        cleared = host(
            m,
            "BrowsingData.call({expected_profile:'default',call:{kind:'clear',"
            "range:'hour',history:false,cookies:true,cache:false,downloads:false}})",
        )
        cookies = m.js(
            "return Services.cookies.countCookiesFromHost('clear-probe.example',{});"
        )
        check("clear browsing data answers cleared", cleared.get("kind") == "cleared", cleared)
        check("clear browsing data removes the cookie", cookies == 0, cookies)
        private_clear = host(
            m,
            "BrowsingData.call({expected_profile:'incognito',call:{kind:'clear',"
            "range:'hour',history:false,cookies:true,cache:false,downloads:false}})",
        )
        check(
            "a private profile cannot clear the persistent store",
            private_clear.get("kind") == "error" and private_clear.get("error") == "private",
            private_clear,
        )

        # --- blocker honesty ----------------------------------------------
        status = host(m, "Blocker.status()")
        check(
            "the blocker reports the live native state",
            status.get("protection") in ("active", "degraded", "pending")
            and status.get("can_enable") is True
            and status.get("preference") == "authoritative",
            status,
        )
        check(
            "active protection names the installed generation",
            status.get("protection") != "active"
            or (
                status.get("applied_enabled") is True
                and isinstance(status.get("retained_generation"), str)
            ),
            status,
        )
        stats = host(m, "Blocker.stats({profile:'default'})")
        check(
            "blocker stats are bounded numbers (0 is a real count)",
            (stats.get("today") is None or (isinstance(stats.get("today"), int) and stats["today"] >= 0))
            and (
                stats.get("last7Days") is None
                or (isinstance(stats.get("last7Days"), int) and stats["last7Days"] >= 0)
            ),
            stats,
        )

        # --- search bangs and custom engine --------------------------------
        base = "https://search.example/?q=%s"
        host(
            m,
            "Settings.set({key:'search.custom-url',value:'https://search.example/?q=%s'})",
        )
        custom = host(m, "Search.resolve({input:'custom probe'})")
        check(
            "custom engine resolves with %s",
            custom.get("kind") == "search"
            and "search.example" in custom.get("url", ""),
            custom,
        )
        for bang, expected in [
            ("!g rust", "google."),
            ("!d rust", "duckduckgo."),
            ("!b rust", "bing."),
            ("!br rust", "brave."),
        ]:
            resolved = host(m, "Search.resolve({input:" + json.dumps(bang) + "})")
            check(
                f"{bang.split()[0]} resolves to {expected.rstrip('.')}",
                expected in resolved.get("url", ""),
                resolved,
            )

        # --- sleep driver ---------------------------------------------------
        host(m, "Settings.set({key:'performance.after',value:'5'})")
        host(m, "Settings.set({key:'performance.sleep',value:'true'})")
        host(m, "Settings.set({key:'performance.exceptions',value:''})")
        ids = []
        for n in range(1, 5):
            created = host(
                m,
                "Tabs.create({request_id:'parity',url:'https://sleep-"
                + str(n)
                + ".example/',background:true})",
            )
            ids.append(created.get("astra_tab_id"))
        first = host(m, "Tabs.list({request_id:'parity'})").get("tabs", [])
        selected = next((t.get("astra_tab_id") for t in first if t.get("selected")), None)
        for tid in ids:
            if tid != selected:
                host(
                    m,
                    "Tabs.select({request_id:'parity',astra_tab_id:"
                    + json.dumps(tid)
                    + "})",
                )
                break
        time.sleep(1.5)
        m.js("Services.astraHost.Performance.start({browser:()=>gBrowser}); return true;")
        future = int(time.time() * 1000) + 6 * 60 * 1000
        tick = host(m, f"Performance.tick({future})")
        slept = tick.get("slept", []) if isinstance(tick, dict) else []
        check("the sleep driver selects idle tabs", len(slept) > 0, tick)
        discarded = []
        for tid in slept:
            got = host(m, "Tabs.get({request_id:'parity',astra_tab_id:" + json.dumps(tid) + "})")
            if got.get("tab", {}).get("discarded") is True:
                discarded.append(tid)
        check("selected tabs are actually discarded", len(discarded) > 0, discarded)
        if discarded:
            host(
                m,
                "Tabs.wakeup({request_id:'parity',astra_tab_id:"
                + json.dumps(discarded[0])
                + "})",
            )
            awake = host(
                m,
                "Tabs.get({request_id:'parity',astra_tab_id:"
                + json.dumps(discarded[0])
                + "})",
            )
            check(
                "waking a sleeping tab clears discarded",
                awake.get("tab", {}).get("discarded") is False,
                awake,
            )

        # --- time tracking ---------------------------------------------------
        host(m, "Settings.set({key:'time.track',value:'true'})")
        m.js(
            "Services.astraHost.__setTimeIdleForTests(false);"
            "Services.astraHost.__setTimeFocusedForTests(true); return true;"
        )
        created = host(
            m,
            "Tabs.create({request_id:'parity',url:'https://time-probe.example/',"
            "background:false})",
        )
        time_id = created.get("astra_tab_id")
        host(
            m,
            "Tabs.select({request_id:'parity',astra_tab_id:"
            + json.dumps(time_id)
            + "})",
        )
        time.sleep(0.8)
        hour = int((time.time() - time.timezone) * 1000 // 3600000)
        # The tracker credits the previous observation's interval, so open it
        # with a report call, wait, then read again.
        host(
            m,
            "Time.call({profile:'default',call:{kind:'report',from_hour:"
            + str(hour - 1)
            + ",bucket_hours:1,buckets:3,site:null}})",
        )
        time.sleep(0.8)
        host(
            m,
            "Time.call({profile:'default',call:{kind:'report',from_hour:"
            + str(hour - 1)
            + ",bucket_hours:1,buckets:3,site:null}})",
        )
        time.sleep(6)
        hour = int((time.time() - time.timezone) * 1000 // 3600000)
        m.js("window.focus(); return true;")
        try:
            m.cmd("WebDriver:PerformActions", {"actions":[{"type":"pointer","id":"m","parameters":{"pointerType":"mouse"},"actions":[{"type":"pointerMove","duration":100,"origin":"viewport","x":400,"y":300},{"type":"pointerMove","duration":100,"origin":"viewport","x":420,"y":320}]}]})
        except Exception:
            pass
        try:
            subprocess.run(["wtype", "a"], timeout=5, check=False)
        except Exception:
            pass
        time.sleep(2)
        time.sleep(1.5)
        host(
            m,
            "Time.call({profile:'default',call:{kind:'report',from_hour:"
            + str(hour - 1)
            + ",bucket_hours:1,buckets:3,site:null}})",
        )
        time.sleep(2.5)
        report = host(
            m,
            "Time.call({profile:'default',call:{kind:'report',from_hour:"
            + str(hour - 1)
            + ",bucket_hours:1,buckets:3,site:null}})",
        )
        sites = report.get("sites", []) if isinstance(report, dict) else []
        check(
            "time tracking reports the selected site",
            any(row.get("site") == "time-probe.example" for row in sites),
            report,
        )

        m.shot("parity-final.png")
        results["pass"] = all(c["ok"] for c in results["checks"])
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
        with open(os.path.join(OUT, "parity.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
        print(json.dumps({"pass": results["pass"], "checks": len(results["checks"])}, indent=2))
    return 0 if results["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
