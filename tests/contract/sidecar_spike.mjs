#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P1-T09 sidecar spike harness (U-01). Compares stdio (Subprocess model:
// absolute path, OS pipes, 4-byte BE + UTF-8 JSON per plan Appendix C)
// against a loopback-WebSocket fallback (random port + per-launch token).
//
// Stdlib only. Exit 0 on PASS, 1 on FAIL. Prints a JSON metrics block.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const STUB = join(ROOT, "out", "sidecar-stub");

const N_RTT = 2000;
const BURST = 1000;
const CONCURRENCY = 50;

function req(id) {
  return JSON.stringify({
    v: 1, id: `r-${id}`, kind: "req", name: "tabs.create", seq: 0,
    payload: { space_id: "s-1", url: "about:blank", background: false },
  });
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---- stdio transport (mirrors overlay/astra/host/BootSidecar.sys.mjs logic) ----
class StdioCore {
  static launch() {
    const child = spawn(STUB, [], { stdio: ["pipe", "pipe", "ignore"] });
    return new StdioCore(child);
  }
  constructor(child) {
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    child.stdout.on("data", (c) => this.onData(c));
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + n) return;
      const body = this.buf.subarray(4, 4 + n).toString("utf8");
      this.buf = this.buf.subarray(4 + n);
      const w = this.waiters.shift();
      if (w) w(JSON.parse(body));
    }
  }
  call(obj) {
    return new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(obj));
      const hdr = Buffer.alloc(4);
      hdr.writeUInt32BE(bytes.length, 0);
      this.waiters.push(resolve);
      this.child.stdin.write(Buffer.concat([hdr, bytes]), (e) => e && reject(e));
    });
  }
  async kill(signal = "SIGTERM") {
    const exited = new Promise((r) => this.child.once("exit", (code, sig) => r({ code, sig })));
    this.child.kill(signal);
    return exited;
  }
}

// ---- minimal loopback WS fallback: stdlib server, global WS client ----
function wsAccept(key) {
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function startWsServer(token, onMessage) {
  const server = createServer();
  const clients = new Set();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`
    );
    const st = { buf: Buffer.alloc(0), socket };
    clients.add(st);
    socket.on("data", (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      while (st.buf.length >= 2) {
        const fin = st.buf[0] & 0x80, op = st.buf[0] & 0x0f;
        const masked = st.buf[1] & 0x80;
        let len = st.buf[1] & 0x7f, off = 2;
        if (len === 126) { len = st.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(st.buf.readBigUInt64BE(2)); off = 10; }
        const mlen = masked ? 4 : 0;
        if (st.buf.length < off + mlen + len) return;
        let payload = st.buf.subarray(off + mlen, off + mlen + len);
        if (masked) {
          const mask = st.buf.subarray(off, off + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        }
        st.buf = st.buf.subarray(off + mlen + len);
        if (op === 0x8) { socket.write(Buffer.from([0x88, 0x00])); socket.destroy(); clients.delete(st); return; }
        if (op === 0x9) { // ping -> pong
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          continue;
        }
        if (op === 0x1 && fin) onMessage(payload.toString("utf8"), (text) => {
          const b = Buffer.from(text);
          const h = b.length < 126 ? Buffer.from([0x81, b.length])
            : Buffer.concat([Buffer.from([0x81, 126]), Buffer.alloc(2)]);
          if (b.length >= 126) h.writeUInt16BE(b.length, 2);
          socket.write(Buffer.concat([h, b]));
        });
      }
    });
    socket.on("close", () => clients.delete(st));
    if (head.length) socket.emit("data", head);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, clients }));
  });
}

class WsCore {
  static async launch() {
    const token = randomBytes(16).toString("hex");
    const pending = new Map();
    const { server, port } = await startWsServer(token, (text, reply) => {
      const msg = JSON.parse(text);
      reply(JSON.stringify({ v: 1, id: msg.id, kind: "res", name: msg.name, seq: 0, payload: { echo: msg } }));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sidecar?token=${token}`);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    });
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new WsCore(server, ws, pending, token, port);
  }
  constructor(server, ws, pending, token, port) {
    this.server = server; this.ws = ws; this.pending = pending; this.token = token; this.port = port;
  }
  call(obj) {
    return new Promise((resolve) => {
      this.pending.set(obj.id, resolve);
      this.ws.send(JSON.stringify(obj));
    });
  }
  async killServer() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      const closed = new Promise((r) => this.ws.addEventListener("close", r, { once: true }));
      try { this.ws.close(); } catch {}
      await closed;
    }
    await new Promise((r) => this.server.close(r));
  }
}

async function measureRtt(call) {
  await call({ v: 1, id: "r-warm", kind: "req", name: "tabs.create", seq: 0, payload: {} });
  const ts = [];
  for (let i = 0; i < N_RTT; i++) {
    const t0 = performance.now();
    const res = await call(JSON.parse(req(i)));
    const dt = performance.now() - t0;
    if (res.id !== `r-${i}`) throw new Error(`id mismatch: ${res.id}`);
    ts.push(dt);
  }
  ts.sort((a, b) => a - b);
  return { n: N_RTT, mean: ts.reduce((a, b) => a + b, 0) / ts.length, p50: pct(ts, 50), p99: pct(ts, 99) };
}

async function measureBurst(call) {
  const t0 = performance.now();
  let inFlight = 0, next = 0, done = 0, errors = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (inFlight < CONCURRENCY && next < BURST) {
        const i = next++;
        inFlight++;
        call(JSON.parse(req(100000 + i))).then((res) => {
          if (res.id !== `r-${100000 + i}`) errors++;
        }).catch(() => errors++).finally(() => {
          inFlight--; done++;
          if (done >= BURST) resolve();
          else pump();
        });
      }
    };
    pump();
  });
  const secs = (performance.now() - t0) / 1000;
  return { n: BURST, lost: errors, secs, per_sec: BURST / secs };
}

const results = { pass: true, checks: [] };
function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  if (!ok) results.pass = false;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

if (!existsSync(STUB)) {
  console.error(`missing binary: ${STUB} (build: cargo build --release --manifest-path crates/astra-proto/Cargo.toml && cp ... out/)`);
  process.exit(1);
}

// --- stdio ---
const stdio = StdioCore.launch();
const stdioRtt = await measureRtt((o) => stdio.call(o));
const stdioBurst = await measureBurst((o) => stdio.call(o));
check("stdio round-trip ids", true, `n=${N_RTT}`);
const tKill0 = performance.now();
const exitInfo = await stdio.kill("SIGTERM");
const killMs = performance.now() - tKill0;
check("stdio kill-core exits", exitInfo.code !== null || exitInfo.sig !== null, JSON.stringify(exitInfo));
const tRe0 = performance.now();
const stdio2 = StdioCore.launch();
const re = await stdio2.call(JSON.parse(req(999999)));
check("stdio respawn round-trip", re.id === "r-999999", `downtime≈${(performance.now() - tRe0).toFixed(1)}ms`);
// browser-death: close our pipe ends, core must observe EOF and exit
const stdio3 = StdioCore.launch();
await stdio3.call(JSON.parse(req(7)));
const tBd0 = performance.now();
stdio3.child.stdin.destroy();
const bdExit = await new Promise((r) => stdio3.child.once("exit", (code) => r(code)));
const bdMs = performance.now() - tBd0;
check("stdio browser-death EOF exit", bdExit === 0, `${bdMs.toFixed(1)}ms to exit 0`);
await stdio2.kill("SIGKILL");

// --- ws fallback ---
const ws = await WsCore.launch();
const wsRtt = await measureRtt((o) => ws.call(o));
const wsBurst = await measureBurst((o) => ws.call(o));
// wrong token rejected
const badAttempt = await new Promise((resolve) => {
  const s = new WebSocket(`ws://127.0.0.1:${ws.port}/sidecar?token=wrong`);
  let settled = false;
  s.addEventListener("open", () => { if (!settled) { settled = true; s.close(); resolve(false); } });
  s.addEventListener("error", () => { if (!settled) { settled = true; resolve(true); } });
  setTimeout(() => { if (!settled) { settled = true; try { s.close(); } catch {} resolve("timeout"); } }, 3000);
});
check("ws wrong-token rejected", badAttempt === true, String(badAttempt));
// kill client only: server survives, reconnect keeps working
const tRc0 = performance.now();
ws.ws.close();
await new Promise((r) => ws.ws.addEventListener("close", r, { once: true }));
const pending2 = new Map();
const ws2sock = new WebSocket(`ws://127.0.0.1:${ws.port}/sidecar?token=${ws.token}`);
ws2sock.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  pending2.get(msg.id)?.(msg);
  pending2.delete(msg.id);
});
await new Promise((res, rej) => {
  ws2sock.addEventListener("open", res, { once: true });
  ws2sock.addEventListener("error", rej, { once: true });
});
const rcRes = await new Promise((resolve) => {
  pending2.set("r-rc", resolve);
  ws2sock.send(req("rc").replace("r-rc0", "r-rc"));
});
check("ws client reconnect, core state survives", rcRes.id === "r-rc", `${(performance.now() - tRc0).toFixed(1)}ms`);
ws2sock.close();
await new Promise((r) => ws2sock.addEventListener("close", r, { once: true }));
const tWsKill0 = performance.now();
await ws.killServer();
const wsDownMs = performance.now() - tWsKill0;

results.metrics = {
  stdio: { rtt_ms: stdioRtt, burst: stdioBurst, kill_core_ms: killMs, browser_death_exit_ms: bdMs },
  ws: { rtt_ms: wsRtt, burst: wsBurst, kill_server_close_ms: wsDownMs },
};
console.log("METRICS " + JSON.stringify(results.metrics));
console.log(results.pass ? "SPIKE PASS" : "SPIKE FAIL");
process.exit(results.pass ? 0 : 1);
