#!/usr/bin/env python3
"""Media card: artwork, live transport, mute and more than one player.

Serves two pages that play a tone and publish Media Session metadata with
artwork. Drives the real Astra card and the rail's media list, and proves that
what the host projects (title, artwork, playing, muted, other players) is what
the person sees and can act on.

  python3 tools/marionette-probe/media-card-probe.py
Exit 0 PASS, 1 FAIL, 2 SKIP when this display has no active media controller.
"""
import http.server, io, json, math, os, signal, socketserver, struct, subprocess, sys, tempfile, threading, time, wave, zlib

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BIN = astra_env.BINARY
PORT = 2947
MPORT = 2948
sys.path.insert(0, os.path.join(ROOT, "tests/contract"))
import load_state as L

def tone(seconds=30, rate=8000, hz=440):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * hz * i / rate)))
            for i in range(rate * seconds)))
    return out.getvalue()

def cover(red, green, blue, side=96):
    raw = b"".join(b"\x00" + bytes((red, green, blue)) * side for _ in range(side))
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

TONE_A = tone(hz=440)
TONE_B = tone(hz=660)
COVER_A = cover(196, 46, 52)
COVER_B = cover(36, 118, 184)

def page(title, artist, wav, art):
    return (f"""<!doctype html><meta charset=utf-8><title>{title}</title>
<audio id=t src="/{wav}" autoplay loop></audio><p>{title}</p>
<script>
const t = document.getElementById('t');
navigator.mediaSession.metadata = new MediaMetadata({{
  title: {json.dumps(title)},
  artist: {json.dumps(artist)},
  artwork: [{{ src: "/{art}", sizes: "96x96", type: "image/png" }}],
}});
navigator.mediaSession.setActionHandler('play', () => t.play());
navigator.mediaSession.setActionHandler('pause', () => t.pause());
t.play().catch(() => {{}});
</script>""").encode()

PAGES = {
    "/a": page("Tone A", "Alpha Site", "a.wav", "a.png"),
    "/b": page("Tone B", "Beta Site", "b.wav", "b.png"),
}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        bodies = {
            "/a.wav": (TONE_A, "audio/wav"),
            "/b.wav": (TONE_B, "audio/wav"),
            "/a.png": (COVER_A, "image/png"),
            "/b.png": (COVER_B, "image/png"),
            "/a": (PAGES["/a"], "text/html; charset=utf-8"),
            "/b": (PAGES["/b"], "text/html; charset=utf-8"),
        }
        body, ctype = bodies.get(path, (b"not found", "text/plain"))
        self.send_response(200 if path in bodies else 404)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

class S(socketserver.TCPServer):
    allow_reuse_address = True

httpd = S(("127.0.0.1", PORT), H)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
profile = tempfile.mkdtemp(prefix="astra-media-card-")
open(os.path.join(profile, "user.js"), "w").write(
    f'user_pref("marionette.port", {MPORT});\n'
    'user_pref("astra.onboarding.force", "skip");\n'
    'user_pref("browser.shell.checkDefaultBrowser", false);\n'
    'user_pref("media.autoplay.default", 0);\n'
    'user_pref("media.autoplay.blocking_policy", 0);\n'
    'user_pref("media.autoplay.block-webaudio", false);\n'
)
log = open(os.path.join(profile, "browser.log"), "wb")
proc = subprocess.Popen(
    [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access",
     "--marionette", "about:blank"],
    cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True)
try:
    m = L.Marionette(MPORT, timeout=120)
    m.sock.settimeout(180)
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    m.cmd("WebDriver:SetTimeouts", {"script": 150000, "implicit": 0, "pageLoad": 60000})
    m.cmd("Marionette:SetContext", {"value": "chrome"})
    time.sleep(4)
    js = r"""
    const done = arguments[arguments.length - 1];
    (async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let host = null;
      for (let i = 0; i < 80; i++) {
        host = Services.astraHost;
        if (host?.Media && host?.Tabs) break;
        await wait(250);
      }
      const out = { steps: [], diag: {} };
      const step = (name, ok, detail = null) =>
        out.steps.push({ name, ok: ok === true, detail });
      const tabs = async () =>
        (await host.Tabs.list({ request_id: "media-card" })).tabs ?? [];
      const WID = (await tabs())[0]?.window_id || "win-1";
      const view = () => host.Media.view(WID);
      const app = () =>
        document.querySelector("iframe[data-astra-app-frame]")?.contentDocument ?? null;
      const q = (sel) => app()?.querySelector(sel) ?? null;
      const qa = (sel) => [...(app()?.querySelectorAll(sel) ?? [])];
      const card = () =>
        [...(app()?.querySelectorAll(".media-player section, section.media-player") ?? [])][0] ?? null;
      let a = "";
      let b = "";
      const browserOf = (id) => {
        const native = [...gBrowser.tabs].find(
          (t) => t.getAttribute("astra-tab-id") === id);
        return native?.linkedBrowser ?? null;
      };
      const controllerOf = (id) => {
        try { return browserOf(id)?.browsingContext?.mediaController ?? null; }
        catch { return null; }
      };
      const waitFor = async (pred, ms = 15000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          try { if (pred()) return true; } catch {}
          await wait(200);
        }
        return false;
      };
      const enterCard = async () => {
        const el = card();
        if (!el) return;
        el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
        await wait(120);
      };
      const clickWithin = (root, sel) => {
        const el = root?.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      };

      // --- first player --------------------------------------------------
      a = (await host.Tabs.create({
        request_id: "a",
        url: `http://127.0.0.1:__PORT__/a`,
        background: false,
      })).astra_tab_id;
      const activeA = await waitFor(() => controllerOf(a)?.isActive === true);
      if (!activeA) {
        done(JSON.stringify({ skip: "no active media controller (no audio device)" }));
        return;
      }
      const ctrlA = controllerOf(a);
      const namedA = await waitFor(() => view()?.tab_id === a);
      step("the card names the page that plays", namedA, view());
      step("the title is the page's own", view()?.title === "Tone A", view()?.title);
      const waitArt = await waitFor(
        () => (view()?.artwork || "").startsWith("data:image/"));
      step("the page's artwork reaches the projection", waitArt, (view()?.artwork || "").slice(0, 32));
      step("the card paints that artwork as its plate",
        await waitFor(() => q("img.media-art")?.getAttribute("src")?.startsWith("data:image/")),
        q("img.media-art")?.getAttribute("src")?.slice(0, 32) ?? null);

      // --- transport through the real card ------------------------------
      const toggle = () => q("button.media-toggle");
      toggle()?.click();
      step("the card's pause stops playback",
        await waitFor(() => view()?.playing === false), view()?.playing);
      toggle()?.click();
      step("the card's play resumes playback",
        await waitFor(() => view()?.playing === true), view()?.playing);

      const mute = () => q(".media-head button[aria-pressed]");
      mute()?.click();
      step("the card's mute mutes the tab",
        await waitFor(() => view()?.muted === true && browserOf(a)?.audioMuted === true),
        { muted: view()?.muted, audioMuted: browserOf(a)?.audioMuted });
      mute()?.click();
      step("the card's unmute restores the tab",
        await waitFor(() => view()?.muted === false && browserOf(a)?.audioMuted === false),
        view()?.muted);

      // --- a second site, both listed -----------------------------------
      b = (await host.Tabs.create({
        request_id: "b",
        url: `http://127.0.0.1:__PORT__/b`,
        background: false,
      })).astra_tab_id;
      const ctrlB = controllerOf(b);
      const namedB = await waitFor(() =>
        view()?.tab_id === b && (view()?.artwork || "").startsWith("data:image/"));
      step("the newer playback takes the card", namedB, view()?.tab_id);
      step("its title and artwork follow", view()?.title === "Tone B" &&
        (view()?.artwork || "").startsWith("data:image/"), view()?.title);
      const peerA = await waitFor(
        () => (view()?.players ?? []).some((p) => p.tab_id === a));
      step("the other player stays in the projection", peerA,
        (view()?.players ?? []).map((p) => p.tab_id));
      step("the other player keeps its own title",
        (view()?.players ?? []).some((p) => p.tab_id === a && p.title === "Tone A"),
        (view()?.players ?? []).find((p) => p.tab_id === a) ?? null);

      await enterCard();
      const queue = card()?.querySelector(".media-queue");
      step("the card lists the other player", !!queue, queue?.textContent ?? null);
      const peerMute = queue?.querySelector(".media-peer button[aria-label='Mute tab']");
      peerMute?.click();
      step("the list's mute reaches the other page",
        await waitFor(() => browserOf(a)?.audioMuted === true),
        browserOf(a)?.audioMuted);
      peerMute && peerMute.click();
      await wait(400);
      const peerPause = card()?.querySelector(".media-peer button[aria-label='Pause']");
      peerPause?.click();
      step("the list's pause reaches the other page",
        await waitFor(() => ctrlA?.isPlaying === false), ctrlA?.isPlaying);

      // --- the rail's media entry ---------------------------------------
      const mediaButton = [...(app()?.querySelectorAll("button[title='Media']") ?? [])][0] ??
        [...(app()?.querySelectorAll(".utility-bar button") ?? [])]
          .find((el) => (el.getAttribute("aria-label") || "") === "Media");
      mediaButton?.click();
      await wait(400);
      const railArt = q(".utility-bar img.rail-trigger-art");
      step("the rail's media button shows the artwork",
        !!railArt && (railArt.getAttribute("src") || "").startsWith("data:image/"),
        railArt?.getAttribute("src")?.slice(0, 32) ?? null);
      const rows = qa(".bar-popover .media-row");
      step("the rail lists both players", rows.length >= 2, rows.length);
      const rowTitles = rows.map(
        (row) => row.querySelector(".rail-row-title")?.textContent ?? "");
      step("both names are readable", rowTitles.includes("Tone A") &&
        rowTitles.includes("Tone B"), rowTitles);
      const peerRow = rows.find(
        (row) => row.querySelector(".rail-row-title")?.textContent === "Tone A");
      step("the rail keeps the other player's artwork or site mark",
        !!peerRow?.querySelector("img.rail-art, .favicon"),
        peerRow?.innerHTML?.slice(0, 80) ?? null);
      peerRow?.querySelector(".rail-peer-control")?.click();
      step("the rail plays the other page",
        await waitFor(() => ctrlA?.isPlaying === true), ctrlA?.isPlaying);

      out.diag = {
        ...out.diag,
        a, b, view: view(),
        players: (view()?.players ?? []).map((p) => ({
          id: p.tab_id, title: p.title, playing: p.playing, muted: p.muted,
        })),
      };
      done(JSON.stringify(out));
    })()
    """.replace("__PORT__", str(PORT))
    result = json.loads(m.execute_async(js))
    if result.get("skip"):
        print(f"media-card-probe: SKIP — {result['skip']}", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(result, indent=2))
    ok = bool(result.get("steps")) and all(s["ok"] for s in result["steps"])
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
finally:
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    log.close()
    httpd.shutdown()
    import shutil
    shutil.rmtree(profile, ignore_errors=True)
