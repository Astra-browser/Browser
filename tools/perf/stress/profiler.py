#!/usr/bin/env python3
"""Process / system sampler for the Astra stress matrix.

One sample captures, in the same instant:
  * CPU per process and for the whole machine (/proc/stat, /proc/<pid>/stat)
  * PSS / private / swap memory per process (smaps_rollup), machine memory
  * GPU engine time per process from DRM fdinfo (render / video / copy) and
    GPU memory per DRM client
  * iGPU busy% from the i915 rc6 residency counter, dGPU from nvidia-smi
  * CPU frequency, package temperature, load average, swap IO, major faults
  * per-process disk IO, thread and fd counts

The browser process tree is discovered from the launched root PID, so an
already-running Firefox owned by somebody else is never counted.

Stdlib only. Writes samples.jsonl + summary.json + meta.json.
"""
import json
import os
import re
import statistics
import subprocess
import threading
import time

CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024

KIND_ORDER = [
    "browser", "content", "gpu", "rdd", "socket", "utility",
    "forkserver", "webextension", "crashhelper", "other",
]


def _read(path, default=None):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except Exception:
        return default


def _int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def list_pids():
    return [int(p) for p in os.listdir("/proc") if p.isdigit()]


def proc_stat(pid):
    raw = _read(f"/proc/{pid}/stat")
    if not raw:
        return None
    try:
        rest = raw.rsplit(")", 1)[1].split()
    except IndexError:
        return None
    if len(rest) < 20:
        return None
    return {
        "state": rest[0],
        "ppid": _int(rest[1]),
        "utime": _int(rest[11]),
        "stime": _int(rest[12]),
        "threads": _int(rest[17]),
        "starttime": _int(rest[19]),
    }


def proc_cmdline(pid):
    raw = _read(f"/proc/{pid}/cmdline", "")
    if not raw:
        return []
    return [p for p in raw.split("\0") if p]


def proc_comm(pid):
    return (_read(f"/proc/{pid}/comm", "") or "").strip()


def proc_smaps(pid):
    raw = _read(f"/proc/{pid}/smaps_rollup")
    out = {"pss_kb": 0, "private_kb": 0, "swap_kb": 0, "anon_kb": 0, "file_kb": 0}
    if not raw:
        raw = _read(f"/proc/{pid}/smaps")
        if not raw:
            return None
    for line in raw.splitlines():
        if line.startswith("Pss:"):
            out["pss_kb"] += _int(line.split()[1])
        elif line.startswith("Pss_Anon:"):
            out["anon_kb"] += _int(line.split()[1])
        elif line.startswith("Pss_File:"):
            out["file_kb"] += _int(line.split()[1])
        elif line.startswith("Private_Clean:") or line.startswith("Private_Dirty:"):
            out["private_kb"] += _int(line.split()[1])
        elif line.startswith("Swap:"):
            out["swap_kb"] += _int(line.split()[1])
    if out["pss_kb"] == 0:
        status = _read(f"/proc/{pid}/status", "")
        m = re.search(r"^VmRSS:\s+(\d+)", status, re.M)
        out["pss_kb"] = _int(m.group(1)) if m else 0
    return out


def proc_hwm(pid):
    status = _read(f"/proc/{pid}/status", "")
    m = re.search(r"^VmHWM:\s+(\d+)", status, re.M)
    return _int(m.group(1)) if m else 0


def proc_io(pid):
    raw = _read(f"/proc/{pid}/io")
    out = {"read_bytes": 0, "write_bytes": 0}
    if not raw:
        return out
    for line in raw.splitlines():
        if line.startswith("read_bytes:"):
            out["read_bytes"] = _int(line.split()[1])
        elif line.startswith("write_bytes:"):
            out["write_bytes"] = _int(line.split()[1])
    return out


def proc_fdcount(pid):
    try:
        return len(os.listdir(f"/proc/{pid}/fd"))
    except Exception:
        return 0


_DRM_RE = re.compile(r"^drm-([a-z0-9\-]+):\s*(.*)$", re.M)


def proc_gpu(pid):
    """Cumulative DRM engine ns + GPU memory, de-duplicated by client id."""
    clients = {}
    try:
        fds = os.listdir(f"/proc/{pid}/fdinfo")
    except Exception:
        return {}
    for fd in fds:
        raw = _read(f"/proc/{pid}/fdinfo/{fd}")
        if not raw or "drm-engine-render" not in raw:
            continue
        fields = dict(_DRM_RE.findall(raw))
        cid = fields.get("client-id")
        if cid is None:
            continue
        entry = clients.setdefault(cid, {
            "pdev": fields.get("pdev", "?"),
            "render": 0, "copy": 0, "video": 0, "video_enhance": 0,
            "gpu_kb": 0,
        })
        dev = fields.get("pdev", "?")
        # Keep the highest cumulative value seen for this client (all fds of
        # one DRM client report the same counters).
        for eng in ("render", "copy", "video", "video-enhance"):
            key = "video_enhance" if eng == "video-enhance" else eng
            val = _int(fields.get(f"engine-{eng}", "0").split()[0])
            if val > entry[key]:
                entry[key] = val
        mem = 0
        for name, val in fields.items():
            if name.startswith("total-system"):
                try:
                    mem += int(val.split()[0])
                except Exception:
                    pass
        if mem > entry["gpu_kb"]:
            entry["gpu_kb"] = mem
        entry["pdev"] = dev
    return clients


def find_intel_card():
    base = "/sys/class/drm"
    try:
        names = sorted(os.listdir(base))
    except Exception:
        return None
    for name in names:
        if not re.fullmatch(r"card\d+", name):
            continue
        dev = os.path.join(base, name, "device")
        try:
            driver = os.path.basename(os.readlink(os.path.join(dev, "driver")))
        except Exception:
            continue
        if driver != "i915":
            continue
        rc6 = None
        for root, _dirs, files in os.walk(os.path.join(base, name, "gt")):
            if "rc6_residency_ms" in files:
                rc6 = os.path.join(root, "rc6_residency_ms")
                break
        freq = None
        for root, _dirs, files in os.walk(os.path.join(base, name, "gt")):
            for f in ("act_freq_mhz", "cur_freq_mhz"):
                if f in files:
                    freq = os.path.join(root, f)
                    break
            if freq:
                break
        return {"name": name, "rc6": rc6, "freq": freq}
    return None


def cpu_freqs():
    vals = []
    base = "/sys/devices/system/cpu"
    try:
        cpus = [d for d in os.listdir(base) if re.fullmatch(r"cpu\d+", d)]
    except Exception:
        return None
    for c in cpus:
        p = os.path.join(base, c, "cpufreq", "scaling_cur_freq")
        v = _read(p)
        if v:
            vals.append(_int(v.strip()) / 1000.0)
    if not vals:
        return None
    return {"avg_mhz": round(sum(vals) / len(vals), 1), "max_mhz": round(max(vals), 1)}


def temperatures():
    base = "/sys/class/thermal"
    best = None
    try:
        zones = [z for z in os.listdir(base) if z.startswith("thermal_zone")]
    except Exception:
        return None
    for z in zones:
        raw = _read(os.path.join(base, z, "temp"))
        typ = (_read(os.path.join(base, z, "type"), "") or "").strip()
        if not raw:
            continue
        try:
            c = int(raw.strip()) / 1000.0
        except Exception:
            continue
        if best is None or c > best["c"]:
            best = {"c": round(c, 1), "zone": typ}
    return best


def system_cpu():
    raw = _read("/proc/stat", "")
    for line in raw.splitlines():
        if line.startswith("cpu "):
            parts = [int(x) for x in line.split()[1:]]
            while len(parts) < 8:
                parts.append(0)
            user, nice, system, idle, iowait, irq, softirq, steal = parts[:8]
            total = sum(parts[:8])
            return {
                "total": total,
                "busy": total - idle - iowait,
                "user": user + nice,
                "system": system + irq + softirq,
                "iowait": iowait,
                "idle": idle,
            }
    return None


def system_mem():
    raw = _read("/proc/meminfo", "")
    out = {}
    for line in raw.splitlines():
        key, _, rest = line.partition(":")
        if not rest:
            continue
        out[key] = _int(rest.strip().split()[0])
    return out


def system_vmstat():
    raw = _read("/proc/vmstat", "")
    out = {}
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) == 2:
            out[parts[0]] = _int(parts[1])
    return out


def loadavg():
    raw = _read("/proc/loadavg", "")
    return [float(x) for x in raw.split()[:3]] if raw else None


def nvidia_snapshot():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,"
             "temperature.gpu,power.draw,clocks.sm,clocks.mem",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode != 0:
            return None
        rows = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 7:
                continue
            def num(v):
                try:
                    return float(v)
                except Exception:
                    return None
            rows.append({
                "util_pct": num(parts[0]),
                "mem_used_mb": num(parts[1]),
                "mem_total_mb": num(parts[2]),
                "temp_c": num(parts[3]),
                "power_w": num(parts[4]),
                "clock_sm_mhz": num(parts[5]),
                "clock_mem_mhz": num(parts[6]),
            })
        return rows
    except Exception:
        return None


def nvidia_procs():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode != 0:
            return []
        rows = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                rows.append({"pid": _int(parts[0]), "name": parts[1], "mem_mb": _int(parts[2])})
        return rows
    except Exception:
        return []


def classify(root_pid, pid, cmd, comm):
    if pid == root_pid:
        return "browser"
    low = " ".join(cmd)
    if "crashhelper" in low or comm == "crashhelper":
        return "crashhelper"
    # Firefox gives its dedicated child processes a stable comm; trust that
    # before the generic `tab` token, which WebExtensions and GPU children
    # also carry in older builds.
    comm_kind = {
        "WebExtensions": "webextension",
        "RDD Process": "rdd",
        "Socket Process": "socket",
        "GPU Process": "gpu",
        "Utility Process": "utility",
    }.get(comm)
    if comm_kind:
        return comm_kind
    if "-contentproc" in cmd or "-contentproc" in low:
        last = cmd[-1] if cmd else ""
        mapping = {
            "tab": "content", "gpu": "gpu", "rdd": "rdd", "socket": "socket",
            "utility": "utility", "forkserver": "forkserver",
            "webExtension": "webextension", "pdfium": "pdfium", "audio": "audio",
        }
        if last in mapping:
            return mapping[last]
        for token in ("gpu", "rdd", "socket", "utility", "forkserver"):
            if re.search(rf"\b{token}\b", low):
                return token
        return "content"
    if comm in ("Isolated Web Co", "Web Content", "Privileged Cont"):
        return "content"
    if comm == "WebExtensions":
        return "webextension"
    if comm in ("RDD Process",):
        return "rdd"
    if comm in ("Socket Process",):
        return "socket"
    return "other"


def pct(values):
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    vals = sorted(vals)
    def at(q):
        if len(vals) == 1:
            return vals[0]
        idx = min(len(vals) - 1, max(0, int(round(q * (len(vals) - 1)))))
        return vals[idx]
    return {
        "mean": round(statistics.fmean(vals), 2),
        "p50": round(at(0.5), 2),
        "p95": round(at(0.95), 2),
        "max": round(vals[-1], 2),
        "min": round(vals[0], 2),
        "n": len(vals),
    }


def descendants(root):
    stats = {}
    for pid in list_pids():
        st = proc_stat(pid)
        if st:
            stats[pid] = st
    out = {root}
    changed = True
    while changed:
        changed = False
        for pid, st in stats.items():
            if pid in out:
                continue
            if st["ppid"] in out:
                out.add(pid)
                changed = True
    return out


class Sampler(threading.Thread):
    def __init__(self, root_pid, outdir, interval=0.5, label=""):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.outdir = outdir
        self.interval = interval
        self.label = label
        self.stop_event = threading.Event()
        self.marks = []
        self.prev_cpu = {}
        self.prev_gpu = {}
        self.prev_io = {}
        self.prev_sys = None
        self.prev_rc6 = None
        self.prev_ts = None
        self.samples = []
        self.hwm = {}
        self.intel = find_intel_card()
        self._nvidia_tick = 0
        self._nvidia = None
        self._nvidia_procs = []

    def mark(self, name):
        self.marks.append({"name": name, "mono": time.monotonic(), "t": time.time()})

    def phase(self):
        return self.marks[-1]["name"] if self.marks else "init"

    def _rc6(self):
        if not self.intel or not self.intel["rc6"]:
            return None
        return _int(_read(self.intel["rc6"], "0").strip())

    def _igpu_freq(self):
        if not self.intel or not self.intel["freq"]:
            return None
        raw = _read(self.intel["freq"])
        return _int(raw.strip()) if raw else None

    def sample(self):
        now = time.monotonic()
        syscpu = system_cpu()
        mem = system_mem()
        vm = system_vmstat()
        pids = descendants(self.root_pid)
        rc6 = self._rc6()

        self._nvidia_tick += 1
        if self._nvidia_tick % 4 == 1:
            self._nvidia = nvidia_snapshot()
            self._nvidia_procs = nvidia_procs()

        dt = (now - self.prev_ts) if self.prev_ts else None
        sys_delta = None
        if self.prev_sys and syscpu:
            dtotal = syscpu["total"] - self.prev_sys["total"]
            if dtotal > 0:
                def share(key):
                    return round(100.0 * (syscpu[key] - self.prev_sys[key]) / dtotal, 2)
                sys_delta = {
                    "busy_pct": share("busy"),
                    "user_pct": share("user"),
                    "system_pct": share("system"),
                    "iowait_pct": share("iowait"),
                }
        igpu_busy = None
        if rc6 is not None and self.prev_rc6 is not None and dt and dt > 0:
            drc6 = rc6 - self.prev_rc6
            igpu_busy = round(max(0.0, min(100.0, 100.0 * (1.0 - drc6 / (dt * 1000.0)))), 1)

        procs = {}
        for pid in pids:
            st = proc_stat(pid)
            if not st:
                continue
            cmd = proc_cmdline(pid)
            comm = proc_comm(pid)
            kind = classify(self.root_pid, pid, cmd, comm)
            sm = proc_smaps(pid) or {"pss_kb": 0, "private_kb": 0, "swap_kb": 0, "anon_kb": 0, "file_kb": 0}
            io = proc_io(pid)
            prov = self.prev_io.get(pid)
            cpu_pct = None
            p = self.prev_cpu.get(pid)
            if p and dt and dt > 0:
                ticks = (st["utime"] + st["stime"]) - (p["utime"] + p["stime"])
                cpu_pct = round(100.0 * ticks / CLK_TCK / dt, 2)
            gpu = proc_gpu(pid)
            prev_g = self.prev_gpu.get(pid, {})
            gpu_render = gpu_video = gpu_copy = 0.0
            gpu_mem_kb = 0
            for cid, entry in gpu.items():
                gpu_mem_kb += entry["gpu_kb"]
                old = prev_g.get(cid)
                if old and dt and dt > 0:
                    for eng, key in (("render", "gpu_render"), ("video", "gpu_video"), ("copy", "gpu_copy")):
                        delta = entry[eng] - old.get(eng, 0)
                        if delta > 0:
                            val = delta / (dt * 1e9) * 100.0
                            if key == "gpu_render":
                                gpu_render += val
                            elif key == "gpu_video":
                                gpu_video += val
                            else:
                                gpu_copy += val
            dgpu_mem = 0
            gpu_procs = {p["pid"]: p for p in self._nvidia_procs} if self._nvidia_procs else {}
            if pid in gpu_procs:
                dgpu_mem = gpu_procs[pid]["mem_mb"]
            procs[pid] = {
                "pid": pid,
                "ppid": st["ppid"],
                "kind": kind,
                "comm": comm,
                "cmd_tail": " ".join(cmd[-3:]) if cmd else "",
                "cpu_pct_core": cpu_pct,
                "pss_mb": round(sm["pss_kb"] / 1024.0, 1),
                "private_mb": round(sm["private_kb"] / 1024.0, 1),
                "anon_mb": round(sm["anon_kb"] / 1024.0, 1),
                "swap_mb": round(sm["swap_kb"] / 1024.0, 1),
                "threads": st["threads"],
                "fds": proc_fdcount(pid),
                "gpu_render_pct": round(gpu_render, 2),
                "gpu_video_pct": round(gpu_video, 2),
                "gpu_copy_pct": round(gpu_copy, 2),
                "gpu_mem_mb": round(gpu_mem_kb / 1024.0, 1),
                "dgpu_mem_mb": dgpu_mem,
                "io_read_kb": round(io["read_bytes"] / 1024.0, 1),
                "io_write_kb": round(io["write_bytes"] / 1024.0, 1),
            }
            self.prev_cpu[pid] = st
            self.prev_gpu[pid] = gpu
            self.prev_io[pid] = io
            if sm["pss_kb"] > self.hwm.get(pid, 0):
                self.hwm[pid] = sm["pss_kb"]

        self.prev_sys = syscpu
        self.prev_rc6 = rc6
        self.prev_ts = now

        # roll-ups
        by_kind = {}
        for p in procs.values():
            k = p["kind"]
            agg = by_kind.setdefault(k, {
                "procs": 0, "cpu_pct_core": 0.0, "pss_mb": 0.0, "private_mb": 0.0,
                "swap_mb": 0.0, "gpu_render_pct": 0.0, "gpu_video_pct": 0.0,
                "gpu_mem_mb": 0.0, "threads": 0, "fds": 0,
            })
            agg["procs"] += 1
            for key in ("cpu_pct_core", "pss_mb", "private_mb", "swap_mb",
                        "gpu_render_pct", "gpu_video_pct", "gpu_mem_mb", "threads", "fds"):
                if p[key] is not None:
                    agg[key] += p[key]
        for agg in by_kind.values():
            for key in list(agg):
                if isinstance(agg[key], float):
                    agg[key] = round(agg[key], 2)

        total = {
            "procs": len(procs),
            "threads": sum(p["threads"] for p in procs.values()),
            "pss_mb": round(sum(p["pss_mb"] for p in procs.values()), 1),
            "private_mb": round(sum(p["private_mb"] for p in procs.values()), 1),
            "swap_mb": round(sum(p["swap_mb"] for p in procs.values()), 1),
            "cpu_pct_core": round(sum(p["cpu_pct_core"] or 0 for p in procs.values()), 2),
            # cpu_pct_core is "percent of one hardware thread"; dividing by the
            # thread count turns it into "percent of the whole machine".
            "cpu_pct_system": round(sum(p["cpu_pct_core"] or 0 for p in procs.values()) / (os.cpu_count() or 1), 2),
            "gpu_render_pct": round(sum(p["gpu_render_pct"] for p in procs.values()), 2),
            "gpu_video_pct": round(sum(p["gpu_video_pct"] for p in procs.values()), 2),
            "gpu_mem_mb": round(sum(p["gpu_mem_mb"] for p in procs.values()), 1),
        }

        sysout = {
            "cpu": sys_delta,
            "load": loadavg(),
            "mem_total_mb": round(mem.get("MemTotal", 0) / 1024.0, 1),
            "mem_available_mb": round(mem.get("MemAvailable", 0) / 1024.0, 1),
            "mem_free_mb": round(mem.get("MemFree", 0) / 1024.0, 1),
            "swap_total_mb": round(mem.get("SwapTotal", 0) / 1024.0, 1),
            "swap_free_mb": round(mem.get("SwapFree", 0) / 1024.0, 1),
            "swap_used_mb": round((mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)) / 1024.0, 1),
            "dirty_mb": round(mem.get("Dirty", 0) / 1024.0, 1),
            "shmem_mb": round(mem.get("Shmem", 0) / 1024.0, 1),
            "pgmajfault": vm.get("pgmajfault"),
            "pswpin": vm.get("pswpin"),
            "pswpout": vm.get("pswpout"),
            "igpu_busy_pct": igpu_busy,
            "igpu_freq_mhz": self._igpu_freq(),
            "cpu_freq": cpu_freqs(),
            "temp": temperatures(),
            "dgpu": self._nvidia[0] if self._nvidia else None,
        }
        return {
            "t": round(now - (self.marks[0]["mono"] if self.marks else now), 3),
            "wall": round(time.time(), 3),
            "phase": self.phase(),
            "system": sysout,
            "browser": total,
            "by_kind": by_kind,
            "procs": procs,
        }

    def run(self):
        # First sample establishes deltas.
        while not self.stop_event.is_set():
            try:
                s = self.sample()
                self.samples.append(s)
            except Exception as exc:
                self.samples.append({"error": f"{type(exc).__name__}: {exc}", "phase": self.phase()})
            self.stop_event.wait(self.interval)

    def stop(self):
        self.stop_event.set()
        self.join(timeout=5)

    def thread_profile(self, seconds=1.2):
        """Per-thread CPU over a short extra window (top consumers)."""
        def snap():
            out = {}
            for pid in descendants(self.root_pid):
                for name in _safe_listdir(f"/proc/{pid}/task"):
                    tid = _int(name)
                    if not tid:
                        continue
                    raw = _read(f"/proc/{pid}/task/{tid}/stat")
                    if not raw:
                        continue
                    try:
                        rest = raw.rsplit(")", 1)[1].split()
                    except IndexError:
                        continue
                    if len(rest) < 13:
                        continue
                    out[(pid, tid)] = {
                        "ticks": _int(rest[11]) + _int(rest[12]),
                        "comm": (_read(f"/proc/{pid}/task/{tid}/comm", "") or "").strip(),
                        "ppid": _int(rest[1]),
                    }
            return out
        start = snap()
        t0 = time.monotonic()
        time.sleep(seconds)
        end = snap()
        dt = max(0.001, time.monotonic() - t0)
        rows = []
        for key, now in end.items():
            old = start.get(key)
            if not old:
                continue
            ticks = now["ticks"] - old["ticks"]
            cpu = 100.0 * ticks / CLK_TCK / dt
            if cpu < 0.05:
                continue
            pid = key[0]
            rows.append({
                "pid": pid,
                "tid": key[1],
                "thread": now["comm"],
                "cpu_pct_core": round(cpu, 2),
                "kind": classify(self.root_pid, pid, proc_cmdline(pid), proc_comm(pid)),
            })
        rows.sort(key=lambda r: -r["cpu_pct_core"])
        return rows[:20]

    def finalize(self, outdir, events):
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, "samples.jsonl"), "w", encoding="utf-8") as fh:
            for s in self.samples:
                fh.write(json.dumps(s) + "\n")

        phases = []
        for m in self.marks:
            phases.append(m["name"])
        by_phase = {}
        for s in self.samples:
            if "error" in s:
                continue
            by_phase.setdefault(s["phase"], []).append(s)

        def stats_for(samples):
            out = {}
            def series(fn):
                vals = []
                for s in samples:
                    try:
                        v = fn(s)
                    except Exception:
                        v = None
                    if v is not None:
                        vals.append(v)
                return pct(vals)
            out["samples"] = len(samples)
            out["cpu_core"] = series(lambda s: s["browser"]["cpu_pct_core"])
            out["cpu_system_pct"] = series(lambda s: s["browser"]["cpu_pct_system"])
            out["pss_mb"] = series(lambda s: s["browser"]["pss_mb"])
            out["private_mb"] = series(lambda s: s["browser"]["private_mb"])
            out["swap_mb"] = series(lambda s: s["browser"]["swap_mb"])
            out["gpu_render_pct"] = series(lambda s: s["browser"]["gpu_render_pct"])
            out["gpu_video_pct"] = series(lambda s: s["browser"]["gpu_video_pct"])
            out["gpu_mem_mb"] = series(lambda s: s["browser"]["gpu_mem_mb"])
            out["igpu_busy_pct"] = series(lambda s: s["system"]["igpu_busy_pct"])
            out["sys_cpu_busy_pct"] = series(lambda s: s["system"]["cpu"]["busy_pct"] if s["system"]["cpu"] else None)
            out["sys_mem_available_mb"] = series(lambda s: s["system"]["mem_available_mb"])
            out["sys_swap_used_mb"] = series(lambda s: s["system"]["swap_used_mb"])
            out["procs"] = series(lambda s: s["browser"]["procs"])
            out["threads"] = series(lambda s: s["browser"]["threads"])
            kinds = {}
            keys = set()
            for s in samples:
                keys.update(s["by_kind"].keys())
            for k in keys:
                kinds[k] = {
                    "cpu_core": series(lambda s, k=k: s["by_kind"].get(k, {}).get("cpu_pct_core")),
                    "pss_mb": series(lambda s, k=k: s["by_kind"].get(k, {}).get("pss_mb")),
                    "gpu_render_pct": series(lambda s, k=k: s["by_kind"].get(k, {}).get("gpu_render_pct")),
                    "gpu_video_pct": series(lambda s, k=k: s["by_kind"].get(k, {}).get("gpu_video_pct")),
                    "procs": series(lambda s, k=k: s["by_kind"].get(k, {}).get("procs")),
                }
            out["by_kind"] = kinds
            return out

        summary = {
            "label": self.label,
            "root_pid": self.root_pid,
            "cpu_count": os.cpu_count(),
            "events": events,
            "marks": self.marks,
            "phases": {name: stats_for(vals) for name, vals in by_phase.items()},
            "peak_pss_mb": round(max((s["browser"]["pss_mb"] for s in self.samples if "error" not in s), default=0), 1),
            "peak_procs": max((s["browser"]["procs"] for s in self.samples if "error" not in s), default=0),
            "peak_threads": max((s["browser"]["threads"] for s in self.samples if "error" not in s), default=0),
            "hwm_pss_mb": round(sum(self.hwm.values()) / 1024.0, 1),
            "hwm_by_pid": {str(k): round(v / 1024.0, 1) for k, v in
                           sorted(self.hwm.items(), key=lambda kv: -kv[1])[:15]},
            "intel_gpu": self.intel,
        }
        with open(os.path.join(outdir, "summary.json"), "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
        return summary


def _safe_listdir(path):
    try:
        return os.listdir(path)
    except Exception:
        return []
