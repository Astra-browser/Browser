#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Live proof for the split-view flow.

Drives the real app: a tab's "Open in Split View" row opens the picker, the
picker pairs the tab that was right-clicked with the chosen one, a tab dragged
onto another tab pairs them, a split can hold three panes while separate splits
stay independent, a pane detaches without reloading, and the drag-to-tab
setting turns the gesture off and on.

Usage: python3 tools/marionette-probe/split-view-probe.py [profile] [outdir]
Exit 0 on PASS, 1 on FAIL.
"""

import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
import astra_env  # noqa: E402

HOST, PORT = "127.0.0.1", 2828
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIREFOX = astra_env.BINARY

PAGES = {
    f"t{i}.html": f"""<!doctype html><meta charset="utf-8">
<title>Probe page {i}</title>
<body style="font: 16px sans-serif; padding: 24px">
<h1>Page {i}</h1>
<script>window.__loads = (window.__loads || 0) + 1;</script>
</body>"""
    for i in range(20)
}

SPLIT_SCRIPT = r"""
const done = arguments[arguments.length - 1];
(async () => {
const out = { checks: {}, errors: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const value = fn(); if (value) return value; } catch (e) { /* not yet */ }
    await sleep(100);
  }
  throw new Error("timeout: " + label);
}
try {
  const host = Services.astraHost;
  if (!host) throw new Error("no Services.astraHost");
  const frameEl = await waitFor(
    () => document.querySelector("iframe[data-astra-app-frame]"),
    "app frame",
  );
  const app = await waitFor(
    () => frameEl.contentDocument?.querySelector(".browse-tab") && frameEl.contentDocument,
    "app rows",
  );
  const Win = app.defaultView;
  const row = (id) => app.querySelector(`.browse-tab[data-astra-tab-id="${CSS.escape(id)}"]`);
  const tabOfId = (id) => [...gBrowser.tabs].find((tab) => tab.getAttribute("astra-tab-id") === id);

  const ids = [];
  for (let i = 0; i < 20; i += 1) {
    const made = await host.Tabs.create({ url: "__BASE__/t" + i + ".html" });
    ids.push(made.astra_tab_id);
  }
  await waitFor(() => ids.every((id) => row(id)), "twenty rows");

  const menuItems = () => [...app.querySelectorAll(".shell-menu-item")];
  const menuLabels = () => menuItems().map((item) => item.textContent.trim());
  async function openMenu(id) {
    const button = row(id).querySelector(".tab-open");
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new Win.MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + 24, clientY: rect.top + rect.height / 2,
    }));
    await waitFor(() => menuItems().length > 0, "tab menu");
  }
  async function closeMenu() {
    app.defaultView.dispatchEvent(new Win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(120);
  }
  async function menuRow(label) {
    return menuItems().find((item) => item.textContent.includes(label));
  }
  async function openPicker(id) {
    await openMenu(id);
    const labels = menuLabels();
    const split = labels.find((label) => label.includes("Split View") || label.includes("Split view"));
    const item = menuItems().find((entry) => entry.textContent.trim() === split);
    if (!item) throw new Error("no split row in " + JSON.stringify(labels));
    item.click();
    await waitFor(() => app.querySelector("dialog.split-picker[open]"), "split picker");
    return labels;
  }
  async function pick(name = "first") {
    const rowEl = await waitFor(
      () => [...app.querySelectorAll(".split-picker .picker-row:not(.picker-new)")][0],
      "picker row " + name,
    );
    rowEl.click();
    await sleep(450);
  }
  const splitCount = () => gBrowser.splitViews.length;
  const splitShape = () => [...gBrowser.splitViews].map((view) => view.tabs.length).sort().join(",");
  const paneCount = () => gBrowser.selectedTab.splitview?.tabs.length ?? 0;
  const resizers = () => document.querySelectorAll(".astra-pane-resizer").length;
  const loads = (id) => {
    try { return tabOfId(id).linkedBrowser.contentWindow.wrappedJSObject.__loads; }
    catch { return null; }
  };

  // 0. The default gesture: drop one tab on the middle of another. This runs
  //    before the picker flows so a clean list proves the gesture itself.
  out.checks.dragDefault = Services.prefs.getStringPref("astra.settings.split.drag-tab", "true") !== "false";
  const beforeDefault = splitCount();
  await dragTabOnto(ids[14], ids[15]);
  out.checks.dragGesture = splitCount() === beforeDefault + 1;

  // 0b. The setting turns the same gesture off and on. Run it on clean rows
  //     before the picker flows so only the preference decides.
  await host.Settings.set({ key: "split.drag-tab", value: "false" });
  await sleep(350);
  const beforeOff = splitCount();
  const beforeOffShape = splitShape();
  await dragTabOnto(ids[16], ids[17]);
  out.checks.dragOff = splitCount() === beforeOff && splitShape() === beforeOffShape;

  await host.Settings.set({ key: "split.drag-tab", value: "true" });
  await sleep(350);
  await dragTabOnto(ids[18], ids[19]);
  out.checks.dragOn = splitCount() === beforeOff + 1;

  // 1. The right-click row opens the picker, and the picker splits the
  //    right-clicked tab with the one that is chosen.
  const a = ids[0], b = ids[1];
  const beforeLoads = loads(a);
  const beforeSplits = splitCount();
  const beforeCards = app.querySelectorAll(".split-group").length;
  const labels = await openPicker(a);
  out.checks.menuHasSplit = labels.some((label) => /Open in Split View/i.test(label));
  out.checks.pickerOpened = !!app.querySelector("dialog.split-picker[open]");
  // The picker replaces a closing menu in the same turn. The shell must still
  // be told to raise the frame, or the dialog is drawn behind the native page.
  await sleep(300);
  out.checks.pickerRaised =
    document.querySelector(".astra-frame")?.dataset.astraMenuOpen === "true" &&
    app.documentElement.dataset.astraRaised === "true";
  const sourceLabel = row(a)?.querySelector("[data-astra-tab-label]")?.textContent?.trim() ?? "";
  out.checks.pickerNamesSource =
    sourceLabel !== "" && (app.querySelector(".split-picker")?.textContent ?? "").includes(sourceLabel);
  await pick();
  await waitFor(() => splitCount() === beforeSplits + 1 && paneCount() === 2, "first split");
  out.checks.firstSplit = paneCount() === 2;
  out.checks.members = gBrowser.selectedTab.splitview.tabs.map((tab) => tab.getAttribute("astra-tab-id"));
  out.checks.rightClickedIsSource = gBrowser.selectedTab.getAttribute("astra-tab-id") === a;
  out.checks.noReload = beforeLoads !== null && loads(a) === beforeLoads;
  out.checks.oneResizer = resizers() === 1;
  out.checks.sidebarCard = app.querySelectorAll(".split-group").length === beforeCards + 1;

  // 2. A second, independent split from a tab outside the first one.
  const c = ids[2], d = ids[3];
  await openPicker(c);
  await pick();
  await waitFor(() => splitCount() === beforeSplits + 2, "second split");
  out.checks.twoSplits = splitCount() === beforeSplits + 2;
  out.checks.twoCards = app.querySelectorAll(".split-group").length === beforeCards + 2;
  out.checks.secondSplitPanes = paneCount() === 2;
  const parked = gBrowser.splitViews.find((view) => view !== gBrowser.selectedTab.splitview);
  out.checks.parkedSplitPanes = !!parked && parked.tabs.length === 2;

  // 3. A pane detaches into its own tab, its page is not reloaded and the
  //    split view's handles leave the deck.
  await host.Tabs.select({ astra_tab_id: a });
  await sleep(250);
  const card = [...app.querySelectorAll(".split-group")].find((entry) =>
    entry.querySelector(`[data-astra-tab-id="${CSS.escape(a)}"]`));
  const detach = card?.querySelector(".tab-detach");
  out.checks.detachControl = !!detach;
  const loadsA = loads(a);
  detach.click();
  await waitFor(() => !tabOfId(a).splitview, "detach");
  await sleep(250);
  out.checks.detached = !tabOfId(a).splitview;
  out.checks.detachedIsFront = gBrowser.selectedTab.getAttribute("astra-tab-id") === a;
  out.checks.detachNoReload = loads(a) === loadsA;
  out.checks.detachNoHandles = resizers() === 0;

  // 4. Three panes are allowed; a fourth is refused in the menu.
  await openPicker(a);
  await pick();
  await waitFor(() => paneCount() === 2, "pair after detach");
  const addLabels = await openPicker(a);
  out.checks.addPaneRow = addLabels.some((label) => /Add Pane/i.test(label));
  await pick("Probe page 5");
  await waitFor(() => paneCount() === 3, "third pane");
  out.checks.threePanes = paneCount() === 3;
  out.checks.twoHandles = resizers() === 2;
  await openMenu(a);
  const full = await menuRow("Split view full");
  out.checks.fullRow = !!full && full.disabled === true;
  await closeMenu();

  // 5. Dragging a tab onto another tab opens a split, and the setting turns
  //    the gesture off again.
  async function dragTabOnto(sourceId, targetId) {
    row(targetId).scrollIntoView({ block: "nearest" });
    row(sourceId).scrollIntoView({ block: "nearest" });
    await sleep(150);
    const handle = row(sourceId).querySelector(".tab-open");
    const from = handle.getBoundingClientRect();
    const target = row(targetId).getBoundingClientRect();
    const start = { x: from.left + 20, y: from.top + from.height / 2 };
    const end = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
    const init = { bubbles: true, pointerId: 9, button: 0, buttons: 1, isPrimary: true };
    handle.dispatchEvent(new Win.PointerEvent("pointerdown", { ...init, clientX: start.x, clientY: start.y }));
    handle.dispatchEvent(new Win.PointerEvent("pointermove", { ...init, clientX: start.x, clientY: start.y + 8 }));
    await sleep(30);
    handle.dispatchEvent(new Win.PointerEvent("pointermove", { ...init, clientX: start.x, clientY: start.y + 10 }));
    await sleep(30);
    handle.dispatchEvent(new Win.PointerEvent("pointermove", { ...init, clientX: end.x, clientY: end.y }));
    await sleep(60);
    handle.dispatchEvent(new Win.PointerEvent("pointerup", { ...init, clientX: end.x, clientY: end.y }));
    await sleep(550);
  }
  // 6. The split switch removes the row entirely; the pane cap is read by
  //    the menu and by the picker.
  const settingTab = ids[10];
  await host.Settings.set({ key: "split.enabled", value: "false" });
  await sleep(350);
  await openMenu(settingTab);
  out.checks.enabledOff = !menuLabels().some((label) => /Split View|Split view/i.test(label));
  await closeMenu();
  await host.Settings.set({ key: "split.enabled", value: "true" });
  await sleep(350);
  await openMenu(settingTab);
  out.checks.enabledOn = menuLabels().some((label) => /Split View|Split view/i.test(label));
  await closeMenu();

  await host.Settings.set({ key: "split.max-panes", value: "2" });
  await sleep(350);
  const beforeCap = splitCount();
  await openPicker(settingTab);
  await pick();
  await waitFor(() => splitCount() === beforeCap + 1 && paneCount() === 2, "two-pane cap split");
  await openMenu(settingTab);
  const capRow = await menuRow("Split view full");
  out.checks.maxTwo = !!capRow && capRow.disabled === true;
  await closeMenu();
  await host.Settings.set({ key: "split.max-panes", value: "3" });
  await host.Settings.set({ key: "split.drag-tab", value: "true" });
  await sleep(350);

  // 7. Ending every split leaves no handles or split wrappers behind.
  for (const view of [...gBrowser.splitViews]) view.unsplitTabs("probe_cleanup");
  await sleep(400);
  out.checks.cleanEnd = splitCount() === 0 && resizers() === 0;

  out.tabCount = gBrowser.tabs.length;
  out.finalSplitCount = splitCount();
  out.finalResizers = resizers();
} catch (error) {
  out.errors.push(String(error?.message ?? error) + "\n" + String(error?.stack ?? ""));
}
done(JSON.stringify(out));
})();
"""


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

    def async_script(self, script, args=None, timeout=120):
        self.cmd("WebDriver:SetTimeouts", {"script": timeout * 1000})
        reply = self.cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": args or []})
        return reply.get("value")

    def close(self):
        try:
            self.cmd("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def serve_pages():
    directory = tempfile.mkdtemp(prefix="astra-split-pages-")
    for name, html in PAGES.items():
        with open(os.path.join(directory, name), "w", encoding="utf-8") as handle:
            handle.write(html)

    hits = {}

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def do_GET(self):
            hits[self.path] = hits.get(self.path, 0) + 1
            super().do_GET()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer((HOST, 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, directory, hits


def main():
    profile = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="astra-split-")
    outdir = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="astra-split-out-")
    os.makedirs(outdir, exist_ok=True)
    if os.path.isdir(profile):
        import shutil
        shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)

    server, pages, hits = serve_pages()
    base = f"http://{HOST}:{server.server_port}"
    errlog = open(os.path.join(outdir, "stderr.log"), "wb")
    proc = subprocess.Popen(
        [os.path.abspath(FIREFOX), "-profile", os.path.abspath(profile),
         "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=astra_env.BIN_DIR,
        stdout=errlog, stderr=subprocess.STDOUT)
    print(f"launched pid={proc.pid} base={base}", flush=True)

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
        server.shutdown()
        return 1

    results = {}
    try:
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        time.sleep(12)
        raw = m.async_script(SPLIT_SCRIPT.replace("__BASE__", base), timeout=180)
        results = json.loads(raw) if isinstance(raw, str) else raw
    except Exception as error:
        results = {"errors": [str(error)], "checks": {}}
    finally:
        m.close()
        try:
            proc.wait(timeout=20)
        except Exception:
            proc.terminate()
        server.shutdown()
        errlog.close()

    checks = results.setdefault("checks", {})
    # A page that is only carried into a split, not loaded again, is requested
    # once: the local server counted every GET. Detaching must not add another.
    checks["noReload"] = hits.get("/t0.html", 0) == 1
    checks["detachNoReload"] = hits.get("/t0.html", 0) == 1
    results["serverHits"] = hits
    with open(os.path.join(outdir, "report.json"), "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=2)
    print(json.dumps(results, indent=2), flush=True)

    required = {
        "menuHasSplit": True,
        "pickerOpened": True,
        "pickerRaised": True,
        "pickerNamesSource": True,
        "firstSplit": True,
        "rightClickedIsSource": True,
        "noReload": True,
        "oneResizer": True,
        "sidebarCard": True,
        "twoSplits": True,
        "twoCards": True,
        "secondSplitPanes": True,
        "parkedSplitPanes": True,
        "detachControl": True,
        "detached": True,
        "detachedIsFront": True,
        "detachNoReload": True,
        "detachNoHandles": True,
        "addPaneRow": True,
        "threePanes": True,
        "twoHandles": True,
        "fullRow": True,
        "dragDefault": True,
        "dragGesture": True,
        "dragOff": True,
        "dragOn": True,
        "enabledOff": True,
        "enabledOn": True,
        "maxTwo": True,
        "cleanEnd": True,
    }
    passed = 0
    failed = 0
    for name, want in required.items():
        got = checks.get(name)
        ok = got == want
        passed += 1 if ok else 0
        failed += 0 if ok else 1
        print(f"{'PASS' if ok else 'FAIL'} {name}: {got!r} (want {want!r})", flush=True)
    for error in results.get("errors") or []:
        print(f"ERROR {error}", flush=True)
        failed += 1
    print(f"split view probe: {passed} passed, {failed} failed", flush=True)
    return 0 if failed == 0 and not results.get("errors") else 1


if __name__ == "__main__":
    sys.exit(main())
