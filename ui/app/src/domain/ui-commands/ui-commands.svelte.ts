import { createSlice } from "$shared/lib/lifecycle";
import { events } from "$shared/ipc/native-events";

type UiCommandState = { id: string; seq: number };

let command = $state.raw<UiCommandState>({ id: "", seq: 0 });
let seq = 0;

export const uiCommand = () => command;

export const slice = createSlice({
  register({ isCurrent }) {
    return events.uiCommand.listen((event) => {
      if (!isCurrent()) return;
      seq += 1;
      command = { id: event.payload, seq };
    });
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();
