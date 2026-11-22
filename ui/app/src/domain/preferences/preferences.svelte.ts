import { observe } from "$shared/lib/observe";
import { flags } from "$shared/flags";
import { IS_WINDOWS } from "$shared/platform";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import { settle } from "$domain/operations";
import { createSlice } from "$shared/lib/lifecycle";

const defaults = {
  "appearance.theme": "light",
  "search.engine": "google",
  "search.custom-url": "",
  "search.suggestions": "true",
  "sidebar.mode": "default",
  "ui.accent": "graphite",
  "ui.material": "auto",
  "ui.reduce-motion": "false",
  "ui.newtab-greeting": "false",
  "ui.newtab-name": "false",
  "ui.newtab-clock": "true",
  "ui.newtab-clock-format": "system",
  "ui.newtab-tasks": "true",
  "ui.newtab-background": "sky",
  "ui.newtab-image": "",
  "ui.newtab-dim": "false",
  "ui.newtab-wordmark": "true",
  "ui.newtab-trackers": "true",
  "ui.newtab-focus": "true",
  "ui.tab-layout": "vertical",
  "ai.enabled": "true",
  "work.enabled": "true",
  "work.screenshots": "true",
  "ui.language": "system",
  "ui.density": "comfortable",
  "ui.contrast": "false",
  "search.history": "true",
  "tabs.new-position": "end",
  "tabs.after-close": "next",
  "tabs.switch-to-open": "true",
  "tabs.automatic-pip": "true",
  "tabs.startup": "new-tab",
  "tabs.startup-pages": "",
  "tabs.home": "",
  "network.proxy": "system",
  "network.proxy-address": "",
  "time.track": "true",
  "time.retention": "90",
  "focus.minutes": "25",
  "focus.breaks": "false",
  "focus.goal": "120",
  "focus.blocked": "",
  "performance.sleep": "true",
  "performance.after": "5",
  "performance.memory": "balanced",
  "performance.exceptions": "",
  "updates.auto-check": "true",
  "ui.theme": "astra",
  "ui.theme-custom": "",
  "ui.window-tint": "0",
  "ui.font": "astra",
  "ui.font-size": "13",
  // The page bar carries the window's own controls on Windows, so it ships
  // pinned there: the controls have a panel to belong to, and the address
  // field sits in the horizontal top bar instead of inside the column.
  "ui.main-bar": IS_WINDOWS ? "always" : "auto",
  "ui.code-font": "system",
  "ui.theme-contrast": "50",
  "tabs.archive": "never",
  "tabs.external-position": "new-tab",
  "tabs.close-button": "hover",
  "notes.enabled": "true",
  "tasks.enabled": "true",
  "time.enabled": "true",
  "work.favourite-models": "",
  "zoom.default": "100",
  // The launcher owns its recorder, so its shortcut is a preference of its own
  // rather than a Keyboard row.
  "launcher.shortcut": "CmdOrCtrl+Shift+Space",
  "launcher.double-tap": "off",
  "privacy.smartscreen": "true",
  "privacy.drm": "true",
  "privacy.cleanup": "false",
  "privacy.fingerprinting": "true",
  "privacy.camera": "Ask",
  "privacy.microphone": "Ask",
  "privacy.location": "Ask",
  "privacy.notifications": "Ask",
  // Native split view (engine owns the panes; these are the product's rules).
  "split.enabled": "true",
  "split.max-panes": "3",
  "split.restore": "true",
  "split.remember-width": "true",
  "split.link-target": "split",
  "split.drag-edge": "true",
  "split.drag-tab": "true",
  "split.double-click-reset": "true",
  "split.groups": "true",
  "split.group-collapse": "true",
  // Peek cards.
  "peek.enabled": "true",
  "peek.trigger": "hover-shift",
  "peek.delay": "420",
  "peek.size": "medium",
  "peek.position": "auto",
  "peek.scale": "1",
  "peek.restore": "true",
  "peek.close-leave": "true",
  "peek.show-url": "true",
  "peek.show-title": "true",
  "peek.pinned": "true",
  "peek.bookmarks": "true",
  // Space isolation.
  "history.scope": "space",
  "history.show-other": "false",
  "extensions.per-space": "true",
  "extensions.new-space": "all",
  // Cross-space tab cloning.
  "tabs.clone-history": "false",
  "tabs.clone-background": "true",
} as const;
export type PreferenceKey = keyof typeof defaults;
const values = $state<Record<PreferenceKey, string>>({ ...defaults });
let pending = $state<PreferenceKey | null>(null);
let failed = $state(false);
let lifetime: AbortController | null = null;
const versions: Partial<Record<PreferenceKey, number>> = {};
export const value = (key: PreferenceKey) => values[key];
export const saving = () => pending !== null;
export const saveFailed = () => failed;
/** AI: models, agents and dictation. Off — by build flag or preference — no AI
 *  surface is shown. The flag wins: a profile that kept "on" from a build with
 *  AI enabled still gets no AI here. */
export const aiEnabled = () => flags.ai && values["ai.enabled"] !== "false";
/** Account: sign-in, plan and credits. Off, the identity group is absent. */
export const accountEnabled = () => flags.account;
export type Feature = "work" | "notes" | "tasks" | "time";
/** A feature switch: off, the feature leaves the app; its data stays. A
 *  build flag that is off removes the feature even if a profile kept a
 *  stored "on" value from an earlier build. */
export const enabled = (feature: Feature) =>
  (feature !== "work" || flags.work) && values[`${feature}.enabled`] !== "false";
/** The feature a command belongs to. Mirrors `astra_core::commands::feature_of`. */
function featureOf(command: string): Feature | "ai" | null {
  if (["work.dictate", "tool.ai", "mode.choose"].includes(command)) return "ai";
  if (command === "browser.work" || command === "mode.work" || command.startsWith("work."))
    return "work";
  if (["tool.notes", "browser.notes", "note.new"].includes(command)) return "notes";
  if (command === "tool.tasks" || command === "browser.tasks") return "tasks";
  if (
    ["tool.time", "browser.time", "settings.focus"].includes(command) ||
    command.startsWith("focus.")
  )
    return "time";
  return null;
}
/** Whether a command's feature is on, so it is offered at all. */
export function commandOffered(command: string) {
  const feature = featureOf(command);
  return feature === null || (feature === "ai" ? aiEnabled() : enabled(feature));
}
/** A `set()` waiting for its own write to come back as `preference_changed`. */
type PreferenceWaiter = {
  key: PreferenceKey;
  value: string;
  generation: number;
  version: number;
  settle: (observed: boolean) => void;
};
let waiters: PreferenceWaiter[] = [];
const WAIT_MS = 1500;

function apply(key: PreferenceKey, next: string) {
  values[key] = next;
  versions[key] = (versions[key] ?? 0) + 1;
}
/** Apply a host announcement and settle the write that asked for it. Every
 *  event arrives on the same channel, so a write completes only on the event
 *  that names its key and value after the write was issued. */
function announce(key: PreferenceKey, next: string) {
  apply(key, next);
  for (const waiter of [...waiters]) {
    if (
      waiter.key === key &&
      waiter.value === next &&
      slice.isCurrent(waiter.generation) &&
      (versions[key] ?? 0) > waiter.version
    ) {
      waiter.settle(true);
    }
  }
}
function waitForChange(
  key: PreferenceKey,
  value: string,
  generation: number,
  version: number,
  signal: AbortSignal | undefined,
) {
  let finish: (observed: boolean) => void = () => {};
  const waiter: PreferenceWaiter = {
    key,
    value,
    generation,
    version,
    settle: (observed) => finish(observed),
  };
  const promise = new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (observed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiters = waiters.filter((entry) => entry !== waiter);
      resolve(observed);
    };
    const abort = () => done(false);
    finish = done;
    waiters.push(waiter);
    if (signal?.aborted) {
      done(false);
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => done(false), WAIT_MS);
  });
  return { promise, cancel: () => waiter.settle(false) };
}
export const slice = createSlice({
  async register({ isCurrent, attach }) {
    lifetime = new AbortController();
    const signal = lifetime.signal;
    const updated: Partial<Record<PreferenceKey, true>> = {};
    const unsubscribe = await events.uiCommand.listen(({ payload }) => {
      if (!isCurrent()) return;
      // The remaining string command in this channel is the keyboard/menu theme
      // choice; preference writes arrive typed on their own channel.
      if (!payload.startsWith("theme.")) return;
      updated["appearance.theme"] = true;
      apply("appearance.theme", payload.slice("theme.".length));
    });
    const unsubscribePreference = await events.preferenceChanged.listen(({ payload }) => {
      if (!isCurrent()) return;
      const key = payload?.key;
      if (typeof key !== "string" || !Object.hasOwn(defaults, key)) return;
      updated[key as PreferenceKey] = true;
      announce(key as PreferenceKey, String(payload.value ?? ""));
    });
    const release = () => {
      unsubscribe();
      unsubscribePreference();
    };
    if (!isCurrent()) {
      release();
      return;
    }
    attach(release);
    try {
      await Promise.all(
        (Object.keys(defaults) as PreferenceKey[]).map(async (key) => {
          try {
            const stored = await observe(commands.settingGet(key), 2000, signal);
            if (isCurrent() && !updated[key] && stored.state === "received")
              apply(key, stored.value ?? defaults[key]);
          } catch {
            /* Retain safe defaults if a read is unavailable. */
          }
        }),
      );
    } catch (error) {
      if (isCurrent()) lifetime.abort();
      release();
      throw error;
    }
  },
  reset() {
    lifetime?.abort();
    lifetime = null;
    pending = null;
    failed = false;
    for (const key of Object.keys(defaults) as PreferenceKey[]) {
      values[key] = defaults[key];
      delete versions[key];
    }
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
export async function set(key: PreferenceKey, next: string) {
  if (!slice.ready()) {
    failed = true;
    return;
  }
  if (pending !== null || values[key] === next) return;
  const generation = slice.current();
  const signal = lifetime?.signal;
  pending = key;
  failed = false;
  // The version before the write: only an announcement applied after it can
  // settle this write, so an older event for the same value cannot.
  const waited = waitForChange(key, next, generation, versions[key] ?? 0, signal);
  try {
    const result = await settle(commands.settingSet(key, next), 5000, signal);
    if (result.outcome === "failed" || result.outcome === "rejected")
      throw new Error("not processed");
    // Queue admission is not durable success. The host's typed event is, so the
    // pending presentation ends only when the matching change arrives; a lost
    // event fails the write instead of showing a fabricated "Saved".
    const observed = await waited.promise;
    if (!slice.isCurrent(generation) || signal?.aborted) return;
    if (!observed) throw new Error("preference change not observed");
  } catch {
    waited.cancel();
    if (slice.isCurrent(generation)) failed = true;
  } finally {
    if (slice.isCurrent(generation)) pending = null;
  }
}

/** Every preference back to how Astra ships, one validated write at a
 *  time. False when any of them did not land. */
export async function resetAll(): Promise<boolean> {
  for (const key of Object.keys(defaults) as PreferenceKey[]) {
    if (values[key] === defaults[key]) continue;
    await set(key, defaults[key]);
    if (failed || values[key] !== defaults[key]) return false;
  }
  return true;
}

/** Reset just this page, including choices whose feature is currently off. */
export async function resetNewTab(): Promise<boolean> {
  for (const key of Object.keys(defaults) as PreferenceKey[]) {
    if (!key.startsWith("ui.newtab-") || values[key] === defaults[key]) continue;
    await set(key, defaults[key]);
    if (failed || values[key] !== defaults[key]) return false;
  }
  return true;
}
