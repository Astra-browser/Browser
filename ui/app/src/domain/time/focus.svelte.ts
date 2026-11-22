import type { FocusControl, FocusStatus, FocusView, ShutSiteView } from "$shared/ipc/bindings";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import { settle } from "$domain/operations";
import { createSlice } from "$shared/lib/lifecycle";

const EMPTY: FocusStatus = { session: null, shut: [] };

let state = $state.raw<FocusStatus>(EMPTY);
let covered = $state<string | null>(null);
let pending = $state(false);
let failed = $state(false);
let lifetime = new AbortController();

/** The running session, or null between sessions. */
export const session = (): FocusView | null => state.session;
/** Shut sites as native last listed them, with the icons it holds. */
export const shut = (): ShutSiteView[] => state.shut;
/** The shut site the current tab would show, while focus covers it. */
export const cover = () => covered;
export const busy = () => pending;
export const lastFailed = () => failed;

// Instants cross as numbers specta types as nullable; native always sets them.
const ends = (view: FocusView) => view.phase_ends_at ?? 0;
const began = (view: FocusView) => view.phase_started_at ?? 0;

/** Seconds left in the running phase at `now`. */
export function remaining(view: FocusView, now = Date.now()): number {
  return Math.max(0, (ends(view) - now) / 1000);
}

/** Seconds focused in this session up to `now`, the running round included. */
export function focusedSeconds(view: FocusView, now = Date.now()): number {
  const running =
    view.phase === "focus" ? Math.max(0, Math.min(now, ends(view)) - began(view)) / 1000 : 0;
  return view.focused + running;
}

/** Phase progress from 0 to 1. */
export function progress(view: FocusView, now = Date.now()): number {
  const length = ends(view) - began(view);
  return length > 0 ? Math.min(1, Math.max(0, (now - began(view)) / length)) : 1;
}

async function control(request: FocusControl): Promise<boolean> {
  if (pending) return false;
  pending = true;
  failed = false;
  try {
    const result = await settle(commands.focusControl(request), 5000, lifetime.signal);
    const ok = result.outcome !== "failed" && result.outcome !== "rejected";
    failed = !ok;
    return ok;
  } catch {
    failed = true;
    return false;
  } finally {
    pending = false;
  }
}

export const start = (minutes: number, breaks: boolean) =>
  control({ kind: "start", minutes, breaks });
export const stop = () => control({ kind: "stop" });
export const skip = () => control({ kind: "skip" });
export const allow = (site: string) => control({ kind: "allow", site });

export const slice = createSlice({
  register({ isCurrent }) {
    if (lifetime.signal.aborted) lifetime = new AbortController();
    // Native projects focus with every bootstrap, so this must listen before
    // tabs asks for one.
    const statusReady = events.focusChanged.listen((event) => {
      if (isCurrent()) state = event.payload;
    });
    const coverReady = events.uiCommand.listen(({ payload }) => {
      if (!isCurrent() || !payload.startsWith("focus.cover=")) return;
      covered = payload.slice("focus.cover=".length) || null;
    });
    return Promise.all([statusReady, coverReady]);
  },
  reset() {
    lifetime.abort();
    state = EMPTY;
    covered = null;
    pending = false;
    failed = false;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
