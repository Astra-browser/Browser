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
const HANDSHAKE_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;

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
  static async launch(command, { stderr = "ignore", subprocess = null } = {}) {
    // Lazy: a Node import of this module must not resolve resource://.
    // `subprocess` is a test seam; production resolves the native module.
    const Subprocess =
      subprocess ?? (await import("resource://gre/modules/Subprocess.sys.mjs")).Subprocess;
    const proc = await Subprocess.call({ command, stderr });
    const sidecar = new BootSidecar(proc);
    try {
      let timer = 0;
      const hello = await Promise.race([
        sidecar.call("boot.handshake", { core_version: 1 }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Sidecar handshake timed out")),
            HANDSHAKE_TIMEOUT_MS,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (hello.kind !== "res" || hello.error) {
        throw new Error(
          hello?.error?.message ? `Sidecar handshake rejected: ${hello.error.message}` : "Sidecar handshake rejected",
        );
      }
    } catch (e) {
      sidecar.alive = false;
      try {
        await proc.kill(0);
      } catch {
        // The process may already be gone.
      }
      throw e;
    }
    return sidecar;
  }

  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.alive = true;
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
      this.alive = false;
      for (const resolve of this.pending.values()) {
        resolve({ kind: "res", error: { code: "SIDECAR_EOF", message: String(e) } });
      }
      this.pending.clear();
    }
  }

  call(name, payload, id = `boot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`) {
    if (!this.alive) {
      return Promise.reject(new Error("core is not running"));
    }
    const envelope = { v: 1, id, kind: "req", name, seq: 0, payload };
    return new Promise((resolve, reject) => {
      // Register before writing: a loopback response can arrive in the same
      // turn as the write and would otherwise be dropped.
      this.pending.set(id, resolve);
      this.proc.stdin.write(SidecarFrame.encode(envelope)).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async shutdown(timeout = 300) {
    try {
      if (this.alive) {
        await Promise.race([
          this.call("core.shutdown", {}).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, timeout)),
        ]);
      }
    } finally {
      this.alive = false;
      try {
        await this.proc.kill(timeout);
      } catch {
        // Already gone.
      }
    }
  }
}

let _core = null;
let _corePromise = null;
let _launchCore = null;
let _shuttingDown = false;

/** Test seam: replace the native launcher with a handle factory. */
export function __setCoreLauncherForTests(launcher) {
  _launchCore = typeof launcher === "function" ? launcher : null;
}

async function launchCoreHandle(command) {
  return (_launchCore ?? BootSidecar.launch)(command);
}

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
   * Concurrent callers share one launch; a dead handle is discarded.
   */
  async launchCore({ request_id = "boot-core", command = "" } = {}) {
    if (_shuttingDown) {
      return err(request_id, "core_shutting_down", "the core is shutting down");
    }
    if (_core?.alive) {
      return ok(request_id, { state: "running" });
    }
    if (_core && !_core.alive) {
      _core = null;
    }
    if (typeof command !== "string" || command.trim() === "") {
      return ok(request_id, {
        state: "unavailable",
        reason: "no core command configured",
      });
    }
    if (!_corePromise) {
      _corePromise = launchCoreHandle(command.trim())
        .then((handle) => {
          if (_shuttingDown) {
            void handle.shutdown();
            throw new Error("core shut down during launch");
          }
          _core = handle;
          return handle;
        })
        .finally(() => {
          _corePromise = null;
        });
    }
    try {
      await _corePromise;
      if (!_core?.alive) {
        _core = null;
        return err(request_id, "core_launch_failed", "core exited during startup");
      }
      return ok(request_id, { state: "running" });
    } catch (e) {
      _core = null;
      return err(request_id, "core_launch_failed", String(e));
    }
  },

  async status({ request_id = "boot-status" } = {}) {
    return ok(request_id, {
      ready: true,
      event_seq: eventSeq(),
      window_id: __ensureDefaultWindow(),
    });
  },

  async shutdown({ request_id = "boot-shutdown", reason = "quit" } = {}) {
    let coreStopped = false;
    _shuttingDown = true;
    try {
      // A launch in flight must settle (or time out) before we decide there
      // is no core. A hung handshake must not block quit forever.
      if (_corePromise) {
        try {
          await Promise.race([
            _corePromise,
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
          ]);
        } catch {
          // Launch failure already cleared the handle.
        }
      }
      const core = _core;
      if (core) {
        try {
          await core.shutdown();
          coreStopped = true;
        } catch {
          // The process is gone or refused; shutdown still proceeds.
        }
      }
      _core = null;
    } finally {
      _shuttingDown = false;
    }
    emit("boot.shutdown", { reason });
    return ok(request_id, { shutdown: true, core_stopped: coreStopped });
  },
};

// Test-only reset. A live core is stopped, not abandoned.
export function __resetBootForTests() {
  const core = _core;
  _core = null;
  _corePromise = null;
  _launchCore = null;
  _shuttingDown = false;
  if (core) {
    try {
      void core.shutdown();
    } catch {
      // Already gone.
    }
  }
}
