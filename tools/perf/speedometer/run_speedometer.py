#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Speedometer 3.0 / 3.1 harness for the packaged Astra dev build.

Speedometer is the WebKit responsiveness benchmark used by browser vendors:
it runs TodoMVC-style applications in a loop and reports a score where higher
is better. The score is not a percentage and has no upper bound in theory, but
it is calibrated against a reference machine: a fast desktop browser lands in
the tens on Speedometer 3, not in the hundreds.

This harness serves a local copy of Speedometer 3.1 (the engine tree ships the
same 3.1 sources) so a run never depends on the network, drives the real
browser over Marionette, and records the score, confidence interval and run
time. For 3.0 it uses the hosted page (the engine tree has no 3.0 copy) unless
`--url` points at a local mirror.

Usage (always on the private display):
  tools/perf/hidden-display.sh python3 tools/perf/speedometer/run_speedometer.py \
      --version 3.1 --runs 3 --label baseline

  tools/perf/hidden-display.sh python3 tools/perf/speedometer/run_speedometer.py \
      --version 3.0 --runs 3 --label baseline

Exit 0 when every run produced a valid score, 1 otherwise, 2 when the local
3.1 tree or browser is absent.
"""
import argparse
import base64
import datetime
import functools
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PERF_TESTS = os.path.join(ROOT, "engine/third_party/webkit/PerformanceTests")
LOCAL_31 = os.path.join(PERF_TESTS, "Speedometer3")
REMOTE_30 = "https://browserbench.org/Speedometer3.0/"
REMOTE_31 = "https://browserbench.org/Speedometer3.1/"


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

    def shot(self, path):
        data = self.cmd("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        with open(path, "wb") as f:
            f.write(base64.b64decode(data["value"]))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(Quiet, directory=directory)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, httpd.server_address[1]


def wait(fn, timeout=1800, step=1.0):
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


def read_result(m):
    raw = m.js(
        "const r=document.getElementById('result-number');"
        "const c=document.getElementById('confidence-number');"
        "const p=document.getElementById('info-progress');"
        "const score=r ? r.textContent.trim() : '';"
        "return JSON.stringify({"
        "  valid: /^[0-9]/.test(score),"
        "  score,"
        "  confidence: c ? c.textContent.trim() : '',"
        "  progress: p ? p.textContent.trim() : '',"
        "  width: window.innerWidth, height: window.innerHeight,"
        "  suites: (document.getElementById('metrics-results')||{}).textContent ? true : false"
        "});"
    )
    return json.loads(raw)


def hypr_geometry(pid):
    """Float and resize the test window so the content viewport is comparable.

    A tiling compositor gives a new window whatever split is free; Speedometer
    warns below 850x650 and layout differences change the score. This mirrors
    `tools/perf/stress/run_matrix.py`: float, resize to 1600x1000, and either
    park the window on a test output (ASTRA_SPEEDOMETER_MONITOR) or bring it
    to the front for the run. Returns the hyprctl reply or an empty string.
    """
    if not shutil.which("hyprctl"):
        return ""
    monitor = os.environ.get("ASTRA_SPEEDOMETER_MONITOR")
    keep = os.environ.get("ASTRA_SPEEDOMETER_KEEP_FOCUS")
    base = (
        f"local w=hl.get_window('pid:{pid}'); "
        "if not w then return 'no-window' end; "
        "hl.dispatch(hl.dsp.window.float({action='enable', window=w})); "
        "hl.dispatch(hl.dsp.window.resize({x=1600,y=1000,exact=true,window=w})); "
    )
    if monitor:
        code = base + f"hl.dispatch(hl.dsp.window.move({{monitor='{monitor}', window=w}})); "
        if keep and keep != monitor:
            code += f"hl.dispatch(hl.dsp.focus({{monitor='{keep}'}})); "
        code += "return 'ok'"
    else:
        code = base + (
            "hl.dispatch(hl.dsp.window.move({x=100,y=40,window=w})); "
            "hl.dispatch(hl.dsp.focus({window=w})); return 'ok'"
        )
    try:
        out = subprocess.run(
            ["hyprctl", "eval", code], capture_output=True, text=True, timeout=5
        )
        return (out.stdout or "").strip()
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", choices=["3.0", "3.1"], default="3.1")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--iterations", type=int, default=10)
    ap.add_argument("--label", default="run")
    ap.add_argument("--url", default=None, help="override the benchmark URL")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "speedometer"))
    ap.add_argument("--port", type=int, default=2898)
    ap.add_argument("--no-geometry", action="store_true", help="do not float/resize the window")
    ap.add_argument("--run-timeout", type=int, default=300, help="seconds per benchmark run")
    ap.add_argument("--pref", action="append", default=[], metavar="KEY=VALUE",
                    help="extra profile pref (repeatable)")
    args = ap.parse_args()

    if args.version == "3.1" and not args.url and not os.path.isdir(LOCAL_31):
        print(f"SKIP: local Speedometer 3.1 tree absent at {LOCAL_31}", file=sys.stderr)
        return 2
    if not os.path.exists(FIREFOX):
        print(f"SKIP: browser binary absent at {FIREFOX}", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    httpd = None
    if args.url:
        url = args.url
    elif args.version == "3.1":
        httpd, port = serve(PERF_TESTS)
        url = f"http://127.0.0.1:{port}/Speedometer3/index.html"
    else:
        url = REMOTE_30
    url += ("&" if "?" in url else "?") + f"startAutomatically&iterationCount={args.iterations}"

    profile = tempfile.mkdtemp(prefix="astra-speedometer-")
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {args.port});\n')
        f.write('user_pref("media.volume_scale", "0.0");\n')
        # Keep the benchmark page in front and prevent tab unloading.
        f.write('user_pref("browser.tabs.unloadOnLowMemory", false);\n')
        for pref in args.pref:
            key, _, value = pref.partition("=")
            if not key or not _:
                raise SystemExit(f"invalid --pref {pref!r}; expected KEY=VALUE")
            try:
                parsed = json.loads(value)
            except ValueError:
                parsed = value
            f.write(f"user_pref({json.dumps(key)}, {json.dumps(parsed)});\n")
    log = open(os.path.join(profile, "log"), "wb")
    proc = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )

    report = {
        "benchmark": f"Speedometer {args.version}",
        "url": url,
        "label": args.label,
        "iterations": args.iterations,
        "binary": FIREFOX,
        "started": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "runs": [],
    }
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    try:
        m = M(args.port)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.chrome()
        wait(lambda: m.js("return !!Services?.astraHost;"), 120)
        if not args.no_geometry:
            time.sleep(1.5)
            report["geometry"] = hypr_geometry(proc.pid)
        version = m.js("const v = Services.astraHost.System.aboutInfo(); return v && v.version;")
        report["astra_version"] = version

        for run in range(1, args.runs + 1):
            print(f"-- {args.label} {args.version} run {run}/{args.runs}", flush=True)
            m.chrome()
            # A fresh blank document guarantees no stale result survives a
            # same-document navigation (3.0 keeps the previous #result-number
            # when only the query string changes).
            navigate(m, "about:blank")
            time.sleep(0.5)
            navigate(m, url + f"&probe_run={run}")
            started = time.time()
            m.content()
            time.sleep(1.0)

            size = wait(
                lambda: m.js(
                    "return (window.innerWidth>=800 && window.innerHeight>=600)"
                    " ? JSON.stringify({w:window.innerWidth,h:window.innerHeight}) : '';"
                ),
                60,
            )
            report.setdefault("viewport", size)

            result = wait(
                lambda: m.js(
                    "const r=document.getElementById('result-number');"
                    "const n=r ? r.textContent.trim() : '';"
                    "if (n === 'Error') return 'Error';"
                    "return /^[0-9]/.test(n) ? n : '';"
                ),
                args.run_timeout,
            )
            elapsed = round(time.time() - started, 1)
            data = read_result(m)
            data["elapsed_s"] = elapsed
            data["shot"] = os.path.join(args.out, f"{args.label}-{args.version}-{run}.png")
            m.chrome()
            m.shot(data["shot"])
            report["runs"].append(data)
            check(
                f"{args.label} {args.version} run {run} produced a score",
                bool(result)
                and result != "Error"
                and bool(data.get("score"))
                and not (elapsed < 5 and args.iterations >= 5),
                json.dumps(data)[:300],
            )
            print(f"   score {data.get('score')} {data.get('confidence')} in {elapsed}s", flush=True)

        with open(os.path.join(args.out, f"{args.label}-{args.version}.json"), "w") as f:
            json.dump(report, f, indent=2)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        log.close()
        if httpd:
            httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    print("speedometer:", "PASS" if not failures else "FAIL: " + ", ".join(failures))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
