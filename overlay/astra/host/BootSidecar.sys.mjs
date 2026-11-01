/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// BootSidecar prototype (P1-T09 spike, U-01). Spawns `astra-core` over
// Subprocess stdio and exchanges Appendix C frames (4-byte big-endian
// length + UTF-8 JSON). NOT yet wired into jar.mn/packaging — P2 owns that.
// API signatures verified against the pinned ESR source:
//   engine/toolkit/modules/subprocess/Subprocess.sys.mjs        (call)
//   engine/toolkit/modules/subprocess/subprocess_common.sys.mjs (pipes)

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const FRAME_CAP = 16 * 1024 * 1024;

export class SidecarFrame {
  static encode(obj) {
    const body = new TextEncoder().encode(JSON.stringify(obj));
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length, false);
    out.set(body, 4);
    return out.buffer;
  }

  static async readNext(stdout) {
    const head = await stdout.read(4);
    const len = new DataView(head).getUint32(0, false);
    if (len > FRAME_CAP) {
      throw new Error(`Sidecar frame too large: ${len}`);
    }
    const text = await stdout.readString(len);
    return JSON.parse(text);
  }
}

export class BootSidecar {
  static async launch(command) {
    const proc = await Subprocess.call({ command, stderr: "ignore" });
    const sidecar = new BootSidecar(proc);
    try {
      const hello = await sidecar.call("boot.handshake", { core_version: 1 });
      if (hello.kind !== "res") {
        throw new Error("Sidecar handshake rejected");
      }
    } catch (e) {
      await proc.kill(0);
      throw e;
    }
    return sidecar;
  }

  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.pump();
  }

  async pump() {
    try {
      for (;;) {
        const msg = await SidecarFrame.readNext(this.proc.stdout);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    } catch (e) {
      for (const resolve of this.pending.values()) {
        resolve({ kind: "res", error: { code: "SIDECAR_EOF", message: String(e) } });
      }
      this.pending.clear();
    }
  }

  call(name, payload, id = `boot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`) {
    const envelope = { v: 1, id, kind: "req", name, seq: 0, payload };
    const write = this.proc.stdin.write(SidecarFrame.encode(envelope));
    return write.then(
      () =>
        new Promise(resolve => {
          this.pending.set(id, resolve);
        })
    );
  }

  async shutdown(timeout = 300) {
    try {
      await this.call("core.shutdown", {});
    } finally {
      await this.proc.kill(timeout);
    }
  }
}
