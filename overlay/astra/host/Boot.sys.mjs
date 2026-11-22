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
import { Settings } from "./Settings.sys.mjs";
import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import { __ensureDefaultWindow } from "./Windows.sys.mjs";
import { PageDialogs } from "./PageDialogs.sys.mjs";

const FRAME_CAP = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;

/** The completion flag, validated by `astra_core::settings` (a bool whose
 *  default is "false", so a fresh profile is a first run). */
export const ONBOARDING_KEY = "onboarding.completed";

/** The packaged browser document the frame returns to after onboarding. */
const BROWSER_DOCUMENT = "chrome://astra/content/app/browser-chrome.html";

/**
 * The first-run rule, in one place for the host and the page (the page mirrors
 * it as `shouldOpenOnboarding`, `ui/app/src/features/welcome/lib/first-run.ts`;
 * `tests/contract/first_run.mjs` holds both to the same cases).
 *
 * A private window never opens onboarding and never records it, and only the
 * stored "true" means the flow is done. A missing or unreadable value is
 * `null`, which fails open to the flow: a fresh profile has no entry at all.
 */
export function onboardingDecision({ completed = null, isPrivate = false } = {}) {
  if (isPrivate === true) {
    return { open: false, reason: "private" };
  }
  // A test/profile seam: probes and contract runs boot fresh profiles all day
  // and must reach the browser, not the first-run page. `show` is for the
  // onboarding probe itself; anything else falls back to the store.
  let forced = "";
  try {
    forced = Services.prefs.getStringPref("astra.onboarding.force", "");
  } catch {
    forced = "";
  }
  if (forced === "skip") return { open: false, reason: "forced-skip" };
  if (forced === "show") return { open: true, reason: "forced-show" };
  // An automation profile is not a person meeting the product for the first
  // time. `navigator.webdriver` is true in the chrome window while Marionette
  // drives it; a profile that sets its own Marionette port counts too, because
  // the probes write that before the session exists.
  try {
    const view = globalThis.document?.defaultView ?? null;
    if (view?.navigator?.webdriver === true) {
      return { open: false, reason: "automation" };
    }
  } catch {
    // No document in this context.
  }
  try {
    if (Services.prefs.prefHasUserValue("marionette.port")) {
      return { open: false, reason: "automation" };
    }
  } catch {
    // No prefs service in this context.
  }
  if (completed === "true") {
    return { open: false, reason: "completed" };
  }
  return { open: true, reason: "first-run" };
}

/** Whether this main window must open onboarding now, read from the store. */
export function onboardingPending({ isPrivate = false } = {}) {
  return onboardingDecision({ completed: Settings.current(ONBOARDING_KEY), isPrivate }).open;
}

function chromeDocument() {
  try {
    return globalThis.document ?? null;
  } catch {
    return null;
  }
}

/** True in a private chrome window: its document carries the marker, and the
 *  engine's own answer is used when that module is reachable. */
export function __chromeWindowIsPrivate() {
  const doc = chromeDocument();
  try {
    if (doc?.documentElement?.getAttribute("privatebrowsingmode") === "temporary") {
      return true;
    }
  } catch {
    // No marker to read.
  }
  try {
    const win = doc?.defaultView;
    const { PrivateBrowsingUtils } = globalThis.ChromeUtils?.importESModule?.(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    ) ?? {};
    if (win && PrivateBrowsingUtils?.isWindowPrivate?.(win) === true) {
      return true;
    }
  } catch {
    // A chrome without the module keeps the marker answer.
  }
  return false;
}

/**
 * Point this window's app frame back at the browser document. The frame
 * belongs to the shell, and the onboarding page has no way to reload itself,
 * so this is how the host closes the page. Only a frame currently on the
 * onboarding document is moved: a second call (or a browser frame) is a no-op.
 */
export function __showBrowserSurface() {
  const doc = chromeDocument();
  let frame = null;
  try {
    frame = doc?.querySelector?.("[data-astra-app-frame]") ?? null;
  } catch {
    return false;
  }
  if (!frame) {
    return false;
  }
  try {
    // The attribute still names the browser page: the hand-off is a
    // `location.replace` inside the frame, so the live document is the truth.
    const live = String(frame.contentWindow?.location?.href ?? "");
    if (!/(^|\/)onboarding\.html(?:[?#]|$)/u.test(live)) {
      return false;
    }
    // The `src` attribute still names the browser page (the hand-off replaced
    // the live document, not the attribute), so setting it to the same value
    // is a no-op and the frame stayed on onboarding.html. Navigate the frame
    // itself; that is the document the person is looking at.
    try {
      frame.contentWindow.location.replace(BROWSER_DOCUMENT);
      return true;
    } catch {
      frame.setAttribute("src", BROWSER_DOCUMENT);
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * A build stages `astra-core.exe.new` beside a running binary, because Windows
 * cannot replace a mapped image. At launch nothing has that file open yet, so
 * this is the moment to swap it in. Node contracts have no ChromeUtils and no
 * staged file, so this is a no-op there.
 */
function applyStagedCore(command) {
  if (typeof command !== "string" || !command.toLowerCase().endsWith(".exe")) {
    return command;
  }
  try {
    if (typeof ChromeUtils === "undefined") return command;
    const { FileUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/FileUtils.sys.mjs",
    );
    const staged = new FileUtils.File(`${command}.new`);
    if (!staged.exists()) return command;
    const live = new FileUtils.File(command);
    try {
      if (live.exists()) live.remove(false);
    } catch {
      // Still held by something: the next launch tries again.
      return command;
    }
    try {
      staged.moveTo(live.parent, live.leafName);
    } catch {
      // The next launch tries again.
    }
  } catch {
    // No chrome or no staged file.
  }
  return command;
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
  static async launch(command, { stderr = "ignore", subprocess = null, arguments: args = [] } = {}) {
    // Lazy: a Node import of this module must not resolve resource://.
    // `subprocess` is a test seam; production resolves the native module.
    const Subprocess =
      subprocess ?? (await import("resource://gre/modules/Subprocess.sys.mjs")).Subprocess;
    const proc = await Subprocess.call({ command, arguments: args, stderr });
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
        // An unsolicited frame is the core reporting something: a hotkey
        // press, for one. There is no request to answer, so it goes to the
        // event channel the app already listens on.
        if (msg.kind === "evt") {
          if (msg.name === "launcher.toggle") emit("ui-command", "launcher.toggle");
          continue;
        }
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

/**
 * The sidecar is a process resource, but `resource://` modules are per
 * document, so every window would otherwise launch its own core against the
 * same SQLite file. The first window publishes the handle on `Services`;
 * later windows share it. Node tests have no `Services` and keep module
 * state.
 */
function sharedServices() {
  try {
    return typeof Services !== "undefined" && Services ? Services : null;
  } catch {
    return null;
  }
}

function currentCore() {
  const shared = sharedServices();
  if (shared && "astraCore" in shared) return shared.astraCore;
  return _core;
}

function setCore(core) {
  _core = core;
  const shared = sharedServices();
  if (shared) shared.astraCore = core;
}

function currentLaunch() {
  const shared = sharedServices();
  if (shared && "astraCoreLaunch" in shared) return shared.astraCoreLaunch;
  return _corePromise;
}

function setLaunch(promise) {
  _corePromise = promise;
  const shared = sharedServices();
  if (shared) shared.astraCoreLaunch = promise;
}

/** Test seam: replace the native launcher with a handle factory. */
export function __setCoreLauncherForTests(launcher) {
  _launchCore = typeof launcher === "function" ? launcher : null;
}

async function launchCoreHandle(command, args = []) {
  return (_launchCore ?? BootSidecar.launch)(command, { arguments: args });
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
    // The app's boot is the next moment the window is guaranteed to exist;
    // the import-time attempt can lose a race with the native tab browser.
    installPageDialogHook();
    const result = ok(request_id, {
      core_version,
      event_seq: eventSeq(),
      window_id,
    });
    emit("boot.ready", { host_api_version: HOST_API_VERSION, window_id });
    return result;
  },

  /**
   * Register (or re-register) the launcher's global shortcut in the core.
   * The desktop decides whether the key is free, so the answer is relayed
   * rather than assumed: Settings reports what the system said.
   */
  async launcherShortcut({ accelerator = "" } = {}) {
    const core = currentCore();
    if (!core?.alive) {
      return { registered: false, reason: "unavailable" };
    }
    try {
      const reply = await core.call("launcher.set", { accelerator });
      return reply?.payload ?? { registered: false, reason: "unavailable" };
    } catch {
      return { registered: false, reason: "unavailable" };
    }
  },

  /**
   * Launch the Rust core once. The shell owns the command path (packaged
   * binary or dev build); without one the answer is an honest unavailable.
   * Concurrent callers share one launch; a dead handle is discarded.
   */
  async launchCore({ request_id = "boot-core", command = "", arguments: args = [] } = {}) {
    if (_shuttingDown) {
      return err(request_id, "core_shutting_down", "the core is shutting down");
    }
    if (currentCore()?.alive) {
      return ok(request_id, { state: "running" });
    }
    if (currentCore() && !currentCore().alive) {
      setCore(null);
    }
    if (typeof command !== "string" || command.trim() === "") {
      return ok(request_id, {
        state: "unavailable",
        reason: "no core command configured",
      });
    }
    command = applyStagedCore(command.trim());
    if (!currentLaunch()) {
      setLaunch(
        launchCoreHandle(command.trim(), Array.isArray(args) ? args : [])
          .then((handle) => {
            if (_shuttingDown) {
              void handle.shutdown();
              throw new Error("core shut down during launch");
            }
            setCore(handle);
            return handle;
          })
          .finally(() => {
            setLaunch(null);
          }),
      );
    }
    try {
      await currentLaunch();
      const core = currentCore();
      if (!core?.alive) {
        setCore(null);
        return err(request_id, "core_launch_failed", "core exited during startup");
      }
      // The launcher's shortcut lives in the core, and the app may have asked
      // for it before the core was up. Hand it over now that it is.
      void import("./Launcher.sys.mjs")
        .then(({ Launcher }) => Launcher.reapply())
        .catch(() => {});
      return ok(request_id, { state: "running" });
    } catch (e) {
      setCore(null);
      return err(request_id, "core_launch_failed", String(e));
    }
  },

  /**
   * One request to the launched core (P5b). Returns the raw reply envelope,
   * or a `core_unavailable` error when no core is running; callers must treat
   * a missing core as "unavailable", never as success.
   */
  async coreCall({ request_id = "", name = "", payload = {}, timeout = 8000 } = {}) {
    const core = currentCore();
    if (!core?.alive) {
      return { request_id, error: { code: "core_unavailable", message: "the core is not running" } };
    }
    let timer = 0;
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 8000;
    try {
      return await Promise.race([
        core.call(name, payload),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`core request timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      return { request_id, error: { code: "core_failed", message: String(e) } };
    } finally {
      clearTimeout(timer);
    }
  },

  async status({ request_id = "boot-status" } = {}) {
    return ok(request_id, {
      ready: true,
      event_seq: eventSeq(),
      window_id: __ensureDefaultWindow(),
    });
  },

  /**
   * Finish onboarding once: persist the completion flag through the settings
   * store (the key `astra-core` validates), then hand this window's frame back
   * to the browser. A private window refuses without writing. True only when
   * the store accepted the write; a refused write keeps the page open so the
   * person can retry instead of being told a lie.
   */
  /**
   * Whether this window must show the first-run page. The app asks instead of
   * deciding itself, so the automation/force seams and the private-window rule
   * live in one place. `null` when the store cannot be read (the caller fails
   * open, as before).
   */
  async onboardingPendingView({ request_id = "onboarding-pending" } = {}) {
    const decision = onboardingDecision({
      completed: Settings.current(ONBOARDING_KEY),
      isPrivate: __chromeWindowIsPrivate(),
    });
    return decision;
  },

  async onboardingFinish({ request_id = "onboarding-finish", isPrivate = null } = {}) {
    const priv = isPrivate === null ? __chromeWindowIsPrivate() : isPrivate === true;
    if (priv) {
      return false;
    }
    const written = await Settings.set({
      request_id,
      key: ONBOARDING_KEY,
      value: "true",
    });
    if (written?.accepted !== true) {
      return false;
    }
    __showBrowserSurface();
    return true;
  },

  async shutdown({ request_id = "boot-shutdown", reason = "quit" } = {}) {
    let coreStopped = false;
    _shuttingDown = true;
    try {
      // A launch in flight must settle (or time out) before we decide there
      // is no core. A hung handshake must not block quit forever.
      if (currentLaunch()) {
        try {
          await Promise.race([
            currentLaunch(),
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
          ]);
        } catch {
          // Launch failure already cleared the handle.
        }
      }
      const core = currentCore();
      if (core) {
        try {
          await core.shutdown();
          coreStopped = true;
        } catch {
          // The process is gone or refused; shutdown still proceeds.
        }
      }
      setCore(null);
    } finally {
      _shuttingDown = false;
    }
    emit("boot.shutdown", { reason });
    return ok(request_id, { shutdown: true, core_stopped: coreStopped });
  },
};

// Test-only reset. A live core is stopped, not abandoned.
export function __resetBootForTests() {
  const core = currentCore();
  setCore(null);
  setLaunch(null);
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

// ASTRA-0020 window hook: the chrome document that loads the Host API is the
// window whose page dialogs Astra answers. Any other importer (the app frame,
// a standalone preview, Node) has no gBrowser and gets no controller.
function installPageDialogHook() {
  try {
    const win = globalThis;
    if (win?.document && win.gBrowser) {
      PageDialogs.install({ window: win });
      return true;
    }
    // The imported module can run before the native tab browser exists.
    if (win?.document && typeof win.addEventListener === "function") {
      win.addEventListener("load", installPageDialogHook, { once: true });
    }
  } catch {
    // Without a chrome window the engine keeps its own dialog.
  }
  return false;
}

installPageDialogHook();
