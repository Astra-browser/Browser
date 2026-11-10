#!/usr/bin/env python3
"""Astra platform passkeys: create, sign in, wrong PIN, browser-wide switch,
and the file-at-rest check, on the packaged dev build.

Usage: python3 tools/marionette-probe/passkeys-probe.py <outdir>
"""
import base64
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/home/rem/Projects/Astra"
FIREFOX = os.path.join(ROOT, "engine/obj-astra-linux/dist/bin/firefox")
PORT = 2828
PIN = "123456"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/passkeys"
os.makedirs(OUT, exist_ok=True)

PAGE = """<!doctype html><meta charset="utf-8"><title>passkey probe</title>
<script>
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
window.__challenge = () => crypto.getRandomValues(new Uint8Array(32));
window.__create = () => {
  window.__result = null;
  window.__error = null;
  navigator.credentials.create({ publicKey: {
    challenge: window.__challenge(),
    rp: { id: location.hostname, name: "Astra probe" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "probe", displayName: "Probe" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 30000,
  }}).then((cred) => {
    window.__result = {
      id: b64(cred.rawId),
      attachment: cred.authenticatorAttachment,
      transports: cred.response.getTransports ? cred.response.getTransports() : null,
    };
  }, (error) => { window.__error = String(error); });
  return true;
};
window.__get = () => {
  window.__result = null;
  window.__error = null;
  navigator.credentials.get({ publicKey: {
    challenge: window.__challenge(),
    rpId: location.hostname,
    userVerification: "required",
    timeout: 30000,
  }}).then((cred) => {
    window.__result = {
      id: b64(cred.rawId),
      attachment: cred.authenticatorAttachment,
      signature: b64(cred.response.signature),
    };
  }, (error) => { window.__error = String(error); });
  return true;
};
window.__uvpaa = () => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
</script>
<body>probe</body>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
site = f"http://localhost:{server.server_port}/"
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

    def chrome(self):
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def content(self):
        self.cmd("Marionette:SetContext", {"value": "content"})


passed = failed = 0


def focus_page(m):
    """The sheet lives in the chrome; a later WebAuthn call needs the page's
    browsing context focused again, as a person's click would make it."""
    m.chrome()
    m.script("Services.focus.activeWindow = window; window.focus(); gBrowser.selectedTab.linkedBrowser.focus();")
    m.content()


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


profile = tempfile.mkdtemp(prefix="astra-passkey-", dir="/tmp/opencode")
proc = subprocess.Popen(
    [FIREFOX, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(FIREFOX),
    stdout=open(os.path.join(OUT, "stderr.log"), "wb"), stderr=subprocess.STDOUT)

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
m.chrome()

for _ in range(60):
    try:
        if m.script("return document.querySelector('[data-astra-app]')?.dataset?.appReady === 'host';"):
            break
    except Exception:
        pass
    time.sleep(1)

# The app publishes the vault path on load; the service creates the vault.
status = m.script("""
return (async () => {
  const host = Services.astraHost.Passkeys;
  const created = host.call({ call: { kind: "enable", pin: "%s", system_unlock: false } });
  return { created, status: host.status(), path: Services.prefs.getStringPref("astra.passkeys.vault", "") };
})();
""" % PIN)
check("the vault is created from Settings", status.get("created", {}).get("ok") is True, json.dumps(status))
check("the vault path is published", status.get("path", "").endswith("astra/passkeys/vault.json"), json.dumps(status))

m.script("""
return (async () => {
  const list = await Services.astraHost.Tabs.list({ request_id: "passkey" });
  const selected = list.tabs.find((t) => t.selected) || list.tabs[0];
  // WebAuthn refuses a request outside the active tab; a probe window is not
  // focused by the compositor, so raise it the way a person's click would.
  Services.focus.activeWindow = window;
  window.focus();
  await Services.astraHost.Navigation.loadURL({
    request_id: "passkey-nav", astra_tab_id: selected.astra_tab_id, url: arguments[0],
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  gBrowser.selectedTab.linkedBrowser.focus();
  return selected.astra_tab_id;
})();
""", [site])
time.sleep(2)
m.content()

check("the probe page is a secure context",
      m.script("return window.isSecureContext === true;") is True)
check("the platform authenticator is advertised",
      m.script("return window.__uvpaa();") is True)

# --- create -----------------------------------------------------------------
focus_page(m)
m.script("return window.__create();")
time.sleep(0.4)
m.chrome()
prompt = None
for _ in range(40):
    prompt = m.script("return Services.astraHost.Passkeys.currentPrompt();")
    if prompt:
        break
    time.sleep(0.25)
check("Astra's sheet receives the PIN prompt", (prompt or {}).get("prompt", {}).get("type") == "pin-required", json.dumps(prompt))
raised = m.script("""
const app = document.querySelector("iframe.astra-app-frame")?.contentDocument;
return {
  app: app?.documentElement?.dataset?.astraRaised === "true",
  frame: document.querySelector(".astra-frame")?.dataset?.astraMenuOpen === "true",
  sheet: !!app?.querySelector(".sheet"),
};
""")
check("the sheet raises the app frame over the page", raised.get("app") is True and raised.get("frame") is True and raised.get("sheet") is True, json.dumps(raised))
time.sleep(0.6)
shot = m.cmd("WebDriver:TakeScreenshot", {"full": False}).get("value")
if shot:
    with open(os.path.join(OUT, "passkey-sheet.png"), "wb") as f:
        f.write(base64.b64decode(shot))

# Answer through the surface, not the service: set the field and press Continue.
answered = m.script("""
return (async () => {
const app = document.querySelector("iframe.astra-app-frame")?.contentDocument;
const input = app?.querySelector(".sheet input[type=password]");
const button = app?.querySelector(".sheet .actions button[data-variant=primary]");
if (!input || !button) return false;
input.value = arguments[0];
input.dispatchEvent(new Event("input", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 100));
if (button.disabled) return false;
button.click();
return true;
})();
""", [PIN])
check("the sheet offers a PIN field and Continue", answered is True)

m.content()
created = None
for _ in range(60):
    created = m.script("return window.__result;")
    error = m.script("return window.__error;")
    if created or error:
        break
    time.sleep(0.25)
check("a passkey is created", created is not None and created.get("id"), json.dumps(created))
check("it reports the platform attachment", (created or {}).get("attachment") == "platform", json.dumps(created))
check("it advertises the internal transport", "internal" in ((created or {}).get("transports") or []), json.dumps(created))
m.chrome()
lowered = m.script("""
const app = document.querySelector("iframe.astra-app-frame")?.contentDocument;
return {
  app: app?.documentElement?.dataset?.astraRaised === "true",
  frame: document.querySelector(".astra-frame")?.dataset?.astraMenuOpen === "true",
};
""")
check("the frame goes back under the page when the prompt closes", lowered.get("app") is False and lowered.get("frame") is False, json.dumps(lowered))

# --- sign in ----------------------------------------------------------------
focus_page(m)
m.script("return window.__get();")
time.sleep(0.4)
m.chrome()
for _ in range(40):
    prompt = m.script("return Services.astraHost.Passkeys.currentPrompt();")
    if prompt:
        break
    time.sleep(0.25)
check("sign-in asks for the passkey PIN", (prompt or {}).get("prompt", {}).get("type") == "pin-required", json.dumps(prompt))
m.script("""
return (async () => {
const app = document.querySelector("iframe.astra-app-frame")?.contentDocument;
const input = app?.querySelector(".sheet input[type=password]");
const button = app?.querySelector(".sheet .actions button[data-variant=primary]");
if (!input || !button) return false;
input.value = arguments[0];
input.dispatchEvent(new Event("input", { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 100));
if (button.disabled) return false;
button.click();
return true;
})();
""", [PIN])
m.content()
signed = None
for _ in range(60):
    signed = m.script("return window.__result;")
    error = m.script("return window.__error;")
    if signed or error:
        break
    time.sleep(0.25)
check("the saved passkey signs in", signed is not None and signed.get("id") == (created or {}).get("id"), json.dumps(signed))
check("the assertion carries a signature", len((signed or {}).get("signature") or "") > 0, json.dumps(signed))

# --- wrong PIN (vault path) -------------------------------------------------
m.chrome()
m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'lock' } });")
wrong = m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'unlock', pin: '000000' } });")
check("a wrong PIN is refused", wrong.get("ok") is False and wrong.get("error") == "auth", json.dumps(wrong))
check("the attempt counter drops", wrong.get("status", {}).get("pin_retries_left", 9) < 5, json.dumps(wrong))
right = m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'unlock', pin: '%s' } });" % PIN)
check("the right PIN unlocks the vault again", right.get("ok") is True, json.dumps(right))

check("the settings list has one passkey",
      len(m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'list' } });").get("credentials", [])) == 1)

# --- browser-wide switch ----------------------------------------------------
m.chrome()
off = m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'set_enabled', enabled: false } });")
check("the browser-wide switch turns passkeys off", off.get("status", {}).get("enabled") is False, json.dumps(off))
m.content()
check("a disabled browser stops advertising a platform authenticator",
      m.script("return window.__uvpaa();") is False)
m.chrome()
m.script("return Services.astraHost.Passkeys.call({ call: { kind: 'set_enabled', enabled: true } });")

# --- at rest ----------------------------------------------------------------
vault = os.path.join(profile, "astra", "passkeys", "vault.json")
check("the vault file exists", os.path.exists(vault), vault)
if os.path.exists(vault):
    mode = stat.S_IMODE(os.stat(vault).st_mode)
    check("the vault is owner-only", mode == 0o600, oct(mode))
    text = open(vault, "rb").read().decode("utf-8", "replace")
    check("the vault does not contain the PIN", PIN not in text)
    check("the vault does not contain the relying party in clear", "localhost" not in text)
    check("the vault has a sealed credential list", '"ct"' in text and '"tag"' in text)

print(f"\n{passed} passed, {failed} failed")
print("profile:", profile)
proc.terminate()
sys.exit(0 if failed == 0 else 1)
