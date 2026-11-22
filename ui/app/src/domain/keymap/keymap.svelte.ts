/**
 * The person's keymap as native resolved it: every registry command, its
 * current keys and its defaults. Native owns validation and storage; this is
 * the mirror Keyboard settings draws and the chrome key handler matches.
 */
import { commands, type KeymapEntry, type KeymapOutcome } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import { sameAccelerator } from "$shared/lib/accelerator";
import { createSlice } from "$shared/lib/lifecycle";

let entries = $state.raw<KeymapEntry[]>([]);

export const all = () => entries;

async function refresh(generation: number) {
  try {
    const next = await commands.keymapEntries();
    if (slice.isCurrent(generation)) entries = next;
  } catch {
    // The last known keymap stands; native retries on the next change.
  }
}

export const slice = createSlice({
  async register({ generation, isCurrent }) {
    const unsubscribe = await events.keymapChanged.listen(() => void refresh(slice.current()));
    if (!isCurrent()) {
      unsubscribe();
      return;
    }
    await refresh(generation);
    return unsubscribe;
  },
  reset() {
    entries = [];
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();

/** The command a chrome key press names, if any. The launcher is global and
 *  Work keys belong to the pane, so neither is matched here. */
export function commandFor(event: KeyboardEvent, mac: boolean, pressed: string): string | null {
  if (event.isComposing || event.repeat) return null;
  const hit = entries.find(
    (entry) =>
      entry.group !== "global" &&
      entry.group !== "work" &&
      entry.accelerator !== null &&
      sameAccelerator(entry.accelerator, pressed, mac),
  );
  if (!hit) return null;
  // Copy/cut/paste in one of Astra's own fields belong to that field, not to
  // the page behind it. Let the browser's default editing command run.
  if (
    ["page.copy", "page.cut", "page.paste", "page.selectAll"].includes(hit.id) &&
    isEditableTarget(event.target)
  ) {
    return null;
  }
  return hit.id;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLInputElement) {
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(element.type);
  }
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

/** `replace` takes the keys from whichever command holds them, in the same
 *  native change. */
export async function bind(
  id: string,
  accelerator: string | null,
  replace = false,
): Promise<KeymapOutcome> {
  try {
    const outcome = await commands.keymapBind(id, accelerator, replace);
    if (outcome.kind === "applied") await refresh(slice.current());
    return outcome;
  } catch {
    return { kind: "unavailable" };
  }
}

export async function reset(id: string | null): Promise<boolean> {
  try {
    const done = await commands.keymapReset(id);
    if (done) await refresh(slice.current());
    return done;
  } catch {
    return false;
  }
}

/** While recording, native window-level key handlers stand aside so the keys
 *  reach the recorder. */
export async function record(active: boolean): Promise<void> {
  await commands.keymapRecord(active).catch(() => {});
}
