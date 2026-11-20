"""Profiles switch probe: a switch moves the window, never launches another one.

The engine cannot change a running process's profile directory, so Astra gives
each profile a space backed by a Firefox container and switches the active
space. This probe asserts that contract live:

  - switching is accepted and the roster's `current` follows the active space
  - the window count and the process count do not change (no new window or
    browser instance)
  - the profile left behind keeps its tabs and gets its session back on return
  - cookies and localStorage do not cross profiles (per-container partitions)

The probe profile is removed at the end.
"""
import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2846
FIREFOX = astra_env.BINARY
OUT = sys.argv[1] if len(sys.argv) > 1 else "out/profiles-switch"


class H(BaseHTTPRequestHandler):
    def _body(self, text, cookie=None):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    requests = []

    def do_GET(self):
        self.requests.append((self.path, self.headers.get("Cookie") or ""))
        if self.path.startswith("/set"):
            self._body("cookie set", "probe=" + self.path.split("=", 1)[-1] + "; Path=/")
        elif self.path.startswith("/read"):
            self._body("cookie:" + (self.headers.get("Cookie") or ""))
        else:
            self._body("home")

    def log_message(self, *args):
        pass


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
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:300]}")
                return msg[3]

    def js(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]


def launch(profile, port):
    with open(os.path.join(profile, "prefs.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {port});\nuser_pref("astra.onboarding.force", "skip");\n')
    log = open(os.path.join(profile, "log"), "wb")
    return subprocess.Popen(
        [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(FIREFOX),
        stdout=log,
        stderr=subprocess.STDOUT,
    )


def connect(port):
    m = M(port)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    return m


def wait(fn, timeout=30, step=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def processes(profile):
    # The main process is the one launched with this profile; content processes
    # do not carry `-profile` and may come and go with pages.
    out = subprocess.run(
        ["pgrep", "-f", "--", f"-profile {profile}"], capture_output=True, text=True
    )
    return len(out.stdout.split())


def windows(m):
    return m.js("return (()=>{let n=0;for(const w of Services.wm.getEnumerator('navigator:browser'))n++;return n;})()")


def active_url(m):
    return m.js(
        "return (()=>{try{return gBrowser.selectedBrowser.currentURI.spec}catch(e){return ''}})()"
    )


def profile_current(m):
    return m.js(
        "return Services.astraHost.Profiles.get().then(r=>r?r.current:null);"
    )


def navigate(m, url):
    tab = m.js("return Services.astraHost.Tabs.list({request_id:'sel'}).then(r=>r.selected_tab_id);")
    m.js(
        "return Services.astraHost.Navigation.loadURL({request_id:'n',astra_tab_id:arguments[0],url:arguments[1]});",
        [tab, url],
    )
    wait(lambda: active_url(m).startswith(url), 20)


def page_eval(m, expression):
    """Evaluate in the selected page's own context; remote tabs have no
    chrome-visible contentWindow, and Marionette's content context stays on
    the tab it was created with until it is switched explicitly."""
    handle = m.js(
        "return (()=>{const {NavigableManager}=ChromeUtils.importESModule("
        "'chrome://remote/content/shared/NavigableManager.sys.mjs');"
        "return NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);})()"
    )
    m.cmd("Marionette:SetContext", {"value": "content"})
    try:
        if handle:
            m.cmd("WebDriver:SwitchToWindow", {"handle": handle})
        return m.js("return (()=>{try{return " + expression + "}catch(e){return 'ERR:'+e}})()")
    finally:
        m.cmd("Marionette:SetContext", {"value": "chrome"})


def main():
    os.makedirs(OUT, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    profile = tempfile.mkdtemp(prefix="astra-switch-")
    proc = launch(profile, PORT)
    work = None
    failures = []
    m = None
    try:
        m = connect(PORT)
        wait(lambda: m.js("return document.querySelector('.astra-frame')?.getAttribute('data-app-booted') === 'true';"), 60)
        time.sleep(3)
        before_processes = processes(profile)
        before_windows = windows(m)
        initial = json.loads(
            m.js("return Services.astraHost.Profiles.get().then(r=>JSON.stringify(r));") or "{}"
        )
        running = initial.get("current")
        print("windows", before_windows, "processes", before_processes, "running", running, flush=True)

        # Personal: sign in (cookie) and keep a local value in its space.
        navigate(m, base + "/set?p=personal")
        time.sleep(1)
        cookie = page_eval(m, "document.cookie")
        print("personal cookie", cookie, flush=True)
        page_eval(m, "localStorage.setItem('probe','personal')")
        personal_cookie = cookie

        made = m.js(
            "return Services.astraHost.Profiles.create({name:'Switch Probe',"
            "avatar:{style:'initials',color:1,symbol:0,photo:null}});"
        )
        print("create", made, flush=True)
        roster = json.loads(m.js("return Services.astraHost.Profiles.get().then(r=>JSON.stringify(r));") or "{}")
        work = next((p["id"] for p in roster.get("profiles", []) if p.get("name") == "Switch Probe"), None)
        assert work, "the probe profile was not created"

        # Drive the switch from the rail, so the evidence covers the app ->
        # bridge -> host path rather than only the host call.
        opened = m.js(
            "return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');"
            "const d=f&&f.contentDocument;const t=d&&d.querySelector('.rail-profile');"
            "if(!t)return 'no trigger';t.click();return 'opened';})()"
        )
        time.sleep(0.4)
        clicked = m.js(
            "return (()=>{const f=document.querySelector('iframe[data-astra-app-frame]');"
            "const d=f&&f.contentDocument;if(!d)return 'no app';"
            "const row=[...d.querySelectorAll('[role=\"menuitem\"]')].find(b=>"
            "(b.getAttribute('title')||b.textContent||'').includes('Switch Probe'));"
            "if(!row)return 'no row';row.click();return 'clicked';})()"
        )
        print("rail switch", opened, clicked, flush=True)
        if clicked != "clicked":
            failures.append("the profile menu did not offer the new profile")
        current = wait(lambda: profile_current(m) == work, 15)
        print("current profile", profile_current(m), flush=True)
        work_space = m.js("return Services.astraHost.__spacesState().active_space_id;")
        print(
            "switched space",
            work_space,
            "container",
            m.js("return gBrowser.selectedTab.getAttribute('usercontextid');"),
            flush=True,
        )
        if not current:
            failures.append("the roster did not report the chosen profile as current")
        if windows(m) != before_windows:
            failures.append("the switch opened another window")
        if processes(profile) != before_processes:
            failures.append("the switch launched another browser process")

        # The new profile has an empty cookie jar and storage.
        navigate(m, base + "/read")
        time.sleep(1)
        print("http requests", H.requests[-6:], flush=True)
        work_cookie = page_eval(m, "document.cookie")
        work_storage = page_eval(m, "localStorage.getItem('probe')")
        print("work cookie", work_cookie, "storage", work_storage, flush=True)
        if "probe=personal" in (work_cookie or ""):
            failures.append("a profile read the other profile's cookie")
        if work_storage not in (None, "null", ""):
            failures.append("a profile read the other profile's localStorage")
        page_eval(m, "localStorage.setItem('probe','work')")
        navigate(m, base + "/set?p=work")
        time.sleep(1)

        # Back to the running profile: its tab and its cookies are restored.
        back = m.js(
            "return Services.astraHost.Profiles.switch({profile:arguments[0]});", [running]
        )
        print("back", back, running, flush=True)
        time.sleep(1)
        if not back.get("accepted"):
            failures.append("switching back was not accepted")
        restored = wait(lambda: (base + "/read") in active_url(m) or (base + "/set") in active_url(m), 10)
        print("restored tab", active_url(m), flush=True)
        if not restored:
            failures.append("the earlier profile's tab was not restored")
        navigate(m, base + "/read")
        time.sleep(1)
        personal_again = page_eval(m, "document.cookie")
        print("personal cookie again", personal_again, flush=True)
        if "probe=personal" not in (personal_again or ""):
            failures.append("the earlier profile lost its cookie")

        # Return to Work: its tab is the one left open there.
        m.js("return Services.astraHost.Profiles.switch({profile:arguments[0]});", [work])
        restored_work = wait(lambda: active_url(m) == base + "/set?p=work", 10)
        print("tab after returning to work", active_url(m), flush=True)
        if not restored_work:
            failures.append("the chosen profile's tab was not kept")

        removed = m.js(
            "return Services.astraHost.Profiles.remove({profile:arguments[0]});", [work]
        )
        print("remove", removed, flush=True)
        left = m.js(
            "return Services.astraHost.Containers.list({request_id:'left'}).then(c=>"
            "JSON.stringify(c.containers.map(x=>x.name||x.cookieStoreId)));"
        )
        spaces = m.js("return JSON.stringify(Services.astraHost.__spacesState().spaces.map(s=>s.id));")
        print("after remove", left, spaces, flush=True)
        if f'"Astra {work_space}"' in left:
            failures.append("the deleted profile's container was left behind")
        if f'"{work_space}"' in spaces:
            failures.append("the deleted profile's space was left behind")
        print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures), flush=True)
        try:
            m.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        if failures:
            sys.exit(1)
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            pass


main()
