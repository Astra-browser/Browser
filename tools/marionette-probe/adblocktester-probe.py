#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Adblock Tester score probe (D-38, benchmark cover).

Runs https://adblocktester.pages.dev/ in the packaged dev build and proves the
whole benchmark is blocked, not just the network half:

  * every network target is a `fetch(no-cors)` to https://<host>/favicon.ico;
  * four local bait scripts must leave their globals undefined;
  * two cosmetic baits are nodes inserted after load and must be hidden
    within two animation frames.

The page auto-runs in its saved mode, so the probe forces the `full` mode,
restarts the run and waits for `progressText` to reach `N / N`. A pass
requires score 100, zero open rows and the full test count.

Usage:
  python3 tools/marionette-probe/adblocktester-probe.py [--runs 3]

Evidence: out/adblocktester/report.json, run-<n>.png.
Exit 0 only when every run is 100% with zero open rows.
"""
import argparse
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY
PORT = 2897
OUT = os.path.join(ROOT, "out", "adblocktester")
SITE = "https://adblocktester.pages.dev/"
EXPECTED_TESTS = 443
MIN_SCORE = 100


class M:
    def __init__(self, port):
        end = time.time() + 90
        while time.time() < end:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=20)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:500]}")
                return msg[3]

    def js(self, s, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": s, "args": args or []})["value"]

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def shot(self, name):
        data = self.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        raw = base64.b64decode(data["value"])
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(raw)
        return path


def wait(fn, timeout=180, step=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def navigate(m, url):
    tab = m.js("return Services.astraHost.Tabs.list({request_id:'id'}).then(r => r.selected_tab_id);")
    return m.js(
        "return Services.astraHost.Navigation.loadURL({request_id:'live', astra_tab_id:arguments[0], url:arguments[1]});",
        [tab, url],
    )


def read_run(m):
    """Read the finished run: score, counters and every still-open row."""
    raw = m.js(
        "const num=(id)=>{const n=document.getElementById(id);return n?Number(n.textContent.replace(/[^0-9]/g,'')||0):0;};"
        "const rows=[...document.querySelectorAll('.result-row')].map(r=>({"
        "  domain:(r.querySelector('.domain')||{}).textContent||'',"
        "  method:(r.querySelector('.method')||{}).textContent||'',"
        "  status:((r.querySelector('.status-badge')||{}).className||'').replace('status-badge','').trim()"
        "}));"
        "const open=rows.filter(r=>r.status==='open');"
        "return JSON.stringify({"
        "  score:num('scoreValue'),"
        "  status:((document.getElementById('statusText')||{}).textContent||'').trim(),"
        "  progress:((document.getElementById('progressText')||{}).textContent||'').trim(),"
        "  total:num('statTotal'), blocked:num('statBlocked'), open:num('statOpen'),"
        "  rows:rows.length, openRows:open.map(r=>r.domain)"
        "});"
    )
    return json.loads(raw)


def start_run(m):
    """Force the full mode and restart the run for a deterministic measurement."""
    return m.js(
        "const sel=document.getElementById('modeSelect');"
        "if(sel){sel.value='full';sel.dispatchEvent(new Event('change'));}"
        "const btn=document.getElementById('runButton');"
        "if(!btn)return 'no-run-button';"
        "btn.click();"
        "return 'started';"
    )


def finished(m):
    return m.js(
        "const p=((document.getElementById('progressText')||{}).textContent||'').trim();"
        "const m=p.match(/^(\\d+)\\s*\\/\\s*(\\d+)$/);"
        "const total=Number(((document.getElementById('statTotal')||{}).textContent||'').replace(/[^0-9]/g,''));"
        "const rows=document.querySelectorAll('.result-row').length;"
        "if(!m||!total||rows<total)return '';"
        "return Number(m[1])===Number(m[2])&&Number(m[1])===total ? 'done' : '';"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()

    if not os.path.exists(FIREFOX):
        raise SystemExit(f"adblocktester: no build at {FIREFOX}")

    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-adblocktester-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        f.write('user_pref("media.volume_scale", "0.0");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )

    report = {"site": SITE, "runs": [], "engine": {}}
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    try:
        m = M(PORT)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.chrome()
        wait(lambda: m.js("return !!Services?.astraHost;"), 120)

        active = wait(
            lambda: m.js(
                "return Services.astraHost.Blocker.status()"
                ".then(s => s.protection === 'active' ? 'yes' : '');"
            ),
            120,
        )
        check("blocker active on a fresh profile", active == "yes")

        lists = json.loads(
            m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
        )
        report["engine"]["installed_rules"] = lists.get("installed_rules")
        report["engine"]["enabled_lists"] = sum(
            1 for x in lists.get("lists", []) if x.get("enabled")
        )
        check(
            "compiled rule set is the full bundle",
            (lists.get("installed_rules") or 0) > 120000,
            str(lists.get("installed_rules")),
        )

        for run in range(1, args.runs + 1):
            print(f"-- run {run}/{args.runs}")
            m.chrome()
            navigate(m, SITE + f"?probe_run={run}")
            time.sleep(3)
            m.content()

            wait(lambda: m.js("return !!document.getElementById('runButton');"), 120)
            started = start_run(m)
            check(f"run {run} started", started == "started", str(started))

            done = wait(lambda: finished(m), 300)
            check(f"run {run} finished", done == "done")

            data = m.js(
                "const p=((document.getElementById('progressText')||{}).textContent||'').trim();"
                "return p;"
            )
            data = read_run(m)
            data["progress"] = data.get("progress") or ""
            data["shot"] = m.shot(f"run-{run}.png")
            report["runs"].append(data)

            check(
                f"run {run} score is {MIN_SCORE}",
                data["score"] >= MIN_SCORE,
                str(data["score"]),
            )
            check(
                f"run {run} has no open row",
                data["open"] == 0 and not data["openRows"],
                ", ".join(data["openRows"][:12]),
            )
            check(
                f"run {run} ran the whole benchmark",
                data["total"] == EXPECTED_TESTS and data["blocked"] == EXPECTED_TESTS,
                f"{data['blocked']}/{data['total']}",
            )
    finally:
        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        time.sleep(1)
        proc.terminate()
        log.close()

    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(report, f, indent=2)

    if failures:
        print(f"adblocktester: FAIL ({len(failures)} failing checks)")
        return 1
    print("adblocktester: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
