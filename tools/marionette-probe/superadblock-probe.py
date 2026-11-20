#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Super Adblock Test score probe (D-38, owner report).

Runs https://superadblocktest.com/ in the packaged dev build and proves the
headline protection score and the raw block rate every time:

  * the site probes ad, tracker, analytics, social, affiliate, consent,
    video, OEM and advanced/risky hosts with `fetch(no-cors)`;
  * a host is counted blocked only when every path fails;
  * the headline is a weighted module score, so 100% alone can hide a
    reachable probe. This probe therefore requires *both*:
      - headline `#percentage` == 100
      - `Completed: N blocked and 0 accessible from N checks`

Usage:
  tools/perf/hidden-display.sh python3 \
      tools/marionette-probe/superadblock-probe.py [--runs 3]

Evidence: out/superadblock/report.json, run-<n>.png.
Exit 0 only when every run is 100% with zero reachable probes.
"""
import argparse
import base64
import json
import os
import re
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
PORT = 2896
OUT = os.path.join(ROOT, "out", "superadblock")
SITE = "https://superadblocktest.com/?run=1"


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
    """Read the finished run: headline, raw counts and every reachable probe."""
    raw = m.js(
        "const p=document.getElementById('percentage');"
        "const t=document.getElementById('testProgress');"
        "const s=document.getElementById('scoreState');"
        "const rows=[...document.querySelectorAll('.adblockHostDiv')];"
        "const accessible=rows.filter(r=>r.dataset.status==='accessible')"
        "  .map(r=>({label:r.dataset.label,category:r.dataset.category,group:r.dataset.group}));"
        "const blocked=rows.filter(r=>r.dataset.status==='blocked').length;"
        "const pending=rows.filter(r=>!r.dataset.status).length;"
        "return JSON.stringify({"
        "  score: p ? p.textContent.replace(/[^0-9]/g,'') : null,"
        "  progress: t ? t.textContent.trim() : '',"
        "  state: s ? s.textContent.trim() : '',"
        "  rows: rows.length, blocked, accessible: accessible.length, pending,"
        "  reachable: accessible"
        "});"
    )
    return json.loads(raw)


def parse_progress(progress):
    match = re.search(r"(\d+)\s+blocked\s+and\s+(\d+)\s+accessible\s+from\s+(\d+)\s+checks", progress)
    if not match:
        return None
    return {
        "blocked": int(match.group(1)),
        "accessible": int(match.group(2)),
        "total": int(match.group(3)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--no-refresh", action="store_true", help="skip the live list refresh")
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-superadblock-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {PORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        f.write('user_pref("media.volume_scale", "0.0");\n')
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )

    report = {"site": "https://superadblocktest.com/", "runs": [], "engine": {}}
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

        if not args.no_refresh:
            refresh = json.loads(
                m.js("return Services.astraHost.Blocker.refreshSources().then(v => JSON.stringify(v));")
            )
            report["engine"]["refresh"] = refresh
            status = wait(
                lambda: m.js(
                    "return Services.astraHost.Blocker.status().then(s =>"
                    " (s.source_phase === 'fresh' || s.source_phase === 'failed')"
                    " ? JSON.stringify(s) : '');"
                ),
                180,
            )
            report["engine"]["status"] = json.loads(status) if status else None
            check("filter lists finished installing", status is not None, str(status)[:200])

        lists = json.loads(
            m.js("return Services.astraHost.Blocker.lists().then(v => JSON.stringify(v));")
        )
        report["engine"]["lists"] = {
            "installed_rules": lists.get("installed_rules"),
            "enabled_lists": sum(1 for x in lists.get("lists", []) if x.get("enabled")),
        }
        check(
            "compiled rule set is the full bundle",
            (lists.get("installed_rules") or 0) > 120000,
            str(lists.get("installed_rules")),
        )

        for run in range(1, args.runs + 1):
            print(f"-- run {run}/{args.runs}")
            m.chrome()
            navigate(m, SITE + f"&probe_run={run}")
            time.sleep(2)
            m.content()

            finished = wait(
                lambda: m.js(
                    "const s=document.getElementById('scoreState');"
                    "const t=document.getElementById('testProgress');"
                    "return (s && s.textContent.trim()==='Complete'"
                    " && t && /Completed:/.test(t.textContent)) ? 'done' : '';"
                ),
                300,
            )
            check(f"run {run} finished", finished == "done")

            data = read_run(m)
            counts = parse_progress(data["progress"])
            data["counts"] = counts
            data["shot"] = m.shot(f"run-{run}.png")
            report["runs"].append(data)

            if counts:
                check(
                    f"run {run} blocks every probe",
                    counts["accessible"] == 0 and counts["blocked"] == counts["total"],
                    f"{counts['blocked']}/{counts['total']} blocked, "
                    f"{counts['accessible']} reachable",
                )
                check(
                    f"run {run} raw block rate is 100",
                    counts["total"] > 0 and counts["blocked"] == counts["total"],
                    str(counts),
                )
            else:
                check(f"run {run} reported counts", False, data["progress"][:200])

            check(f"run {run} headline is 100", data["score"] == "100", str(data["score"]))
            if data["reachable"]:
                print("   reachable:", json.dumps(data["reachable"], indent=1)[:4000])

        with open(os.path.join(OUT, "report.json"), "w") as f:
            json.dump(report, f, indent=2)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()

    print("superadblock:", "PASS" if not failures else "FAIL: " + ", ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
