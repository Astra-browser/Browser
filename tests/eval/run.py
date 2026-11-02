#!/usr/bin/env python3
"""P6-T10 eval harness: deterministic local port of eval/agentic-browsing.

What it proves (docs: docs/astra/EVAL.md): the ported browse-baseline and
capabilities/dom-read suites run hermetically against static loopback
fixtures (tests/fixtures/eval-*.html) with recorded baselines
(tests/eval/baselines.json) and enforced budget caps.

Runner choice: stdlib-only Python 3, following tools/contract-runner/run.py
conventions (fixture server on 127.0.0.1 + ephemeral port, JSON + Markdown
artifacts, exit 0 PASS / 1 FAIL / 2 SKIP). No pip deps, no browser.

Modes:
  run.py [--full]            all suites (default)
  run.py --smoke             fast subset: browse-baseline first page only
  run.py --suite NAME        one suite: browse-baseline | dom-read
  run.py --list-suites       print suite names, exit 0
  run.py --help              usage, exit 0

Exit codes: 0 PASS, 1 FAIL, 2 SKIP (fixtures or baselines absent).
Artifacts go to out/eval-<UTC timestamp>/: results.json, summary.md.

Budget caps (enforced in code, effective values recorded in results.json;
defaults from baselines.json budgets, tightened/loosened via env):
  ASTRA_EVAL_SITE_TIMEOUT_S   per-fetch timeout, seconds (default 10)
  ASTRA_EVAL_MAX_PAGES        max pages fetched per run (default 16)
  ASTRA_EVAL_MAX_BYTES        max bytes read per page (default 262144)
  ASTRA_EVAL_LATENCY_BUDGET_MS per-page wall-latency budget, ms (default 2000)
"""
import datetime
import functools
import html.parser
import http.server
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVAL_DIR = os.path.join(ROOT, "tests", "eval")
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
BASELINES_FILE = os.path.join(EVAL_DIR, "baselines.json")

SUITES = ("browse-baseline", "dom-read")


class BudgetExceeded(RuntimeError):
    pass


class Budget:
    """Run budget: caps fetches, bytes, and per-fetch time."""

    def __init__(self, timeout_s, max_pages, max_bytes, latency_budget_ms):
        self.timeout_s = timeout_s
        self.max_pages = max_pages
        self.max_bytes = max_bytes
        self.latency_budget_ms = latency_budget_ms
        self.pages_fetched = 0

    def check_page_allowance(self):
        if self.pages_fetched >= self.max_pages:
            raise BudgetExceeded(
                f"max pages exceeded: {self.pages_fetched} >= {self.max_pages}"
            )

    def as_dict(self):
        return {
            "site_timeout_s": self.timeout_s,
            "max_pages": self.max_pages,
            "max_bytes_per_page": self.max_bytes,
            "per_page_latency_budget_ms": self.latency_budget_ms,
            "pages_fetched": self.pages_fetched,
        }


def load_budgets():
    with open(BASELINES_FILE) as f:
        base = json.load(f)["budgets"]
    return Budget(
        timeout_s=float(os.environ.get("ASTRA_EVAL_SITE_TIMEOUT_S",
                                       base["site_timeout_s"])),
        max_pages=int(os.environ.get("ASTRA_EVAL_MAX_PAGES",
                                     base["max_pages"])),
        max_bytes=int(os.environ.get("ASTRA_EVAL_MAX_BYTES",
                                     base["max_bytes_per_page"])),
        latency_budget_ms=int(os.environ.get("ASTRA_EVAL_LATENCY_BUDGET_MS",
                                             base["per_page_latency_budget_ms"])),
    )


class Page(html.parser.HTMLParser):
    """Tiny DOM extract: title, marker-by-id text, links, controls."""

    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self.h1 = ""
        self._in_h1 = False
        self._capture_id = None
        self.by_id = {}
        self.links = []
        self.ids = set()
        self.paragraphs = 0
        self._in_article = False
        self.article_paragraphs = 0

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "h1":
            self._in_h1 = True
        if "id" in d:
            self.ids.add(d["id"])
            self._capture_id = d["id"]
            self.by_id.setdefault(d["id"], "")
        if tag == "a" and "href" in d:
            self.links.append(d["href"])
        if tag == "article" and d.get("id"):
            self._in_article = True
        if tag == "p":
            self.paragraphs += 1
            if self._in_article:
                self.article_paragraphs += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "h1":
            self._in_h1 = False
        if tag == "article":
            self._in_article = False
        # Stop id capture at the first nested end tag boundary is
        # approximate; fixtures keep marker text flat so this is exact.
        if self._capture_id and tag in ("p", "div", "span"):
            self._capture_id = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._in_h1:
            self.h1 += data
        if self._capture_id:
            self.by_id[self._capture_id] += data


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class FixtureServer:
    """Loopback static server for tests/fixtures/ (stdlib http.server)."""

    def __init__(self):
        handler = functools.partial(_QuietHandler, directory=FIXTURES)
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.thread.join(timeout=10)

    def url(self, path):
        return f"http://127.0.0.1:{self.port}/{path}"


def fetch(budget, url):
    """Fetch one page under budget; returns (status, body, wall_ms)."""
    budget.check_page_allowance()
    start = time.monotonic()
    req = urllib.request.Request(url, headers={"Connection": "close"})
    try:
        with urllib.request.urlopen(req, timeout=budget.timeout_s) as r:
            status = r.status
            # Byte cap: read at most max_bytes + 1 to detect overflow.
            body = r.read(budget.max_bytes + 1).decode("utf-8", errors="replace")
    except Exception as e:
        raise RuntimeError(f"fetch failed for {url}: {e!r}")
    wall_ms = (time.monotonic() - start) * 1000.0
    budget.pages_fetched += 1
    if len(body.encode("utf-8")) > budget.max_bytes:
        raise BudgetExceeded(f"page exceeds max bytes: {url}")
    return status, body, wall_ms


def parse(body):
    page = Page()
    page.feed(body)
    return page


def suite_browse_baseline(budget, base_url, baselines, only_first=False):
    """Ported browse-baseline: each pinned page loads with title+marker.

    Upstream measures cold-start/idle/multi-tab wall/CPU on a named device
    (pending_device_capture); locally we assert the deterministic half —
    correct content served fast over loopback — plus a per-page wall-latency
    budget as the regression tripwire.
    """
    checks = []
    pages = baselines["browse_baseline"]
    if only_first:
        pages = pages[:1]
    for pin in pages:
        url = base_url(pin["path"])
        try:
            status, body, wall_ms = fetch(budget, url)
        except (RuntimeError, BudgetExceeded) as e:
            checks.append((f"browse-baseline {pin['path']} loads", False, str(e)))
            continue
        page = parse(body)
        marker = page.by_id.get(pin["marker_id"], "").strip()
        checks.append((f"browse-baseline {pin['path']} HTTP 200",
                       status == 200, f"status={status}"))
        checks.append((f"browse-baseline {pin['path']} title",
                       page.title.strip() == pin["title"],
                       f"title={page.title.strip()!r}"))
        checks.append((f"browse-baseline {pin['path']} marker",
                       marker == pin["marker"], f"marker={marker!r}"))
        checks.append((f"browse-baseline {pin['path']} links>={pin['min_links']}",
                       len(page.links) >= pin["min_links"],
                       f"links={len(page.links)}"))
        checks.append((f"browse-baseline {pin['path']} latency_ms",
                       wall_ms <= budget.latency_budget_ms,
                       f"{wall_ms:.1f}ms<={budget.latency_budget_ms}ms"))
    return checks


def suite_dom_read(budget, base_url, baselines):
    """One capabilities subset: deterministic DOM locate + read/extract."""
    cap = baselines["capabilities_dom_read"]
    checks = []
    try:
        _, form_body, _ = fetch(budget, base_url(cap["form_page"]))
        _, art_body, _ = fetch(budget, base_url(cap["article_page"]))
    except (RuntimeError, BudgetExceeded) as e:
        return [("dom-read fixtures load", False, str(e))]
    form = parse(form_body)
    for cid in cap["required_controls"]:
        checks.append((f"dom-read form control #{cid} present",
                       cid in form.ids, f"ids={sorted(form.ids)}"))
    checks.append(("dom-read form element present",
                   cap["form_id"] in form.ids, f"form={cap['form_id']}"))
    art = parse(art_body)
    checks.append(("dom-read article heading",
                   art.h1.strip() == cap["article_heading"],
                   f"h1={art.h1.strip()!r}"))
    checks.append((f"dom-read article paragraphs>={cap['min_paragraphs']}",
                   art.article_paragraphs >= cap["min_paragraphs"],
                   f"paragraphs={art.article_paragraphs}"))
    return checks


class Artifacts:
    """Artifact sink: out/eval-<ts>/ (gitignored via out/)."""

    def __init__(self):
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.dir = os.path.join(ROOT, "out", f"eval-{ts}")
        os.makedirs(self.dir, exist_ok=True)
        self.lines = []

    def note(self, msg):
        print(msg, flush=True)
        self.lines.append(msg)

    def write(self, status, score, checks, budget):
        results = {
            "status": status,
            "score": score,
            "checks": [{"name": n, "ok": ok, "detail": d}
                       for n, ok, d in checks],
            "budgets": budget.as_dict(),
        }
        with open(os.path.join(self.dir, "results.json"), "w") as f:
            json.dump(results, f, indent=1)
        passed = sum(1 for _, ok, _ in checks if ok)
        lines = [f"# Eval results: {status}",
                 "",
                 f"Score: {passed}/{len(checks)}",
                 "",
                 "| Check | Result | Detail |",
                 "|---|---|---|"]
        for n, ok, d in checks:
            lines.append(f"| {n} | {'PASS' if ok else 'FAIL'} | {d} |")
        lines += ["", f"Budgets: `{json.dumps(budget.as_dict())}`",
                  "", f"Artifacts: `{self.dir}`", ""]
        with open(os.path.join(self.dir, "summary.md"), "w") as f:
            f.write("\n".join(lines))
        with open(os.path.join(self.dir, "console.log"), "w") as f:
            f.write("\n".join(self.lines) + "\n")
        self.note(f"artifacts: {self.dir}")


def run(selected, smoke):
    art = Artifacts()
    if not os.path.isdir(FIXTURES):
        art.note("SKIP: tests/fixtures/ absent")
        art.write("SKIP", "0/0", [], Budget(10, 16, 262144, 2000))
        return 2
    try:
        with open(BASELINES_FILE) as f:
            baselines = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        art.note(f"SKIP: baselines unreadable: {e}")
        art.write("SKIP", "0/0", [], Budget(10, 16, 262144, 2000))
        return 2
    budget = load_budgets()
    checks = []
    try:
        with FixtureServer() as srv:
            art.note(f"fixture server: http://127.0.0.1:{srv.port}/")
            if selected in ("browse-baseline", "all"):
                checks += suite_browse_baseline(
                    budget, srv.url, baselines, only_first=smoke)
            if selected == "all" and not smoke:
                checks += suite_dom_read(budget, srv.url, baselines)
            elif selected == "dom-read":
                checks += suite_dom_read(budget, srv.url, baselines)
    except BudgetExceeded as e:
        checks.append(("budget caps respected", False, str(e)))
    failed = [(n, d) for n, ok, d in checks if not ok]
    for n, ok, d in checks:
        art.note(("PASS " if ok else "FAIL ") + n + f" [{d}]")
    passed = len(checks) - len(failed)
    score = f"{passed}/{len(checks)}"
    if failed:
        art.write("FAIL", score, checks, budget)
        art.note(f"eval: FAIL ({len(failed)} checks, score {score})")
        return 1
    art.write("PASS", score, checks, budget)
    art.note(f"eval: PASS (score {score})")
    return 0


def main(argv):
    args = argv[1:]
    if "--help" in args or "-h" in args:
        print(__doc__.strip())
        return 0
    if "--list-suites" in args:
        print("\n".join(SUITES))
        return 0
    selected = "all"
    smoke = False
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--smoke":
            smoke = True
        elif a == "--full":
            pass
        elif a.startswith("--suite="):
            selected = a.split("=", 1)[1]
        elif a == "--suite" and i + 1 < len(args):
            i += 1
            selected = args[i]
        else:
            print(f"usage: run.py [--full|--smoke|--suite NAME|--list-suites]",
                  file=sys.stderr)
            return 2
        i += 1
    if selected != "all" and selected not in SUITES:
        print(f"unknown suite: {selected} (choose from {', '.join(SUITES)})",
              file=sys.stderr)
        return 2
    return run(selected, smoke)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
