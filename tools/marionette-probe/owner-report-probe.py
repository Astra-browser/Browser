"""Owner-report probe: the fixed surfaces against the packaged dev build.

Checks, over Marionette chrome context:
  * the reported tracker hosts are blocked by the compiled engine rules
  * a top-level document verdict no longer cancels the navigation
  * Back walks to the New Tab the tab started on, and the loading cover clears
  * diagnostics returns real text
  * switch-to-open dedupes an ordinary open but not Duplicate
  * the incognito command is admitted and opens a private window

Usage: python3 /tmp/opencode/astra-fix-probe.py <outdir>
"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2828
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/astra-fix-probe"
os.makedirs(OUT, exist_ok=True)

HOSTS = [
    "c.bing.com", "api.vungle.com", "liftoff.io", "api.fyber.com",
    "ironsource.mobi", "s.youtube.com", "redirector.googlevideo.com",
    "tagmanager.google.com", "fingerprintjs.com", "bnc.lt", "mineralt.io",
    "graph.facebook.com", "analytics.x.com", "widgets.pinterest.com",
    "qevents.quora.com", "sc-analytics.appspot.com", "d.reddit.com",
    "mon.tiktokv.com", "xp.apple.com", "browser.events.data.msn.com",
    "device-metrics-us.amazon.com", "device-metrics-us-2.amazon.com",
    "mads-eu.amazon.com", "cdn.cookielaw.org", "consent.trustarc.com",
    "cdn.privacy-mgmt.com", "s.skimresources.com", "go.skimresources.com",
    "redirector.skimresources.com", "cdn.viglink.com", "st.dynamicyield.com",
    "clientstream.launchdarkly.com", "static.klaviyo.com", "a.klaviyo.com",
    "widget.intercom.io", "js.driftt.com", "dai.google.com", "g.jwpsrv.com",
    "ssl.p.jwpcdn.com",
]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"<html><body><h1>{self.path}</h1></body></html>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
site = f"http://127.0.0.1:{server.server_port}"
threading.Thread(target=server.serve_forever, daemon=True).start()


class Marionette:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", PORT), timeout=60)
        self.f = self.sock.makefile("rb")
        self.n = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            rest += self.f.read(length - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self.n += 1
        payload = json.dumps([0, self.n, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self.n:
                if msg[2]:
                    raise RuntimeError(f"{method}: {msg[2]} {json.dumps(msg[3])[:400]}")
                return msg[3]

    def script(self, script, args=None):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": args or []})["value"]


passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


profile = tempfile.mkdtemp(prefix="astra-fix-", dir="/tmp/opencode")
log = open(os.path.join(OUT, "stderr.log"), "wb")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.join(ROOT, "engine/obj-astra-linux/dist/bin"),
    stdout=log, stderr=subprocess.STDOUT)

m = None
for _ in range(80):
    try:
        m = Marionette()
        break
    except Exception:
        time.sleep(1)
check("marionette connects", m is not None)
if m is None:
    proc.terminate()
    raise SystemExit(1)
m.cmd("WebDriver:NewSession", {"capabilities": {}})
m.cmd("Marionette:SetContext", {"value": "chrome"})

# Wait for the shell + app frame.
booted = False
for _ in range(60):
    try:
        booted = m.script("return document.querySelector('[data-astra-app]')?.dataset?.appReady === 'host';")
        if booted:
            break
    except Exception:
        pass
    time.sleep(1)
check("the app frame boots in host mode", booted)

# The blocker installs its lists in the background after the window boots.
for _ in range(45):
    try:
        ready = m.script('try { const s = Cc["@astra/blocker;1"].getService(Ci.nsIAstraBlockerService); return s.initialized === true; } catch (e) { return false; }')
        if ready:
            break
    except Exception:
        pass
    time.sleep(1)

# --- blocker rules -------------------------------------------------------
state = m.script("""
try {
  const svc = Cc["@astra/blocker;1"].getService(Ci.nsIAstraBlockerService);
  return {
    enabled: svc.enabled === true,
    initialized: svc.initialized === true,
    installed: Services.prefs.getStringPref("astra.blocker.installed", "{}"),
    hits: arguments[0].map((host) => {
      try { return JSON.parse(svc.checkUrl(`https://${host}/`, "", "xmlhttprequest") || "{}"); }
      catch (e) { return { error: String(e) }; }
    }),
    document: JSON.parse(svc.checkUrl("https://tlauncher.org/", "", "document") || "{}"),
  };
} catch (e) { return { error: String(e) }; }
""", [HOSTS])
check("the blocker engine is on", state.get("enabled") is True and state.get("initialized") is True,
      json.dumps(state)[:200])
missed = [HOSTS[i] for i, hit in enumerate(state.get("hits") or [])
          if hit.get("block") is not True]
check("every reported tracker host is blocked", len(missed) == 0, ",".join(missed))
check("the tlauncher document rule matches", state.get("document", {}).get("block") is True,
      json.dumps(state.get("document")))

# --- top-level navigation is not cancelled -------------------------------
res = m.script("""
return (async () => {
const host = Services.astraHost;
const { tabs } = await host.Tabs.list({ request_id: "probe-nav" });
const selected = tabs.find((t) => t.selected) || tabs[0];
await host.Navigation.loadURL({ request_id: "probe-nav-1", astra_tab_id: selected.astra_tab_id, url: arguments[0] + "/a" });
await new Promise((r) => setTimeout(r, 1200));
return { tab: selected.astra_tab_id };
})();
""", [site])
tab = res.get("tab")
time.sleep(1)
loaded = m.script("""
const gb = window.gBrowser;
return gb?.selectedBrowser?.currentURI?.spec ?? "";
""")
check("a loopback page loads", loaded.endswith("/a"), loaded)

# Back to New Tab, then Forward.
m.script("""
return (async () => {
const host = Services.astraHost;
await host.Navigation.loadURL({ request_id: "probe-nav-2", astra_tab_id: arguments[0], url: arguments[1] + "/b" });
return true;
})();
""", [tab, site])
time.sleep(1)
first_back = m.script("return (async () => await Services.astraHost.Navigation.goBack({ request_id: 'probe-back', astra_tab_id: arguments[0] }))();", [tab])
check("Back from B lands on A", first_back.get("went_back") is True and first_back.get("url", "").endswith("/a"),
      json.dumps(first_back))
second_back = m.script("return (async () => await Services.astraHost.Navigation.goBack({ request_id: 'probe-back2', astra_tab_id: arguments[0] }))();", [tab])
check("Back from A reaches the New Tab", second_back.get("went_back") is True and second_back.get("url") == "about:blank",
      json.dumps(second_back))
time.sleep(1)
cover = m.script("""
const content = document.querySelector('.astra-content');
return {
  loading: content?.dataset?.loading ?? null,
  stage: document.documentElement.dataset.astraStage ?? null,
  pointer: content ? getComputedStyle(content).pointerEvents : null,
  url: window.gBrowser?.selectedBrowser?.currentURI?.spec ?? "",
};
""")
check("the New Tab is in front, not a stuck cover",
      cover.get("stage") != "loading" and cover.get("url") == "about:blank",
      json.dumps(cover))
check("the loading slot is pointer-transparent only while loading",
      cover.get("pointer") == "none" if cover.get("loading") == "true" else cover.get("pointer") in ("auto", None),
      json.dumps(cover))

# --- diagnostics ----------------------------------------------------------
report = m.script("return (async () => await Services.astraHost.System.diagnosticsReport())();")
check("diagnostics returns a real report",
      isinstance(report, str) and "Astra diagnostics" in report and "Platform:" in report,
      str(report)[:120])
logs = m.script("return (async () => await Services.astraHost.System.diagnosticsShowLogs())();")
check("show logs folder answers", logs in (True, False))

# --- dedupe / duplicate ---------------------------------------------------
dedupe = m.script("""
return (async () => {
const host = Services.astraHost;
const first = await host.Tabs.create({ request_id: "probe-dup-1", url: "https://dup.example/", background: true });
const again = await host.Tabs.create({ request_id: "probe-dup-2", url: "https://dup.example/", background: true });
const copy = await host.Tabs.duplicate({ request_id: "probe-dup-3", astra_tab_id: first.astra_tab_id, background: true });
return { first: first.astra_tab_id, again: again.astra_tab_id, copy: copy.astra_tab_id };
})();
""")
check("an ordinary duplicate open reuses the tab", dedupe.get("first") == dedupe.get("again"), json.dumps(dedupe))
check("Duplicate still makes a copy", dedupe.get("copy") != dedupe.get("first"), json.dumps(dedupe))

# --- visibility of the tlauncher page (real navigation) ------------------
m.script("""
return (async () => {
await Services.astraHost.Navigation.loadURL({ request_id: "probe-launcher", astra_tab_id: arguments[0], url: "https://tlauncher.org/" });
return true;
})();
""", [tab])
time.sleep(6)
launcher = m.script("""
return {
  url: window.gBrowser?.selectedBrowser?.currentURI?.spec ?? "",
  loading: document.querySelector('.astra-content')?.dataset?.loading ?? null,
};
""")
check("tlauncher is not left blank by a cancelled document",
      launcher.get("url", "").startswith("https://tlauncher.org"),
      json.dumps(launcher))

# --- externally handed link ----------------------------------------------
subprocess.run([FIREFOX, "-profile", profile, "-url", site + "/external-link"],
               cwd=os.path.join(ROOT, "engine/obj-astra-linux/dist/bin"),
               capture_output=True, timeout=30)
time.sleep(4)
handoff = m.script("""
return (async () => {
  const list = await Services.astraHost.Tabs.list({ request_id: "probe-handoff" });
  return list.tabs.map((t) => t.url);
})();
""")
check("a link from another app opens a tab", any(u.endswith("/external-link") for u in handoff),
      json.dumps(handoff))

# --- native close honours after-close ------------------------------------
closing = m.script("""
return (async () => {
  const host = Services.astraHost;
  await host.Settings.set({ key: "tabs.after-close", value: "previous" });
  const a = await host.Tabs.create({ request_id: "probe-ac-1", url: arguments[0] + "/ac-a", background: true });
  const b = await host.Tabs.create({ request_id: "probe-ac-2", url: arguments[0] + "/ac-b", background: true });
  const c = await host.Tabs.create({ request_id: "probe-ac-3", url: arguments[0] + "/ac-c", background: true });
  await host.Tabs.select({ request_id: "probe-ac-sel", astra_tab_id: b.astra_tab_id });
  await new Promise((r) => setTimeout(r, 300));
  const native = [...window.gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === b.astra_tab_id);
  window.gBrowser.removeTab(native);
  await new Promise((r) => setTimeout(r, 900));
  const list = await host.Tabs.list({ request_id: "probe-ac-list" });
  const setting = await host.Settings.get({ key: "tabs.after-close" });
  return { model: list.selected_tab_id, native: window.gBrowser.selectedTab?.getAttribute("astra-tab-id") ?? "",
           a: a.astra_tab_id, b: b.astra_tab_id, c: c.astra_tab_id, setting,
           ids: list.tabs.map((t) => t.astra_tab_id),
           nativeIds: [...window.gBrowser.tabs].map((t) => t.getAttribute("astra-tab-id")) };
})();
""", [site])
check("a native close returns to the previous tab in the model",
      closing.get("model") == closing.get("a"), json.dumps(closing))
check("the native deck follows after-close",
      closing.get("native") == closing.get("a"), json.dumps(closing))

# --- reset all zoom applies to the live page ------------------------------
zoom = m.script("""
return (async () => {
  const host = Services.astraHost;
  const list = await host.Tabs.list({ request_id: "probe-zoom" });
  const selected = list.tabs.find((t) => t.selected) || list.tabs[0];
  await host.Navigation.loadURL({ request_id: "probe-zoom-nav", astra_tab_id: selected.astra_tab_id, url: arguments[0] + "/zoom" });
  await new Promise((r) => setTimeout(r, 800));
  window.gBrowser.selectedBrowser.fullZoom = 1.5;
  await new Promise((r) => setTimeout(r, 200));
  const before = window.gBrowser.selectedBrowser.fullZoom;
  await host.Zoom.call({ expected_profile: "default", call: { kind: "forget_all" } });
  await new Promise((r) => setTimeout(r, 400));
  return { before, after: window.gBrowser.selectedBrowser.fullZoom };
})();
""", [site])
check("reset all returns the live page to 100%",
      abs(float(zoom.get("after", 0)) - 1.0) < 0.01, json.dumps(zoom))

# --- focus shuts a listed site -------------------------------------------
focus = m.script("""
return (async () => {
  const host = Services.astraHost;
  await host.Settings.set({ key: "focus.blocked", value: "127.0.0.1" });
  await host.Time.focus({ control: { kind: "start" } });
  const list = await host.Tabs.list({ request_id: "probe-focus" });
  const selected = list.tabs.find((t) => t.selected) || list.tabs[0];
  await host.Navigation.loadURL({ request_id: "probe-focus-nav", astra_tab_id: selected.astra_tab_id, url: arguments[0] + "/shut" });
  await new Promise((r) => setTimeout(r, 2000));
  const after = await host.Tabs.list({ request_id: "probe-focus-after" });
  const tab = after.tabs.find((t) => t.astra_tab_id === selected.astra_tab_id);
  return { url: tab?.url ?? "", stage: document.querySelector('[data-astra-app]')?.dataset?.surface ?? "" };
})();
""", [site])
check("a shut site is taken off the stage", focus.get("url") in ("about:blank", ""), json.dumps(focus))
m.script("return (async () => await Services.astraHost.Time.focus({ control: { kind: 'stop' } }))();")

# --- private window command ----------------------------------------------
private = m.script("""
return (async () => {
const before = await Services.astraHost.Windows.list({ request_id: "probe-win-1" });
const run = await Services.astraHost.Commands.run({ id: "window.newPrivate" });
await new Promise((r) => setTimeout(r, 1200));
const after = await Services.astraHost.Windows.list({ request_id: "probe-win-2" });
return { admitted: run.accepted === true, before: before.windows.length, after: after.windows.length,
         privates: after.windows.filter((w) => w.private === true).length };
})();
""")
check("the incognito command is admitted", private.get("admitted") is True, json.dumps(private))
check("a private window opens", private.get("privates", 0) >= 1, json.dumps(private))

# Screenshot the live window for the record.
try:
    shot = m.cmd("WebDriver:TakeScreenshot", {})
    with open(os.path.join(OUT, "shot.png"), "wb") as f:
        f.write(base64.b64decode(shot["value"]))
except Exception as e:
    print("screenshot skipped:", e)

print(f"\n{passed} passed, {failed} failed")
print("profile:", profile)
proc.terminate()
sys.exit(0 if failed == 0 else 1)
