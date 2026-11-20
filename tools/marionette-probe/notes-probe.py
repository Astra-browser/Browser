"""Notes and Tasks probe: both now save natively.

Notes: open the panel, make a note, type, Escape, Save -> the note is listed.
Tasks: open the panel, type a task, Enter -> the task is listed, no failure.

Usage: python3 tools/marionette-probe/notes-probe.py <profile-dir> <out-dir>
"""
import json
import os
import socket
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
FIREFOX = astra_env.BINARY
APP = "const f=document.querySelector('iframe[data-astra-app-frame]');const d=f&&f.contentDocument;"


def js(body):
    return "return (() => {" + APP + body + "})()"


def row(label):
    return js(f"""
      if (!d) return 'no doc';
      const n = [...d.querySelectorAll('[role="menuitem"]')].find((x) => (x.textContent || '').trim().startsWith('{label}'));
      if (!n) return 'no {label.lower()} row';
      n.click();
      return 'ok';
    """)


OPEN_MENU = js("""
  if (!d) return 'no doc';
  const c = d.querySelector('.shelf .case');
  if (!c) return 'no case';
  c.click();
  return 'ok';
""")

RELOAD = js("""
  if (!d) return 'no doc';
  f.contentWindow.location.reload();
  return 'ok';
""")

NEW_NOTE = js("""
  if (!d) return 'no doc';
  const b = d.querySelector('button.new-note') || [...d.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'New note');
  if (!b) return 'no new note button';
  b.click();
  return 'ok';
""")

TYPE_NOTE = js("""
  if (!d) return 'no doc';
  const doc = d.querySelector('.note-document');
  if (!doc) return 'no document';
  doc.focus();
  d.defaultView.getSelection().selectAllChildren(doc);
  d.execCommand('insertText', false, 'Remember the milk');
  return 'ok';
""")

ESCAPE = js("""
  if (!d) return 'no doc';
  const doc = d.querySelector('.note-document') || d;
  doc.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  return 'ok';
""")

PROMPT = js("""
  if (!d) return null;
  const p = d.querySelector('[role="dialog"]');
  return JSON.stringify({ open: !!p, text: p ? (p.textContent || '').replace(/\\s+/g, ' ').slice(0, 120) : null });
""")

SAVE = js("""
  if (!d) return 'no doc';
  const p = d.querySelector('[role="dialog"]');
  if (!p) return 'no dialog';
  const b = [...p.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Save');
  if (!b) return 'no save';
  b.click();
  return 'ok';
""")

TYPE_TASK = js("""
  if (!d) return 'no doc';
  const t = d.querySelector('section.shared-tool textarea');
  if (!t) return 'no composer';
  t.focus();
  t.value = 'Buy stamps';
  t.dispatchEvent(new d.defaultView.Event('input', { bubbles: true }));
  t.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return 'ok';
""")

TOOL_TEXT = js("""
  if (!d) return null;
  const t = d.querySelector('section.shared-tool');
  return t ? (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 200) : null;
""")


class M:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=30)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError
            data += chunk
        n = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < n:
            rest += self.f.read(n - len(rest))
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        p = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(p)).encode() + b":" + p)
        while True:
            m = self._read()
            if isinstance(m, list) and len(m) == 4 and m[1] == self._id:
                if m[2]:
                    raise RuntimeError(m)
                return m[3]

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})["value"]


def main():
    profile, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    log = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=log, stderr=subprocess.STDOUT)
    m = None
    for _ in range(60):
        try:
            m = M(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("no marionette")
        proc.terminate()
        return 1
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(20)

    failures = []

    # Notes: type, Escape, Save.
    print("notes.menu:", m.js(OPEN_MENU))
    time.sleep(1)
    print("notes.open:", m.js(row("Notes")))
    time.sleep(3)
    print("notes.new:", m.js(NEW_NOTE))
    time.sleep(2)
    print("notes.type:", m.js(TYPE_NOTE))
    time.sleep(2)
    print("notes.escape:", m.js(ESCAPE))
    time.sleep(1)
    prompt = json.loads(m.js(PROMPT))
    print("notes.prompt:", json.dumps(prompt))
    if not prompt.get("open"):
        failures.append("Escape did not ask")
    print("notes.save:", m.js(SAVE))
    time.sleep(3)
    text = m.js(TOOL_TEXT) or ""
    print("notes.text:", text[:120])
    if "Remember the milk" not in text:
        failures.append("the note was not saved")

    # Tasks: type, Enter.
    print("reload:", m.js(RELOAD))
    time.sleep(10)
    print("tasks.menu:", m.js(OPEN_MENU))
    time.sleep(1)
    print("tasks.open:", m.js(row("Tasks")))
    time.sleep(3)
    print("tasks.type:", m.js(TYPE_TASK))
    time.sleep(3)
    tasks = m.js(TOOL_TEXT) or ""
    print("tasks.text:", tasks[:160])
    if "Buy stamps" not in tasks:
        failures.append("the task was not saved")
    if "cannot be saved" in tasks.lower():
        failures.append("tasks still report a failed save")

    print("VERDICT:", "PASS" if not failures else "FAIL " + "; ".join(failures))
    proc.terminate()
    return 0 if not failures else 1


sys.exit(main())
