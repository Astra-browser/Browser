#!/usr/bin/env python3
"""Loopback fixture server for the Astra stress matrix.

Serves tools/perf/stress/fixtures on several ports (distinct origins => the
browser cannot put every tab in one content process) and records the page
heartbeats (`POST /report`) as JSONL.

Usage:
  python3 stress_server.py --root fixtures --report out/reports.jsonl \
      --ports 8111 8112 8113 8114
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    report_path = None
    report_lock = threading.Lock()

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/report":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(min(length, 256 * 1024))
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            payload = {"raw": raw[:200].decode("utf-8", "replace")}
        payload["_server_t"] = round(time.time(), 3)
        payload["_port"] = self.server.server_port
        with Handler.report_lock:
            if Handler.report_path:
                with open(Handler.report_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(payload) + "\n")
        self.send_response(204)
        self.send_header("cache-control", "no-store")
        self.end_headers()


def serve(port, root):
    os.chdir(root)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--report", required=True)
    ap.add_argument("--ports", nargs="+", type=int, required=True)
    args = ap.parse_args()
    Handler.report_path = os.path.abspath(args.report)
    open(Handler.report_path, "a").close()
    for port in args.ports:
        threading.Thread(target=serve, args=(port, args.root), daemon=True).start()
    # Only the main thread waits; servers are daemons.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
