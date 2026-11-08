#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Extension platform benchmark: startup, install, idle memory/CPU, removal.

Uses the real packages cached by `real_extensions_probe.py`. Every number is
measured from the packaged dev build's process tree; nothing is estimated.

  ASTRA_EXT_BENCH=1 tools/perf/hidden-display.sh \
    python3 tools/perf/stress/extension_bench.py out/extension-bench

Exit 0 PASS, 1 FAIL, 2 SKIP when no cached package/binary is available.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
ENGINE = os.environ.get("ASTRA_ENGINE", os.path.join(ROOT, "engine", "obj-astra-linux"))
BIN = os.environ.get("ASTRA_BINARY", os.path.join(ENGINE, "dist", "bin", "firefox"))
MPORT = int(os.environ.get("ASTRA_EXT_BENCH_MARIONETTE", "2921"))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "extension-bench")
CACHE = os.path.join(ROOT, "out", "real-extensions", "packages")

if os.environ.get("ASTRA_EXT_BENCH") != "1":
    print("SKIP: set ASTRA_EXT_BENCH=1 to run the extension benchmark", file=sys.stderr)
    sys.exit(2)
if not os.path.isfile(BIN):
    print(f"SKIP: no built browser at {BIN}", file=sys.stderr)
    sys.exit(2)

sys.path.insert(0, os.path.join(ROOT, "tests", "contract"))
import load_state as L  # noqa: E402

PACKAGES = [
    ("Dark Reader", "eimadpbcbfnmbkopoojfekhnkhdbieeh.crx"),
    ("Stylus", "clngdbkpkpeebahjckkjfobafhncgmne.crx"),
    ("Tampermonkey", "dhdgffkkebhmkfjojejmpbldmpobfkfo.crx"),
]
paths = [(name, os.path.join(CACHE, filename)) for name, filename in PACKAGES]
if not all(os.path.isfile(path) for _, path in paths):
    print(f"SKIP: run real_extensions_probe.py first; missing packages under {CACHE}", file=sys.stderr)
    sys.exit(2)


def process_memory(pid):
    """Prefer PSS (shared pages counted once) over RSS when the kernel
    provides smaps_rollup; fall back to statm."""
    try:
        with open(f"/proc/{pid}/smaps_rollup", "r") as fh:
            for line in fh:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except Exception:
        pass
    try:
        with open(f"/proc/{pid}/statm", "r") as fh:
            return int(fh.read().split()[1]) * (os.sysconf("SC_PAGE_SIZE") // 1024)
    except Exception:
        return 0


def tree(pid):
    """Return [(pid, memory_kib, ticks)] for pid and all descendants."""
    children = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "r") as fh:
                data = fh.read()
            close = data.rfind(")")
            fields = data[close + 2 :].split()
            ppid = int(fields[1])
            children.setdefault(ppid, []).append(int(entry))
        except Exception:
            continue
    out = []
    stack = [pid]
    while stack:
        current = stack.pop()
        try:
            rss = process_memory(current)
            with open(f"/proc/{current}/stat", "r") as fh:
                data = fh.read()
            close = data.rfind(")")
            fields = data[close + 2 :].split()
            ticks = int(fields[11]) + int(fields[12])
            out.append((current, rss, ticks))
        except Exception:
            pass
        stack.extend(children.get(current, []))
    return out


def sample(pid):
    rows = tree(pid)
    return {
        "pss_kib": sum(row[1] for row in rows),
        "ticks": sum(row[2] for row in rows),
        "processes": len(rows),
    }


GC = r"""
const done = arguments[arguments.length - 1];
(async () => {
  try {
    Cu.forceGC();
    Cu.forceCC();
    Services.obs.notifyObservers(null, "memory-pressure", "heap-minimize");
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 2500));
  done(true);
})()
"""


RUN_INSTALL = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = { timings: {} };
  try {
    let host = null;
    for (let i = 0; i < 160; i += 1) {
      host = Services.astraHost;
      if (host?.WebExtensions) break;
      await wait(250);
    }
    if (!host?.WebExtensions) { done(JSON.stringify({ error: "no Host API" })); return; }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    const items = __PACKAGES__;
    out.installed = [];
    for (const item of items) {
      const start = performance.now();
      const review = await host.WebExtensions.prepareFile({ path: item.path });
      out.timings["inspect_" + item.name] = Math.round((performance.now() - start) * 10) / 10;
      const install = performance.now();
      await host.WebExtensions.confirm({ id: review.id, reviewId: review.review_id });
      let addon = null;
      for (let i = 0; i < 160; i += 1) {
        addon = await AddonManager.getAddonByID(review.id);
        if (addon) break;
        await wait(250);
      }
      out.timings["install_" + item.name] = Math.round((performance.now() - install) * 10) / 10;
      out.installed.push({ name: item.name, id: review.id, version: addon?.version ?? null, ok: addon !== null });
    }
    // Keep the extensions running while the Python side samples.
    out.ready = true;
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ ...out, error: String(error?.stack ?? error) }));
  }
})()
"""

RUN_REMOVE = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const host = Services.astraHost;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const ids = __IDS__;
    const out = { removed: [] };
    for (const id of ids) {
      const start = performance.now();
      await host.WebExtensions.uninstall({ id });
      for (let i = 0; i < 120; i += 1) {
        if ((await AddonManager.getAddonByID(id)) === null) break;
        await wait(250);
      }
      out.removed.push({ id, ms: Math.round((performance.now() - start) * 10) / 10, gone: (await AddonManager.getAddonByID(id)) === null });
    }
    done(JSON.stringify(out));
  } catch (error) {
    done(JSON.stringify({ error: String(error?.stack ?? error) }));
  }
})()
"""


def launch(profile):
    log = open(os.path.join(profile, "browser.log"), "ab")
    proc = subprocess.Popen(
        [BIN, "-profile", profile, "-no-remote", "-remote-allow-system-access", "--marionette", "about:blank"],
        cwd=os.path.dirname(BIN), stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log


def main():
    os.makedirs(OUT, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="astra-ext-bench-")
    with open(os.path.join(profile, "user.js"), "w") as fh:
        fh.write(f'user_pref("marionette.port", {MPORT});\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.startup.page", 0);\n')
    started = time.monotonic()
    proc, log = launch(profile)
    result = {"profile": profile}
    try:
        m = L.Marionette(MPORT, timeout=120)
        m.sock.settimeout(300)
        m.cmd("WebDriver:NewSession", {"capabilities": {}})
        m.cmd("WebDriver:SetTimeouts", {"script": 300000, "implicit": 0, "pageLoad": 120000})
        m.cmd("Marionette:SetContext", {"value": "chrome"})
        for _ in range(160):
            if m.execute("try { return !!Services.astraHost } catch { return false }"):
                break
            time.sleep(0.25)
        result["startup_ms"] = round((time.monotonic() - started) * 1000, 1)
        m.execute_async(GC)
        baseline = sample(proc.pid)
        result["baseline"] = baseline

        packages = [{"name": name, "path": path} for name, path in paths]
        installed = json.loads(m.execute_async(RUN_INSTALL.replace("__PACKAGES__", json.dumps(packages))))
        result["install"] = installed
        if installed.get("error"):
            raise RuntimeError(installed["error"])
        m.execute_async(GC)
        result["after_install"] = sample(proc.pid)

        # Idle CPU over 10 s with every extension installed.
        before = sample(proc.pid)
        time.sleep(10)
        after = sample(proc.pid)
        hz = os.sysconf("SC_CLK_TCK")
        result["idle"] = {
            "seconds": 10,
            "cpu_percent": round(((after["ticks"] - before["ticks"]) / hz) / 10 * 100, 2),
            "pss_kib": after["pss_kib"],
        }

        # Long-run sample: 60 s. Compare the end with the warmed-up start;
        # max-min would count a GC dip as growth.
        samples = [after["pss_kib"]]
        for _ in range(12):
            time.sleep(5)
            samples.append(sample(proc.pid)["pss_kib"])
        result["long_run"] = {
            "seconds": 60,
            "samples_kib": samples,
            "first_kib": samples[0],
            "last_kib": samples[-1],
            "growth_kib": samples[-1] - samples[0],
        }

        # Repeated install/remove cycle on one extension.
        cycle_id = installed["installed"][0]["id"]
        cycle = []
        for _ in range(3):
            before_cycle = sample(proc.pid)["pss_kib"]
            removed = json.loads(m.execute_async(RUN_REMOVE.replace("__IDS__", json.dumps([cycle_id]))))
            m.execute_async(GC)
            after_remove = sample(proc.pid)["pss_kib"]
            review = m.execute_async(
                r"""const done=arguments[arguments.length-1];(async()=>{const r=await Services.astraHost.WebExtensions.prepareFile({path:arguments[0]});await Services.astraHost.WebExtensions.confirm({id:r.id,reviewId:r.review_id});done(JSON.stringify({id:r.id}));})()""",
                [packages[0]["path"]],
            )
            m.execute_async(GC)
            after_reinstall = sample(proc.pid)["pss_kib"]
            cycle.append({
                "before_kib": before_cycle,
                "after_remove_kib": after_remove,
                "after_reinstall_kib": after_reinstall,
                "remove": removed,
                "reinstall": json.loads(review),
            })
        result["cycles"] = cycle

        ids = [row["id"] for row in installed["installed"]]
        result["remove_all"] = json.loads(m.execute_async(RUN_REMOVE.replace("__IDS__", json.dumps(ids))))
        m.execute_async(GC)
        result["after_remove"] = sample(proc.pid)
        result["leak"] = {
            "install_delta_kib": result["after_install"]["pss_kib"] - baseline["pss_kib"],
            "remove_delta_kib": result["after_remove"]["pss_kib"] - baseline["pss_kib"],
            "cycle_growth_kib": cycle[-1]["after_reinstall_kib"] - cycle[0]["after_reinstall_kib"] if cycle else 0,
        }
        result["pass"] = (
            all(row["ok"] for row in installed["installed"])
            and all(row["gone"] for row in result["remove_all"]["removed"])
            and result["long_run"]["growth_kib"] < 48 * 1024
            and result["leak"]["cycle_growth_kib"] < 48 * 1024
        )
    finally:
        try:
            with open(os.path.join(OUT, "result.json"), "w") as fh:
                json.dump(result, fh, indent=2)
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=20)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        log.close()
    print(json.dumps({
        "pass": result.get("pass"),
        "startup_ms": result.get("startup_ms"),
        "baseline_pss_mib": round(result.get("baseline", {}).get("pss_kib", 0) / 1024, 1),
        "after_install_pss_mib": round(result.get("after_install", {}).get("pss_kib", 0) / 1024, 1),
        "after_remove_pss_mib": round(result.get("after_remove", {}).get("pss_kib", 0) / 1024, 1),
        "idle_cpu_percent": result.get("idle", {}).get("cpu_percent"),
        "long_run_growth_mib": round(result.get("long_run", {}).get("growth_kib", 0) / 1024, 1),
        "cycle_growth_mib": round(result.get("leak", {}).get("cycle_growth_kib", 0) / 1024, 1),
        "timings": result.get("install", {}).get("timings"),
    }, indent=2))
    return 0 if result.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())
