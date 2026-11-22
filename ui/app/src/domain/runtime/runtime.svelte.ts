import type { RuntimeStatus } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import { createSlice } from "$shared/lib/lifecycle";

const EMPTY: RuntimeStatus = {
  restart_required: false,
  session_set_aside: false,
  user_content_degraded_scope_count: 0,
  security_advisories: [],
};

let state = $state.raw<RuntimeStatus>(EMPTY);

export const status = () => state;

export const slice = createSlice({
  register({ isCurrent }) {
    return events.runtimeStatusChanged.listen((event) => {
      if (isCurrent()) state = event.payload;
    });
  },
  reset() {
    state = EMPTY;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
