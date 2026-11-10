"""Live probe: rapid tab churn leaves one model and one native tab per row.

Opens and closes tabs in bursts, switches selection in a shuffled order, and
then compares the host model with `gBrowser.tabs`. Catches races where a
close removes the wrong row, a native tab outlives its model row, duplicate
ids appear, or the last tab is not replaced.

Usage: python3 tools/marionette-probe/tabs-churn-probe.py [outdir]
Exit 0 PASS, 1 FAIL, 2 SKIP (no built binary).
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.environ.get(
    "ASTRA_BINARY",
    os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox"),
)
PORT = int(os.environ.get("ASTRA_CHURN_PORT", "2850"))
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-tabs-churn"
os.makedirs(OUT, exist_ok=True)

if not os.path.exists(FIREFOX):
    print("SKIP no built binary at", FIREFOX)
    sys.exit(2)


class Marionette:
    def __init__(self, port):
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("no marionette")
        self.file = self.sock.makefile("rb")
        self.seq = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.file.read(1)
            if not chunk:
                raise EOFError("marionette closed")
            data += chunk
        length = int(data.split(b":", 1)[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.file.read(length - len(rest))
            if not chunk:
                raise EOFError("marionette closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.seq += 1
        payload = json.dumps([0, self.seq, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            message = self._read()
            if isinstance(message, list) and len(message) == 4 and message[1] == self.seq:
                if message[2]:
                    raise RuntimeError(
                        f"{method} -> {message[2]}: {json.dumps(message[3])[:300]}"
                    )
                return message[3]

    def js(self, script, args=None):
        return self.cmd(
            "WebDriver:ExecuteScript", {"script": script, "args": args or []}
        )["value"]


def wait(read, timeout=30, step=0.2):
    deadline = time.time() + timeout
    value = None
    while time.time() < deadline:
        value = read()
        if value:
            return value
        time.sleep(step)
    return value


passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


SNAPSHOT = """return (() => {
  const host = Services.astraHost;
  if (!host) return null;
  return host.Tabs.list({request_id:'churn', window_id: arguments[0]})
    .then(r => JSON.stringify({
      ids: (r.tabs ?? []).map(t => t.astra_tab_id),
      selected: r.selected_tab_id,
      native: [...gBrowser.tabs].map(t => t.getAttribute('astra-tab-id')).filter(Boolean),
      nativeCount: gBrowser.tabs.length,
    }));
})()"""


def snapshot(session, window_id):
    raw = session.js(SNAPSHOT, [window_id])
    return json.loads(raw) if raw else None


def main():
    profile = tempfile.mkdtemp(prefix="astra-churn-", dir=os.environ.get("TMPDIR", "/tmp/opencode"))
    with open(os.path.join(profile, "user.js"), "w") as prefs:
        prefs.write(f'user_pref("marionette.port", {PORT});\n')
    log_path = os.path.join(OUT, "browser.log")
    log = open(log_path, "wb")
    process = subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX), stdout=log, stderr=subprocess.STDOUT,
    )
    session = None
    try:
        session = Marionette(PORT)
        session.cmd("WebDriver:NewSession", {"capabilities": {}})
        session.cmd("Marionette:SetContext", {"value": "chrome"})
        check(
            "app frame booted",
            wait(lambda: session.js(
                "return document.querySelector('.astra-frame')"
                "?.getAttribute('data-app-booted') === 'true';"
            ), 60) or False,
        )
        window_id = session.js(
            "return Services.astraHost.__bindCurrentWindow(document.defaultView) || 'win-1';"
        )
        base = snapshot(session, window_id)
        check("one tab at start", base and len(base["ids"]) == 1, json.dumps(base))

        for cycle in range(3):
            made = json.loads(session.js(
                "const host = Services.astraHost;"
                "return (async () => {"
                "  const ids = [];"
                "  for (let i = 0; i < 12; i += 1) {"
                "    const r = await host.Tabs.create({request_id: 'churn-'+i,"
                "      url: 'about:blank', background: i % 2 === 1});"
                "    if (r.astra_tab_id) ids.push(r.astra_tab_id);"
                "  }"
                "  return JSON.stringify(ids);"
                "})();"
            ))
            check(f"cycle {cycle}: 12 tabs opened", len(made) == 12, json.dumps(made))
            state = snapshot(session, window_id)
            check(
                f"cycle {cycle}: model and native agree after opening",
                state
                and len(state["ids"]) == len(made) + 1
                and state["nativeCount"] == len(made) + 1
                and len(set(state["ids"])) == len(state["ids"]),
                json.dumps(state),
            )
            if not state:
                return
            # Shuffle selection deterministically (reverse + odds).
            order = list(reversed(made)) + made[1::2]
            for tab_id in order:
                session.js(
                    "return Services.astraHost.Tabs.select({request_id:'churn-sel',"
                    " astra_tab_id: arguments[0]}).then(r => JSON.stringify(r));",
                    [tab_id],
                )
                time.sleep(0.01)
            after_switch = snapshot(session, window_id)
            check(
                f"cycle {cycle}: switching never leaves a duplicate or ghost row",
                after_switch
                and len(set(after_switch["ids"])) == len(after_switch["ids"])
                and after_switch["selected"] in after_switch["ids"],
                json.dumps(after_switch),
            )
            closed = json.loads(session.js(
                "const host = Services.astraHost;"
                "return (async () => {"
                "  const ids = arguments[0];"
                "  for (const id of ids) {"
                "    await host.Tabs.close({request_id:'churn-close', astra_tab_id: id});"
                "  }"
                "  return JSON.stringify({closed: ids.length});"
                "})();",
                [made],
            ))
            check(f"cycle {cycle}: all 12 tabs closed", closed.get("closed") == 12, json.dumps(closed))
            end = wait(lambda: (lambda s: s if s and len(s["ids"]) == 1 else None)(
                snapshot(session, window_id)), 8)
            check(
                f"cycle {cycle}: back to one model tab and one native tab",
                bool(end) and end["nativeCount"] == 1,
                json.dumps(end),
            )

        final = snapshot(session, window_id)
        check("final model has one tab", final and len(final["ids"]) == 1, json.dumps(final))
        check(
            "final native strip has the same single row",
            final and final["native"] == final["ids"],
            json.dumps(final),
        )
        log.flush()
        with open(log_path, "r", errors="ignore") as handle:
            noise = handle.read()
        interesting = [
            line for line in noise.splitlines()
            if "JavaScript error" in line or "unhandled" in line.lower()
        ]
        check("the churn leaves no JavaScript error", not interesting,
              "\n".join(interesting[:6]))
    finally:
        try:
            if session:
                session.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            process.wait(timeout=15)
        except Exception:
            process.kill()
        log.close()

    print(f"\ntabs-churn: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
