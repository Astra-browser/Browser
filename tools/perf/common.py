#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Shared helpers for tools/perf benchmarks (P4-T10). Stdlib only.

Conventions (mirroring tools/contract-runner/run.py):
- Binary resolution: $ASTRA_BINARY, else <root>/engine/obj-astra-linux/...
  (the built tree; used read-only via a fresh tmp profile), else the main
  checkout's built tree (read-only reference, never modified), else `firefox`
  on PATH. The chosen binary and its --version are recorded in every result.
- Exit codes: 0 PASS, 1 FAIL, 2 SKIP (browser/toolchain absent). run_all.py
  treats SKIP as non-failing but records it; a bench must SKIP, never fake
  numbers, when it cannot measure.
"""
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

PERF_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(PERF_DIR))
MAIN_CHECKOUT = "/home/rem/Projects/Astra"
OBJ_SUB = os.path.join("engine", "obj-astra-linux", "dist", "bin", "firefox")
GD_SUB = os.path.join("engine", "obj-astra-linux", "dist", "host", "bin", "geckodriver")


def resolve_binary():
    """Return (path, origin) for the browser binary, or (None, reason)."""
    env = os.environ.get("ASTRA_BINARY")
    if env:
        if os.path.exists(env):
            return env, "env:ASTRA_BINARY"
        return None, f"ASTRA_BINARY={env} does not exist"
    for base, origin in (
        (ROOT, "worktree engine"),
        (MAIN_CHECKOUT, "main-checkout engine (read-only reference)"),
    ):
        cand = os.path.join(base, OBJ_SUB)
        if os.path.exists(cand):
            return cand, origin
    which = shutil.which("firefox")
    if which:
        return which, "PATH:firefox"
    return None, "no browser binary found (set ASTRA_BINARY)"


def resolve_geckodriver():
    env = os.environ.get("ASTRA_GECKODRIVER")
    if env:
        if os.path.exists(env):
            return env, "env:ASTRA_GECKODRIVER"
        return None, f"ASTRA_GECKODRIVER={env} does not exist"
    for base, origin in (
        (ROOT, "worktree engine"),
        (MAIN_CHECKOUT, "main-checkout engine (read-only reference)"),
    ):
        cand = os.path.join(base, GD_SUB)
        if os.path.exists(cand):
            return cand, origin
    which = shutil.which("geckodriver")
    if which:
        return which, "PATH:geckodriver"
    return None, "no geckodriver found (set ASTRA_GECKODRIVER)"


def firefox_version(binary):
    try:
        out = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=30
        ).stdout.strip()
        return out or "unknown"
    except Exception as e:
        return f"unknown ({e})"


def median(xs):
    s = sorted(xs)
    n = len(s)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def percentile(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    rank = round(p / 100.0 * (len(s) - 1))
    return float(s[min(rank, len(s) - 1)])


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_tcp(port, timeout=60.0):
    """Poll until 127.0.0.1:port accepts; return seconds waited or None."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1.0):
                return time.monotonic() - t0
        except OSError:
            time.sleep(0.05)
    return None


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class FixtureServer:
    """Loopback static server for tools/perf/fixtures/ (stdlib only)."""

    def __init__(self, directory=None):
        handler = functools.partial(
            _QuietHandler,
            directory=directory or os.path.join(PERF_DIR, "fixtures"),
        )
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.thread.join(timeout=10)

    def url(self, path):
        return f"http://127.0.0.1:{self.port}/{path}"


def make_wd(base):
    def wd(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)["value"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}")

    return wd


class Geckodriver:
    """Manages a geckodriver subprocess + one WebDriver session."""

    def __init__(self, binary, geckodriver, profile=None, extra_args=()):
        self.binary = binary
        self.geckodriver = geckodriver
        self.port = free_port()
        self.profile = profile or tempfile.mkdtemp(prefix="astra-perf-")
        self._own_profile = profile is None
        self.extra_args = list(extra_args)
        self.proc = None
        self.session = None
        self.wd = None

    SYSTEM_ACCESS_ARG = "-remote-allow-system-access"

    def start(self):
        log = open(os.path.join(tempfile.gettempdir(), "astra-perf-gd.log"), "a")
        self.proc = subprocess.Popen(
            [self.geckodriver, "--port", str(self.port)],
            stdout=log, stderr=subprocess.STDOUT,
        )
        self.wd = make_wd(f"http://127.0.0.1:{self.port}")
        for _ in range(150):
            try:
                self.wd("GET", "/status")
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("geckodriver /status never came up")
        args = ["--headless", "--no-remote", "--profile", self.profile,
                self.SYSTEM_ACCESS_ARG] + self.extra_args
        try:
            self.session = self._new_session(args)
        except RuntimeError as e:
            # Newer geckodrivers (>=0.36-ish) reject --remote-allow-system-access
            # via capabilities. Retry without it; chrome-context probes then
            # report unsupported instead of failing the bench.
            if self.SYSTEM_ACCESS_ARG in str(e):
                args = [a for a in args if a != self.SYSTEM_ACCESS_ARG]
                self.system_access = False
                self.session = self._new_session(args)
            else:
                raise
        else:
            self.system_access = True
        # Wait until Marionette is driving (same probe as contract-runner).
        for _ in range(150):
            try:
                self.wd("GET", f"/session/{self.session}/title")
                break
            except RuntimeError:
                time.sleep(0.3)
        else:
            raise RuntimeError("browser never became driven")
        return self

    def _new_session(self, args):
        return self.wd("POST", "/session", {"capabilities": {"alwaysMatch": {
            "moz:firefoxOptions": {
                "binary": self.binary,
                "args": args,
            }}}})["sessionId"]

    def navigate(self, url):
        self.wd("POST", f"/session/{self.session}/url", {"url": url})

    def execute(self, script, args=None):
        return self.wd("POST", f"/session/{self.session}/execute/sync",
                       {"script": script, "args": args or []})

    def execute_async(self, script, args=None):
        return self.wd("POST", f"/session/{self.session}/execute/async",
                       {"script": script, "args": args or []})

    def chrome(self, script, args=None):
        """Run script in chrome context; restores content context after."""
        self.wd("POST", f"/session/{self.session}/moz/context", {"context": "chrome"})
        try:
            return self.wd("POST", f"/session/{self.session}/execute/sync",
                           {"script": script, "args": args or []})
        finally:
            self.wd("POST", f"/session/{self.session}/moz/context",
                    {"context": "content"})

    def new_tab(self, url):
        handle = self.wd("POST", f"/session/{self.session}/window/new",
                          {"type": "tab"})
        if isinstance(handle, dict):
            handle = handle.get("handle", handle)
        self.navigate(url)
        return handle

    def handles(self):
        return self.wd("GET", f"/session/{self.session}/window/handles")

    def close_to_first(self):
        """Close all tabs but the first; leave it selected on blank."""
        handles = self.handles()
        first = handles[0]
        # WebDriver closes the *current* window: switch, then DELETE /window.
        for h in handles[1:]:
            self.switch(h)
            self.wd("DELETE", f"/session/{self.session}/window")
        self.switch(first)
        return first

    def switch(self, handle):
        self.wd("POST", f"/session/{self.session}/window", {"handle": handle})

    def title(self):
        return self.wd("GET", f"/session/{self.session}/title")

    def stop(self):
        try:
            if self.session and self.wd:
                try:
                    self.wd("DELETE", f"/session/{self.session}")
                except Exception:
                    pass
        finally:
            self.session = None
            if self.proc:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                self.proc = None
            # Reap any browser orphaned when session creation failed: in
            # that path geckodriver never tracks the child, so DELETE never
            # runs for it. Match by profile path (unique per session).
            kill_by_marker(self.profile)
            if self._own_profile:
                shutil.rmtree(self.profile, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


def proc_rss_kb(marker):
    """Sum VmRSS (KiB) of all processes whose cmdline contains marker."""
    total = 0
    count = 0
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode(errors="replace")
            if marker not in cmd:
                continue
            rss = 0
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1])
                        break
            total += rss
            count += 1
        except (OSError, ValueError):
            continue
    return total, count


def kill_by_marker(marker, grace_s=5.0):
    """SIGTERM then SIGKILL every process whose cmdline contains marker.

    Safety: never matches our own harness (marker is a tmp profile path;
    callers pass the bracket trick only for shell use). Skips PID 1 and self.
    Used to reap browsers orphaned when session creation itself fails (in
    that path geckodriver never learns the child, so stop() must reap by
    profile marker or processes leak and later runs starve).
    """
    import signal
    me = os.getpid()
    for sig in (signal.SIGTERM, signal.SIGKILL):
        victims = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            if int(pid) in (1, me):
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read().replace(b"\0", b" ").decode(errors="replace")
                if marker in cmd:
                    victims.append(int(pid))
            except (OSError, ValueError):
                continue
        if not victims:
            return
        for pid in victims:
            try:
                os.kill(pid, sig)
            except (OSError, PermissionError):
                continue
        if sig == signal.SIGTERM:
            time.sleep(grace_s)
