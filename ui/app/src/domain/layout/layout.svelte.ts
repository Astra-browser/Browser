import { createSlice } from "$shared/lib/lifecycle";
import type { DividerView, WorkPaneLayout } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";

/** The pane's applied native hole with finite geometry; the wire type admits null for NaN. */
export type WorkPaneHole = {
  tab: string;
  x: number;
  y: number;
  width: number;
  height: number;
  presented: boolean;
  generation: number;
};

function hole(pane: WorkPaneLayout | null): WorkPaneHole | null {
  if (!pane || pane.x === null || pane.y === null || pane.width === null || pane.height === null)
    return null;
  return {
    tab: pane.tab,
    x: pane.x,
    y: pane.y,
    width: pane.width,
    height: pane.height,
    presented: pane.presented,
    generation: pane.generation,
  };
}

let dividerState = $state.raw<DividerView[]>([]);
let workPaneState = $state.raw<WorkPaneHole | null>(null);

export const dividers = () => dividerState;
/** The applied native hole of the Work browser pane, or null while no pane is shown. */
export const workPane = () => workPaneState;

export const slice = createSlice({
  register({ isCurrent }) {
    return events.layoutChanged.listen((event) => {
      if (!isCurrent()) return;
      dividerState = event.payload.dividers;
      workPaneState = hole(event.payload.work_pane);
    });
  },
  reset() {
    workPaneState = null;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
