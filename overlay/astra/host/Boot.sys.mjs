/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Boot module (v1). One startup owner for the Rust core:
// version negotiation, default-window setup, the opening `event_seq` for
// resync, the stdio sidecar lifecycle, and shutdown.
//
// The sidecar transport is Appendix C over `Subprocess` stdio: a 4-byte
// big-endian length followed by one UTF-8 JSON frame. `Subprocess` is
// resolved lazily inside `launchCore` so this module stays importable by
// Node contract tests (and standalone previews) without a chrome process.
//
// Negotiation rule: the caller may pass `min_host_api_version`; when it
// exceeds `HOST_API_VERSION` the handshake fails fast with
// `incompatible_host` instead of a half-working session (plan §6.4).
//
// A missing core command is an honest `unavailable`, not a fake launch. The
// shell decides the command (packaged binary or dev build) and passes it in.

import { emit, eventSeq } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";
import { __ensureDefaultWindow } from "./Windows.sys.mjs";

const FRAME_CAP = 16 * 1024 * 1024;

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

/** One Appendix C frame: 4-byte BE length + UTF-8 JSON body. */
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

/**
 * A launched core process. `proc` is the native Subprocess handle; this
 * class owns framing, pending calls and EOF, and never imports `Subprocess`
 * itself so Node tests can construct one with a stub.
 */
export class BootSidecar {
  static async launch(command, { stderr = "ignore" } = {}) {
    // Lazy: a Node import of this module must not resolve resource://.
    const { Subprocess } = await import("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({ command, stderr });
    const sidecar = new BootSidecar(proc);
    const hello = await sidecar.call("boot.handshake", { core_version: 1 });
    if (hello.kind !== "res") {
      await proc.kill(0);
      throw new Error("Sidecar handshake rejected");
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
    return this.proc.stdin.write(SidecarFrame.encode(envelope)).then(
      () =>
        new Promise(resolve => {
          this.pending.set(id, resolve);
        }),
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

let _core = null;

export const Boot = {
  async handshake({ request_id = "boot-0", core_version = 0, min_host_api_version = 1 } = {}) {
    if (
      typeof min_host_api_version === "number" &&
      min_host_api_version > HOST_API_VERSION
    ) {
      return err(
        request_id,
        "incompatible_host",
        `core requires host API ${min_host_api_version}, host is ${HOST_API_VERSION}`,
      );
    }
    const window_id = __ensureDefaultWindow();
    const result = ok(request_id, {
      core_version,
      event_seq: eventSeq(),
      window_id,
    });
    emit("boot.ready", { host_api_version: HOST_API_VERSION, window_id });
    return result;
  },

  /**
   * Launch the Rust core once. The shell owns the command path (packaged
   * binary or dev build); without one the answer is an honest unavailable.
   */
  async launchCore({ request_id = "boot-core", command = "" } = {}) {
    if (_core) {
      return ok(request_id, { state: "running" });
    }
    if (typeof command !== "string" || command.trim() === "") {
      return ok(request_id, {
        state: "unavailable",
        reason: "no core command configured",
      });
    }
    try {
      _core = await BootSidecar.launch(command.trim());
      return ok(request_id, { state: "running" });
    } catch (e) {
      _core = null;
      return err(request_id, "core_launch_failed", String(e));
    }
  },

  async coreStatus({ request_id = "boot-core-status" } = {}) {
    return ok(request_id, { state: _core ? "running" : "stopped" });
  },

  async status({ request_id = "boot-status" } = {}) {
    return ok(request_id, {
      ready: true,
      event_seq: eventSeq(),
      window_id: __ensureDefaultWindow(),
      core: _core ? "running" : "stopped",
    });
  },

  async shutdown({ request_id = "boot-shutdown", reason = "quit" } = {}) {
    let coreStopped = false;
    if (_core) {
      try {
        await _core.shutdown();
        coreStopped = true;
      } catch {
        // The process is gone or refused; shutdown still proceeds.
      } finally {
        _core = null;
      }
    }
    emit("boot.shutdown", { reason });
    return ok(request_id, { shutdown: true, core_stopped: coreStopped });
  },
};

// Test-only reset. A live core is left alone (tests never launch one).
export function __resetBootForTests() {
  _core = null;
}
