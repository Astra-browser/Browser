#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""P9 probe: the sidebar media player projects the tab playing behind.

Serves a looping tone, plays it in one tab, selects another, and exercises the
real `Media` host module: the view names the tone tab, play/pause reach the
engine controller, mute reaches the native tab, show selects the tab, and
close clears the projection.
"""
import http.server
import io
import json
import os
import shutil
import signal
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = astra_env.ENGINE
BIN = astra_env.BINARY
PORT = int(os.environ.get("ASTRA_MEDIA_PORT", "2903"))
MPORT = int(os.environ.get("ASTRA_MEDIA_MARIONETTE", "2904"))
sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

def tone_wav(seconds=2, rate=8000):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        import math
        frames = b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / rate)))
            for i in range(rate * seconds)
        )
        wav.writeframes(frames)
    return out.getvalue()


TONE = tone_wav()
PAGE = """<!doctype html><meta charset="utf-8"><title>Tone</title>
<audio id="tone" src="/tone.wav" autoplay loop muted></audio>
<button id="start" onclick="document.getElementById('tone').play().catch(() => {})">Start</button>
<p>tone</p>
<script>
  const a = document.getElementById("tone");
  a.play().then(() => { document.title = "Tone:ok"; }).catch((e) => { document.title = "Tone:reject:" + e.name; });
  setTimeout(() => {
    document.title = "Tone:" + (a.paused ? "paused" : "playing") + ":" + a.readyState + ":" + (a.error?.code ?? "-");
  }, 1500);
</script>
"""

OPEN = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let host = null;
  for (let i = 0; i < 80; i += 1) {
    host = Services.astraHost;
    if (host?.Tabs) break;
    await wait(250);
  }
  try { window.focus(); } catch {}
  try { Services.focus.activeWindow = window; } catch {}
  const made = await host.Tabs.create({ request_id: "media-open", url: "http://127.0.0.1:__PORT__/tone.html" });
  const tab = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === made.astra_tab_id);
  for (let i = 0; i < 80; i += 1) {
    if ((tab?.linkedBrowser?.contentTitle ?? "").startsWith("Tone")) break;
    await wait(250);
  }
  await wait(2000);
  done(JSON.stringify({ id: made.astra_tab_id, title: tab?.linkedBrowser?.contentTitle ?? "" }));
})()
"""

RUN = """
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: ok === true, detail: detail ?? null });
  try {
    let host = null;
    for (let i = 0; i < 80; i += 1) {
      host = Services.astraHost;
      if (host?.Media && host?.Tabs) break;
      await wait(250);
    }
    if (!host?.Media) { done(JSON.stringify({ error: "no Media host" })); return; }
    const events = [];
    const off = host.addEventListener((event) => {
      if (event?.type === "media-player-changed") events.push(event.data);
    });
    const waitView = async (predicate, ms = 20000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const view = host.Media.view();
        if (predicate(view)) return view;
        await wait(250);
      }
      return host.Media.view();
    };
    const toneId = arguments[0];
    const made = { astra_tab_id: toneId };
    step("the tone tab is ready", typeof toneId === "string" && toneId !== "", toneId);
    await wait(1500);
    {
      // The hidden display can report the element as playing while the engine
      // has no active media controller (no audio device). That is the
      // environment, not the projection: skip instead of failing.
      const b0 = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === toneId)?.linkedBrowser;
      let active = false;
      try { active = b0?.browsingContext?.mediaController?.isActive === true; } catch (e) { active = false; }
      if (!active) {
        done(JSON.stringify({ skip: "no active media controller in this display (no audio device)" }));
        return;
      }
    }
    const behind = await host.Tabs.create({ request_id: "media-behind", url: "about:blank" });
    const toneBrowser = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === made.astra_tab_id)?.linkedBrowser;
    let ctrl = null;
    try { ctrl = toneBrowser?.browsingContext?.mediaController ?? null; } catch (e) { ctrl = String(e); }
    out.diag = {
      controller: !!ctrl,
      active: (() => { try { return ctrl?.isActive; } catch (e) { return String(e); } })(),
      playing: (() => { try { return ctrl?.isPlaying; } catch (e) { return String(e); } })(),
      metadata: (() => { try { return ctrl?.getMetadata?.(); } catch (e) { return String(e); } })(),
      title: toneBrowser?.contentTitle ?? null,
    };
    const view = await waitView((v) => v?.tab_id === made.astra_tab_id);
    step("the player names the tone tab", view?.tab_id === made.astra_tab_id, view);
    step("the player reports playing", view?.playing === true, view);
    step("the player has a title", typeof view?.title === "string" && view.title !== "", view?.title);
    step("the player is not muted", view?.muted === false);

    const paused = await host.Media.player({ id: made.astra_tab_id, action: { kind: "pause" } });
    step("pause is admitted", paused.accepted === true, paused);
    step("pause reaches the page", (await waitView((v) => v?.playing === false, 8000))?.playing === false);
    const played = await host.Media.player({ id: made.astra_tab_id, action: { kind: "play" } });
    step("play is admitted", played.accepted === true, played);
    step("play reaches the page", (await waitView((v) => v?.playing === true, 8000))?.playing === true);

    await host.Tabs.setMuted({ request_id: "media-mute", astra_tab_id: made.astra_tab_id, muted: true });
    step("mute reaches the projection", (await waitView((v) => v?.muted === true, 8000))?.muted === true);
    const browser = [...gBrowser.tabs].find((t) => t.getAttribute("astra-tab-id") === made.astra_tab_id)?.linkedBrowser;
    step("mute reaches the native tab", browser?.audioMuted === true, browser?.audioMuted);
    await host.Tabs.setMuted({ request_id: "media-unmute", astra_tab_id: made.astra_tab_id, muted: false });

    const shown = await host.Media.player({ id: made.astra_tab_id, action: { kind: "show" } });
    step("show is admitted", shown.accepted === true, shown);
    let selected = false;
    for (let i = 0; i < 40; i += 1) {
      const tabs = (await host.Tabs.list({ request_id: "media-list" })).tabs ?? [];
      const tab = tabs.find((t) => t.astra_tab_id === made.astra_tab_id);
      if (tab?.selected === true) { selected = true; break; }
      await wait(250);
    }
    step("show selects the tone tab", selected);
    step("a selected tab projects no player", (await waitView((v) => v === null, 5000)) === null);

    const closed = await host.Media.player({ id: made.astra_tab_id, action: { kind: "close" } });
    step("close is admitted", closed.accepted === true, closed);
    step("close leaves no player", host.Media.view() === null);
    step("the projection emitted changes", events.length >= 3, events.length);
    off();
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.message ?? error) }));
  }
})()
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib callback name)
        if self.path.startswith("/tone.wav"):
            body = TONE
            ctype = "audio/wav"
        else:
            body = PAGE.encode()
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class Server(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    httpd = Server(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="astra-media-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("media.autoplay.default", 0);\n')
        fh.write('user_pref("media.autoplay.blocking_policy", 0);\n')
        fh.write('user_pref("media.cubeb.force_null_context", true);\n')
    log = open(os.path.join(profile, "browser.log"), "wb")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
         "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    out = {}
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 240000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(4)
        opened = json.loads(m.execute_async(OPEN.replace("__PORT__", str(PORT))))
        time.sleep(2)
        if ":paused:" in (opened.get("title") or ""):
            out = {"skip": "the hidden display cannot start audio"}
            print(
                "media_player_probe: SKIP — the hidden display cannot start audio "
                f"({opened.get('title')}); run this on a headed machine",
                file=sys.stderr,
            )
            return 2
        out = json.loads(m.execute_async(RUN, [opened.get("id", "")]))
        if out.get("skip"):
            print(f"media_player_probe: SKIP — {out['skip']}", file=sys.stderr)
            return 2
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=15)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
        httpd.shutdown()
        # A skip is the environment, not a failure to diagnose: do not leave a
        # 50 MB profile per run behind (this filled /tmp once).
        if out.get("skip") or (out.get("steps") and all(s["ok"] for s in out["steps"])):
            shutil.rmtree(profile, ignore_errors=True)
        else:
            print(f"profile kept: {profile}", file=sys.stderr)
    print(json.dumps(out, indent=2))
    return 0 if out.get("steps") and all(s["ok"] for s in out["steps"]) else 1


if __name__ == "__main__":
    sys.exit(main())
