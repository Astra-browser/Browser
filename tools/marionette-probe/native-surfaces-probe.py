#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live proof for the native surfaces lane.

Launches the packaged dev build, opens real pages, and drives the same Host
API the app calls: native split view create/resize/replace/leave/restore,
peek capture of a real page, per-space history and extension reads,
cross-space cloning, and a light/dark measurement of the app frame.

Usage: python3 tools/marionette-probe/native-surfaces-probe.py <profile> <outdir>
Exit 0 on PASS, 1 on FAIL. The browser is closed before exit.
"""

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time

HOST, PORT = "127.0.0.1", 2828
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = os.path.join(ROOT, "engine", "obj-astra-linux", "dist", "bin", "firefox")


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection((HOST, port), timeout=180)
        self.f = self.sock.makefile("rb")
        self._id = 0
        self._read()

    def _read(self):
        data = b""
        while b":" not in data:
            chunk = self.f.read(1)
            if not chunk:
                raise EOFError("server closed")
            data += chunk
        length = int(data.split(b":")[0])
        rest = data.split(b":", 1)[1]
        while len(rest) < length:
            chunk = self.f.read(length - len(rest))
            if not chunk:
                raise EOFError("server closed mid-message")
            rest += chunk
        return json.loads(rest.decode())

    def cmd(self, method, params=None):
        self._id += 1
        payload = json.dumps([0, self._id, method, params or {}]).encode()
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._read()
            if isinstance(msg, list) and len(msg) == 4 and msg[1] == self._id:
                if msg[2]:
                    raise RuntimeError(f"{method} -> {msg[2]}: {json.dumps(msg[3])[:800]}")
                return msg[3]

    def async_script(self, script, args=None, timeout=90):
        self.cmd("WebDriver:SetTimeouts", {"script": timeout * 1000})
        reply = self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})
        return reply.get("value")


SPLIT_SCRIPT = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const out = { steps: [] };
  const host = window.__astraHost;
  out.hostKeys = host ? Object.keys(host).sort() : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const attempt = async (name, fn) => {
    try { out[name] = await fn(); out.steps.push(name + ":ok"); }
    catch (e) { out[name] = { error: String(e && e.message || e) }; out.steps.push(name + ":error"); }
  };
  try {
    await host.Tabs.bootstrap({ request_id: "probe-boot" });
    let list = await host.Tabs.list({ request_id: "probe-list" });
    const first = list.tabs[0];
    await host.Navigation.loadURL({ request_id: "probe-a", astra_tab_id: first.astra_tab_id,
      url: "https://en.wikipedia.org/wiki/Firefox" });
    await sleep(4500);
    const made = await host.Tabs.create({ request_id: "probe-b", url: "https://developer.mozilla.org/en-US/" });
    const secondId = made.astra_tab_id;
    await host.Tabs.select({ request_id: "probe-bs", astra_tab_id: secondId });
    await sleep(4500);
    // Back to the first tab: the split's source is the pane in front.
    await host.Tabs.select({ request_id: "probe-as", astra_tab_id: first.astra_tab_id });
    await sleep(600);
    const before = await host.SplitView.state({ request_id: "probe-state0" });
    out.before = before;
    const appFrame = document.querySelector("iframe[data-astra-app-frame]")?.contentWindow;
    out.invokeSeam = typeof appFrame?.__astraInvoke === "function";
    out.routeOpen = appFrame
      ? await appFrame.__astraInvoke("tabs_split", { other: secondId })
      : null;
    out.open = out.routeOpen ?? await host.SplitView.open({ request_id: "probe-open",
      source: first.astra_tab_id, other: secondId, placement: "right" });
    await sleep(1200);
    out.after = await host.SplitView.state({ request_id: "probe-state1" });
    await sleep(700);
    out.uiSplit = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      return f?.contentDocument?.querySelectorAll(".split-group").length ?? 0;
    })();
    out.uiSplitSection = (() => {
      const d = document.querySelector("iframe[data-astra-app-frame]")?.contentDocument;
      return {
        head: d?.querySelectorAll(".split-group-head").length ?? 0,
        members: d?.querySelectorAll(".split-group-members .browse-tab").length ?? 0,
        separator: d?.querySelectorAll(".tab-list-separator").length ?? 0,
      };
    })();
    // Selecting a pane in the sidebar must keep every split browser active.
    await host.Tabs.select({ request_id: "probe-pane-select", astra_tab_id: secondId });
    out.splitActive = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      out.splitActive = (() => {
        const sv = gBrowser.selectedTab.splitview;
        return sv ? sv.tabs.map((t) => t.linkedBrowser.docShellIsActive === true) : [];
      })();
      if (out.splitActive.every(Boolean)) break;
      await sleep(250);
    }
    await host.Tabs.select({ request_id: "probe-pane-back", astra_tab_id: first.astra_tab_id });
    await sleep(300);
    out.native = (() => {
      const sv = gBrowser.selectedTab.splitview;
      if (!sv) return null;
      return {
        panes: sv.tabs.length,
        urls: sv.tabs.map((t) => { try { return t.linkedBrowser.currentURI.spec; } catch (e) { return ""; } }),
        panels: sv.panels.map((p) => p.getBoundingClientRect().width),
      };
    })();
    // A background tab has not loaded its page yet. Splitting it must load it,
    // not show a blank pane.
    const bg = await host.Tabs.create({
      request_id: "probe-bg",
      url: "https://www.iana.org/",
      background: true,
    });
    await sleep(500);
    out.bgSplit = await host.SplitView.open({ request_id: "probe-bg-split", other: bg.astra_tab_id });
    out.bgPaneUrls = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      out.bgPaneUrls = (() => {
        const sv = gBrowser.selectedTab.splitview;
        return sv ? sv.tabs.map((t) => { try { return t.linkedBrowser.currentURI.spec; } catch (e) { return ""; } }) : [];
      })();
      if (out.bgPaneUrls.some((u) => u.includes("iana.org"))) break;
      await sleep(250);
    }
    out.bgLeave = await host.SplitView.leave({ request_id: "probe-bg-leave", id: bg.astra_tab_id });
    out.ratio = await host.SplitView.ratio({ request_id: "probe-ratio", ratio: 0.36 });
    await sleep(300);
    out.widths = (() => {
      const sv = gBrowser.selectedTab.splitview;
      return sv ? sv.panels.map((p) => Math.round(p.getBoundingClientRect().width)) : [];
    })();
    out.peek = appFrame
      ? await appFrame.__astraInvoke("peek_open", { tab_id: first.astra_tab_id, source: "probe" })
      : await host.Peek.open({ request_id: "probe-peek", tab_id: first.astra_tab_id, source: "probe" });
    out.peekList = appFrame
      ? await appFrame.__astraInvoke("peek_list", {})
      : await host.Peek.list({ request_id: "probe-peek-list" });
    await sleep(400);
    out.uiPeek = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      return f?.contentDocument?.querySelectorAll(".peek-window").length ?? 0;
    })();
    out.peekOverlay = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      const card = f?.contentDocument?.querySelector(".peek-window");
      const frame = document.querySelector(".astra-frame");
      if (!f || !card) return null;
      const box = card.getBoundingClientRect();
      const outer = f.getBoundingClientRect();
      const top = document.elementFromPoint(
        outer.left + box.left + box.width / 2,
        outer.top + box.top + box.height / 2,
      );
      let over = false;
      try {
        over = top === f || top?.ownerDocument === f.contentDocument;
      } catch (e) {
        over = false;
      }
      return {
        open: frame?.dataset?.astraPeekOpen ?? null,
        clip: getComputedStyle(f).clipPath,
        over,
      };
    })();
    out.peekClose = appFrame
      ? await appFrame.__astraInvoke("peek_close", { id: out.peek.id })
      : null;
    out.peekAfterClose = appFrame
      ? await appFrame.__astraInvoke("peek_list", {})
      : null;
    out.history = await host.SpaceHistory.status({ request_id: "probe-hist" });
    out.extensions = await host.SpaceExtensions.list({ request_id: "probe-ext" });

    // Replace the right pane with a bookmarked address without closing the
    // tab that was there.
    out.replace = await host.SplitView.replace({ request_id: "probe-replace",
      pane: secondId, url: "https://iana.org/" });
    await sleep(1800);
    out.afterReplace = await host.SplitView.state({ request_id: "probe-state-r" });
    const replacedId = (out.afterReplace.members || []).find((id) => id !== first.astra_tab_id);
    out.saved = await host.SplitView.bookmarkSave({ request_id: "probe-save", name: "Probe split" });
    for (let attempt = 0; attempt < 8 && out.saved?.error; attempt += 1) {
      await sleep(1000);
      out.saved = await host.SplitView.bookmarkSave({ request_id: "probe-save", name: "Probe split" });
    }
    out.arrangements = await host.SplitView.bookmarkList({ request_id: "probe-list2" });
    out.leave = await host.SplitView.leave({ request_id: "probe-leave", id: replacedId });
    out.afterLeave = await host.SplitView.state({ request_id: "probe-state-l" });
    out.afterLeaveTabs = (await host.Tabs.list({ request_id: "probe-list-l" })).tabs.map((t) => t.astra_tab_id);
    await host.SplitView.unsplit({ request_id: "probe-unsplit-l" });

    // Drag-to-edge: a third tab dropped on the left edge becomes a pane.
    const third = await host.Tabs.create({ request_id: "probe-c", url: "https://iana.org/?pane=3" });
    await host.Tabs.select({ request_id: "probe-cs", astra_tab_id: third.astra_tab_id });
    await sleep(1800);
    await host.Tabs.select({ request_id: "probe-fs", astra_tab_id: first.astra_tab_id });
    out.drop = await host.SplitView.drop({ request_id: "probe-drop", id: third.astra_tab_id, x: 4, y: 320 });
    await sleep(600);
    out.afterDrop = await host.SplitView.state({ request_id: "probe-state-d" });
    // A third pane is the product cap; a fourth request must not create one.
    out.thirdPane = await host.SplitView.openUrl({ request_id: "probe-p3",
      url: "https://iana.org/?pane=4", mode: "split", placement: "right" });
    await sleep(3000);
    out.fourthPane = await host.SplitView.openUrl({ request_id: "probe-p4",
      url: "https://iana.org/?pane=5", mode: "split", placement: "right" });
    await sleep(2500);
    out.three = await host.SplitView.state({ request_id: "probe-state-3" });
    out.threeNative = (() => {
      const sv = gBrowser.selectedTab.splitview;
      return sv ? sv.tabs.length : 0;
    })();
    out.resizers = document.querySelectorAll(".astra-pane-resizer").length;
    out.resizerHits = [...document.querySelectorAll(".astra-pane-resizer")].map((r) => {
      const b = r.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        tag: hit?.tagName ?? null,
        cls: typeof hit?.className === "string" ? hit.className : null,
      };
    });
    out.paneDrag = (() => {
      const sv = gBrowser.selectedTab.splitview;
      const handles = document.querySelectorAll(".astra-pane-resizer");
      if (!sv || handles.length < 2) return null;
      const panels = sv.panels;
      const before = panels.map((p) => Math.round(p.getBoundingClientRect().width));
      const handle = handles[1];
      const box = handle.getBoundingClientRect();
      const x = box.left + box.width / 2;
      handle.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: box.top + 20,
      }));
      handle.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, button: 0, clientX: x + 70, clientY: box.top + 20,
      }));
      handle.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 1, button: 0, clientX: x + 70, clientY: box.top + 20,
      }));
      const after = panels.map((p) => Math.round(p.getBoundingClientRect().width));
      return { before, after };
    })();
    out.savedThree = await host.SplitView.bookmarkSave({ request_id: "probe-save4", name: "Probe three" });
    for (let attempt = 0; attempt < 10 && out.savedThree?.error; attempt += 1) {
      await sleep(1200);
      out.savedThree = await host.SplitView.bookmarkSave({ request_id: "probe-save4", name: "Probe three" });
    }
    await host.SplitView.unsplit({ request_id: "probe-unsplit4" });
    out.restored = out.savedThree?.arrangement
      ? await host.SplitView.bookmarkRestore({ request_id: "probe-restore", id: out.savedThree.arrangement.id })
      : null;
    await sleep(900);
    out.restoredState = await host.SplitView.state({ request_id: "probe-state-restored" });
    await host.SplitView.unsplit({ request_id: "probe-unsplit5" });

    // Native group: two ordinary tabs, then the group list and projection.
    await host.Tabs.select({ request_id: "probe-g1", astra_tab_id: first.astra_tab_id });
    out.group = await host.TabGroups.create({ request_id: "probe-group", id: secondId, label: "Probe" });
    out.groups = await host.TabGroups.list({ request_id: "probe-groups" });
    out.groupDom = [...gBrowser.tabContainer.children].map((n) => `${n.tagName}:${n.id || ""}`);
    out.groupFlags = [...gBrowser.tabContainer.children].map((n) => {
      try { return gBrowser.isTabGroup(n) === true; } catch (e) { return String(e); }
    });
    out.groupProjection = (await host.Tabs.list({ request_id: "probe-glist" })).tabs
      .filter((t) => t.group)
      .map((t) => ({ id: t.id, group: t.group.label }));
    await sleep(500);
    out.uiGroup = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      return f?.contentDocument?.querySelectorAll(".tab-group-head").length ?? 0;
    })();

    out.unsplit = await host.SplitView.unsplit({ request_id: "probe-unsplit" });
    out.finalState = await host.SplitView.state({ request_id: "probe-state2" });
    await host.Tabs.createSpace({ request_id: "probe-space", name: "Probe" });
    // The new space is active; the source tab remains in the first space.
    out.clone = await host.SpaceClone.clone({ request_id: "probe-clone",
      tab: first.astra_tab_id, space: "space-1", background: true, include_history: false });
    // History isolation: a visit made now belongs to space 2 only; the
    // Wikipedia visit made at the start belongs to space 1 only.
    const spaceTabs = (await host.Tabs.list({ request_id: "probe-slist" })).tabs;
    const frontNow = spaceTabs.find((t) => t.selected) ?? spaceTabs[spaceTabs.length - 1];
    out.frontNow = frontNow ? { id: frontNow.astra_tab_id, space: frontNow.space_id, url: frontNow.url } : null;
    if (frontNow) {
      out.navReply = await host.Navigation.loadURL({ request_id: "probe-h2", astra_tab_id: frontNow.astra_tab_id,
        url: "https://www.iana.org/help/example-domains" });
      await sleep(6000);
      out.afterNav = await host.Tabs.get({ request_id: "probe-get2", astra_tab_id: frontNow.astra_tab_id });
    }
    out.histSpace1 = await host.SpaceHistory.list({ request_id: "probe-h1", space_id: "space-1", limit: 50 });
    out.histSpace2 = await host.SpaceHistory.list({ request_id: "probe-h2l", space_id: "space-2", limit: 50 });
    out.histStatus2 = await host.SpaceHistory.status({ request_id: "probe-hs2", space_id: "space-2" });
    out.histAll = await host.SpaceHistory.list({ request_id: "probe-hall", space_id: "space-1", limit: 50, show_other: true });
    out.lightTheme = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      return f?.contentDocument?.documentElement?.dataset?.theme ?? null;
    })();
    await host.Settings.set({ request_id: "probe-dark", key: "appearance", value: "dark" });
    await sleep(900);
    out.darkTheme = (() => {
      const f = document.querySelector("iframe[data-astra-app-frame]");
      return f?.contentDocument?.documentElement?.dataset?.theme ?? null;
    })();
    await host.Settings.set({ request_id: "probe-light", key: "appearance", value: "light" });
    out.normalWindowId = (await host.Windows.list({ request_id: "probe-wins" })).focused_window_id;

    // Private window: every new surface must refuse persistence.
    const privateWin = OpenBrowserWindow({ private: true });
    await sleep(9000);
    const pHost = privateWin?.__astraHost ?? null;
    out.privateHost = !!pHost;
    if (pHost) {
      out.privatePeek = await pHost.Peek.open({
        url: "https://en.wikipedia.org/wiki/Private_probe",
        source: "probe",
      });
      out.privateHistory = await pHost.SpaceHistory.note({
        url: "https://private.example/secret",
        space_id: "space-1",
      });
      out.privateAssign = await pHost.SpaceExtensions.assign({
        space_id: "space-1",
        id: "private-probe@example",
        enabled: true,
      });
      out.privateClone = await pHost.SpaceClone.clone({
        tab: (await pHost.Tabs.list({ request_id: "probe-pl" })).tabs[0]?.astra_tab_id,
        space: "space-1",
      });
    }
    let historyPref = "[]";
    let peekPref = "[]";
    try { historyPref = Services.prefs.getStringPref("astra.history.spaces.v1", "[]"); } catch (e) {}
    try { peekPref = Services.prefs.getStringPref("astra.peek.session.v1", "[]"); } catch (e) {}
    out.privateLeakedHistory = historyPref.includes("private.example");
    out.privateLeakedPeek =
      peekPref.includes("Private_probe") || peekPref.includes("private.example");
    if (out.normalWindowId) {
      out.normalPeek = await host.Peek.list({ window_id: out.normalWindowId });
    }
    try { privateWin?.close(); } catch (e) {}
    done(JSON.stringify(out));
  } catch (e) {
    done(JSON.stringify({
      fatal: String(e && e.message || e),
      stack: String(e && e.stack || ""),
      steps: out.steps,
      hostKeys: out.hostKeys,
      partial: out,
    }));
  }
})();
"""


def check(results, name, cond, detail=""):
    ok = bool(cond)
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + detail) if detail else ""), flush=True)
    return ok


def main():
    # The full suite calls a probe with no positional args; unit runs pass an
    # explicit profile and output directory.
    profile = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="astra-native-")
    outdir = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="astra-native-out-")
    os.makedirs(outdir, exist_ok=True)
    subprocess.run(["rm", "-rf", profile], check=True)
    os.makedirs(profile, exist_ok=True)
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.join(os.getcwd(), "engine/obj-astra-linux/dist/bin"),
        stdout=errlog, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid}", flush=True)
    m = None
    for _ in range(90):
        try:
            m = Marionette(PORT)
            break
        except Exception:
            time.sleep(1)
    if m is None:
        print("MARIONETTE-NEVER-CAME-UP", flush=True)
        proc.terminate()
        return 1
    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(18)
        raw = m.async_script(SPLIT_SCRIPT, timeout=120)
        results = json.loads(raw) if isinstance(raw, str) else raw
        with open(os.path.join(outdir, "native-surfaces.json"), "w") as f:
            json.dump(results, f, indent=2)
        print("RESULT " + json.dumps(results)[:4000], flush=True)
        set_theme = r"""
        const done = arguments[arguments.length - 1];
        (async () => {
          try {
            await window.__astraHost.Settings.set({ request_id: "shot", key: "appearance", value: arguments[0] });
            await new Promise((r) => setTimeout(r, 900));
            done("ok");
          } catch (e) { done(String(e)); }
        })();
        """
        for theme in ("light", "dark", "light"):
            try:
                m.async_script(set_theme, [theme], timeout=20)
                shot = m.cmd("WebDriver:TakeScreenshot", {})
                name = "dark.png" if theme == "dark" else "light.png"
                with open(os.path.join(outdir, name), "wb") as f:
                    f.write(base64.b64decode(shot["value"]))
            except Exception as e:
                print(f"screenshot {theme}: {e}", flush=True)
        checks = []
        checks.append(check(results, "app host is reachable", "fatal" not in results, results.get("fatal", "")))
        checks.append(check(results, "the live route table is reachable", results.get("invokeSeam") is True))
        checks.append(check(results, "split opens natively", results.get("open", {}).get("split") is True,
                            json.dumps(results.get("open"))[:300]))
        checks.append(check(results, "native split owns two panes",
                            (results.get("native") or {}).get("panes") == 2,
                            json.dumps(results.get("native"))[:400]))
        checks.append(check(results, "pane content is two real pages",
                            len([u for u in (results.get("native") or {}).get("urls", []) if u.startswith("http")]) == 2,
                            json.dumps((results.get("native") or {}).get("urls"))[:400]))
        widths = results.get("widths") or []
        checks.append(check(results, "divider ratio reached the engine",
                            len(widths) == 2 and widths[0] < widths[1],
                            json.dumps(widths)))
        peek = results.get("peek") or {}
        checks.append(check(results, "a background tab loads when split",
                            any("iana.org" in u for u in (results.get("bgPaneUrls") or [])),
                            json.dumps(results.get("bgPaneUrls"))[:300]))
        checks.append(check(results, "peek captured a real page",
                            isinstance((peek.get("peek") or {}).get("image"), str)
                            and len((peek.get("peek") or {}).get("image") or "") > 2000,
                            str(len((peek.get("peek") or {}).get("image") or ""))))
        checks.append(check(results, "peek is listed", len((results.get("peekList") or {}).get("peeks", [])) >= 1))
        checks.append(check(results, "Astra draws the split group", (results.get("uiSplit") or 0) >= 1,
                            str(results.get("uiSplit"))))
        section = results.get("uiSplitSection") or {}
        checks.append(check(results, "the split is a section with a separator",
                            section.get("head") == 1
                            and (section.get("members") or 0) >= 2
                            and section.get("separator") == 1,
                            json.dumps(section)))
        checks.append(check(results, "all split panes stay active",
                            (results.get("splitActive") or []) == [True, True],
                            json.dumps(results.get("splitActive"))))
        checks.append(check(results, "Astra draws the peek window", (results.get("uiPeek") or 0) >= 1,
                            str(results.get("uiPeek"))))
        checks.append(check(results, "closing the peek frees it",
                            len((results.get("peekAfterClose") or {}).get("peeks", [])) == 0,
                            json.dumps(results.get("peekAfterClose"))[:300]))
        peek_overlay = results.get("peekOverlay") or {}
        checks.append(check(results, "the peek is above the page",
                            peek_overlay.get("over") is True
                            and peek_overlay.get("open") == "true"
                            and "inset(" in (peek_overlay.get("clip") or ""),
                            json.dumps(peek_overlay)[:300]))
        hist = results.get("history") or {}
        checks.append(check(results, "history is space-scoped", hist.get("scope") == "space"))
        h1 = (results.get("histSpace1") or {}).get("visits") or []
        h2 = (results.get("histSpace2") or {}).get("visits") or []
        h1_urls = [v.get("url", "") for v in h1]
        h2_urls = [v.get("url", "") for v in h2]
        checks.append(check(results, "space 1 keeps its own visit",
                            any("wikipedia.org" in u for u in h1_urls),
                            json.dumps(h1_urls)))
        checks.append(check(results, "space 1 does not see space 2's visit",
                            not any("help/example-domains" in u for u in h1_urls),
                            json.dumps(h1_urls)))
        checks.append(check(results, "space 2 keeps its own visit",
                            any("help/example-domains" in u for u in h2_urls),
                            json.dumps(h2_urls)))
        checks.append(check(results, "space 2 does not see space 1's visit",
                            not any("wikipedia.org" in u for u in h2_urls),
                            json.dumps(h2_urls)))
        ext = results.get("extensions") or {}
        checks.append(check(results, "extension assignment reads", ext.get("space_id") == "space-1"))
        clone = results.get("clone") or {}
        checks.append(check(results, "cross-space clone is real",
                            clone.get("cloned") is True and clone.get("space_id") == "space-1",
                            json.dumps(clone)[:300]))
        checks.append(check(results, "leave keeps both tabs open",
                            (results.get("leave") or {}).get("left") is True
                            and len(results.get("afterLeaveTabs") or []) >= 2
                            and (results.get("afterLeave") or {}).get("panes") == 0,
                            json.dumps(results.get("afterLeaveTabs"))[:300]))
        checks.append(check(results, "replace keeps the split at two panes",
                            (results.get("afterReplace") or {}).get("panes") == 2,
                            json.dumps(results.get("afterReplace"))[:300]))
        checks.append(check(results, "drag-to-edge opens a pane",
                            (results.get("drop") or {}).get("accepted") is True
                            and (results.get("afterDrop") or {}).get("panes") == 2,
                            json.dumps(results.get("drop"))[:300]))
        checks.append(check(results, "three native panes are live",
                            (results.get("three") or {}).get("panes") == 3
                            and results.get("threeNative") == 3,
                            json.dumps(results.get("three"))[:300]))
        fourth = results.get("fourthPane") or {}
        drag = results.get("paneDrag") or {}
        checks.append(check(results, "every pane boundary has its own resizer",
                            results.get("resizers") == 2,
                            str(results.get("resizers"))))
        checks.append(check(results, "the second divider resizes its own pair",
                            len(drag.get("after") or []) == 3
                            and (drag.get("after") or [])[1:] != (drag.get("before") or [])[1:],
                            json.dumps(drag)[:300]))
        checks.append(check(results, "a fourth pane is refused",
                            fourth.get("split") is False
                            or fourth.get("error", {}).get("code") == "pane_limit",
                            json.dumps(fourth)[:300]))
        checks.append(check(results, "an arrangement restores all three panes",
                            (results.get("restoredState") or {}).get("panes") == 3,
                            json.dumps(results.get("restoredState"))[:300]))
        checks.append(check(results, "a native group is created and projected",
                            (results.get("group") or {}).get("created") is True
                            and len((results.get("groups") or {}).get("groups", [])) >= 1
                            and len(results.get("groupProjection") or []) >= 2
                            and (results.get("uiGroup") or 0) >= 1,
                            json.dumps(results.get("groupProjection"))[:300]))
        checks.append(check(results, "the split is ended after leave/unsplit",
                            (results.get("finalState") or {}).get("panes") == 0,
                            json.dumps(results.get("finalState"))[:300]))
        checks.append(check(results, "arrangement saves", (results.get("saved") or {}).get("saved") is True))
        checks.append(check(results, "arrangement lists", len((results.get("arrangements") or {}).get("arrangements", [])) >= 1))
        checks.append(check(results, "light theme is applied", results.get("lightTheme") == "light",
                            str(results.get("lightTheme"))))
        checks.append(check(results, "dark theme is applied", results.get("darkTheme") == "dark",
                            str(results.get("darkTheme"))))
        checks.append(check(results, "a private window boots the host", results.get("privateHost") is True))
        checks.append(check(results, "private history is refused",
                            (results.get("privateHistory") or {}).get("error", {}).get("code") == "private_context",
                            json.dumps(results.get("privateHistory"))[:300]))
        checks.append(check(results, "private extension changes are refused",
                            (results.get("privateAssign") or {}).get("error", {}).get("code") == "private_context",
                            json.dumps(results.get("privateAssign"))[:300]))
        checks.append(check(results, "private clones are refused",
                            (results.get("privateClone") or {}).get("error", {}).get("code") == "private_context",
                            json.dumps(results.get("privateClone"))[:300]))
        checks.append(check(results, "private peek is marked private",
                            (results.get("privatePeek") or {}).get("peek", {}).get("private") is True))
        checks.append(check(results, "private history never reaches the pref",
                            results.get("privateLeakedHistory") is False))
        checks.append(check(results, "private peek never reaches the session pref",
                            results.get("privateLeakedPeek") is False))
        checks.append(check(results, "a normal window sees no private peek",
                            not any(
                                (row.get("private") is True)
                                for row in (results.get("normalPeek") or {}).get("peeks", [])
                            )))
        failed = checks.count(False)
        print(f"\nnative surfaces live: {len(checks) - failed}/{len(checks)} passed", flush=True)
        return 0 if failed == 0 else 1
    finally:
        try:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        errlog.close()


if __name__ == "__main__":
    sys.exit(main())
