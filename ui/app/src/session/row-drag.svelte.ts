import { tabs } from "$domain/tabs";
import * as tabDrag from "./tab-drag.svelte";
import { Reorder } from "./reorder";

/** Where a drag was let go, for the list to decide what that means. */
type Drop = {
  id: string;
  x: number;
  y: number;
  /** The element under the pointer, resolved before anything moved. */
  over: Element | null;
  /** The tab under the pointer, which a placement goes before. */
  before: string | null;
};

type Options = {
  /** The list whose direct rows reorder in place. */
  list: () => HTMLElement | undefined;
  /** Whether this list reorders in place, and whether its rows are kept. */
  reorder: () => { essential: boolean } | null;
  /** The region the list scrolls in, whose room past the last row is the end of it. */
  region?: () => HTMLElement | undefined;
  /** A drop anywhere but back into the list's own order. */
  drop: (drop: Drop) => void;
  /** The tab under the pointer that this drop should pair with in a split,
   *  or null for an ordinary placement. */
  splitTarget?: (id: string, over: Element | null, x: number, y: number) => string | null;
  /** Runs a tab-on-tab split instead of a placement. */
  split?: (id: string, target: string) => void;
};

/** The tab a drop goes before: the one under the pointer, or the one after it
 *  when the pointer is past its middle, so the end of a row or a list can be
 *  chosen by dropping on the last tab's far half. */
function placeBefore(over: Element | null, x: number, y: number, dragged: string): string | null {
  const row = over?.closest<HTMLElement>("[data-astra-tab-id]");
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  const sideways = !!over?.closest("[data-essentials-drop]");
  const after = sideways ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2;
  if (!after && row.dataset.astraTabId !== dragged) return row.dataset.astraTabId ?? null;
  const rows = [...(row.closest("ul")?.querySelectorAll<HTMLElement>("[data-astra-tab-id]") ?? [])];
  const next = rows
    .slice(rows.indexOf(row) + 1)
    .find((candidate) => candidate.dataset.astraTabId !== dragged);
  return next?.dataset.astraTabId ?? null;
}

/**
 * One drag gesture for every list of tabs: the sidebar's rows, the rail, the
 * kept sites. A press becomes a drag only past a small movement, so a click
 * stays a click; the pointer is captured and followed once per frame by a
 * card of the tab, whatever the list is. Over the list's own rows the row
 * itself waits in the slot a drop would take (see reorder.ts). Letting go
 * inside the list reorders it; letting go anywhere else is the list's to
 * interpret.
 */
export class RowDrag {
  /** The card that follows the pointer, wherever it is and whatever the list does with the row. */
  ghost = $state<{ id: string; x: number; y: number } | null>(null);

  #options: Options;
  #down: { x: number; y: number } | null = null;
  #id = "";
  #dragging = false;
  #capture: { element: HTMLElement; pointerId: number } | null = null;
  #pointer = { x: 0, y: 0 };
  #frame = 0;
  #swallow = false;
  #reorder: Reorder | null = null;
  // A drop already committed, held where it was drawn until the reordered
  // list arrives.
  #landing: Reorder | null = null;
  #essential = false;
  #slot = -1;

  constructor(options: Options) {
    this.#options = options;
  }

  down(event: PointerEvent, id: string) {
    if (event.button !== 0) return;
    // A press always starts clean. If the previous gesture never saw its
    // release (the row it captured was rebuilt, or the release landed on
    // another surface), its card would otherwise stay under the pointer and
    // follow the next move: a stray icon with no drag behind it.
    if (this.#down !== null || this.#dragging) this.#reset();
    this.#down = { x: event.clientX, y: event.clientY };
    this.#id = id;
    this.#dragging = false;
  }

  move(event: PointerEvent) {
    const start = this.#down;
    if (start === null) return;
    // A release that the frame never saw (another surface took the pointer)
    // must not leave a press armed; the next hover would otherwise begin a
    // drag from a button that is no longer held.
    if ((event.buttons & 1) === 0) {
      this.#reset();
      return;
    }
    if (
      !this.#dragging &&
      Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 9
    ) {
      const target = event.currentTarget;
      if (target instanceof HTMLElement) {
        try {
          target.setPointerCapture(event.pointerId);
          this.#capture = { element: target, pointerId: event.pointerId };
        } catch {
          // The pointer is already gone (a synthetic or cancelled one): the
          // drag still works from the window listeners, only without capture.
          this.#capture = null;
        }
      }
      this.#dragging = true;
      this.#listen();
      tabDrag.begin(this.#id);
      document.body.style.cursor = "grabbing";
      this.#slot = -1;
      const reorder = this.#options.reorder();
      this.#essential = reorder?.essential ?? false;
      this.#reorder = reorder
        ? Reorder.begin(
            this.#options.list(),
            `tab:${this.#id}`,
            event.clientY,
            this.#options.region?.(),
          )
        : null;
    }
    if (!this.#dragging) return;

    this.#pointer = { x: event.clientX, y: event.clientY };
    if (this.#frame !== 0) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const { x, y } = this.#pointer;
      const inPlace = this.#reorder?.update(x, y) ?? false;
      this.#feel(inPlace);
      this.ghost = { id: this.#id, x, y };
      tabDrag.hover(x, y);
      tabs.dragOver(x, y);
    });
  }

  up(event: PointerEvent) {
    // The window listener may settle the gesture before the row's own
    // handler sees it; the second report must not run the drop twice.
    if (this.#down === null && !this.#dragging) return;
    // Stop listening before the capture is released, so the implicit
    // `lostpointercapture` cannot be mistaken for the row disappearing.
    this.#unlisten();
    const over = document.elementFromPoint(event.clientX, event.clientY);
    const before = placeBefore(over, event.clientX, event.clientY, this.#id);
    const dragged = this.#dragging;
    const id = this.#id;
    const reorder = this.#reorder;
    const essential = this.#essential;
    if (reorder && this.#frame !== 0) reorder.update(event.clientX, event.clientY);
    this.#release(event);
    this.#reset();
    if (!dragged) return;
    this.#swallow = true;

    // A drop on the middle of another tab is a split gesture, not a
    // placement. It is resolved before the reorder commits so the list never
    // records a move that the split then contradicts.
    const splitTarget = this.#options.splitTarget?.(id, over, event.clientX, event.clientY) ?? null;
    if (splitTarget !== null) {
      reorder?.release();
      this.#options.split?.(id, splitTarget);
      return;
    }

    const placed = reorder?.target();
    if (reorder && placed?.changed) {
      this.#landing?.clear();
      this.#landing = reorder;
      void tabDrag.move(id, essential, placed.before).then(() => {
        if (this.#landing !== reorder) return;
        // Refused: slide home at once. Accepted: the reordered list is on
        // its way and lands the rows itself; if it never comes, slide home.
        const home = () => {
          if (this.#landing !== reorder) return;
          this.#landing = null;
          reorder.release();
        };
        if (tabDrag.moveFailed()) home();
        else setTimeout(home, 600);
      });
      return;
    }
    reorder?.release();
    this.#options.drop({
      id,
      x: event.clientX,
      y: event.clientY,
      over,
      before,
    });
  }

  cancel(event: PointerEvent) {
    if (this.#down === null && !this.#dragging) return;
    this.#unlisten();
    this.#release(event);
    this.#reorder?.release();
    this.#reset();
  }

  /** Abandons any drag in progress, as a context menu opening does. */
  abandon() {
    this.#reorder?.release();
    this.#reset();
  }

  /** Whether a click is the end of a drag, and so not a click at all. */
  swallowClick(): boolean {
    const swallow = this.#swallow;
    this.#swallow = false;
    return swallow;
  }

  /** The list has changed shape: a held drop has arrived. Call after the
   *  list's own motion has measured where every row was drawn. */
  landed() {
    this.#landing?.clear();
    this.#landing = null;
  }

  /** Where the row last settled, so a snap is not re-announced per move. */
  #feel(inPlace: boolean) {
    const slot = this.#reorder?.slot ?? -1;
    if (inPlace && slot !== this.#slot) {
      this.#slot = slot;
    } else if (!inPlace) this.#slot = -1;
  }

  #release(event: PointerEvent) {
    const captured = this.#capture;
    if (
      captured !== null &&
      captured.pointerId === event.pointerId &&
      captured.element.hasPointerCapture(event.pointerId)
    ) {
      captured.element.releasePointerCapture(event.pointerId);
    }
    this.#capture = null;
  }

  /**
   * A gesture has one release, wherever it lands. Waiting only for the row's
   * own `pointerup` is what left the card behind when the row was rebuilt
   * mid-drag or the pointer was released over another surface; the window
   * still sees that release, so the gesture can always end.
   */
  #onPointerUp = (event: PointerEvent) => {
    // Only the press that owns the gesture releases it.
    if (event.button !== 0) return;
    this.up(event);
  };
  #onPointerCancel = (event: PointerEvent) => this.cancel(event);
  #onLostCapture = (event: PointerEvent) => {
    if (!this.#dragging || this.#down === null) return;
    // Capture is lost only while the gesture is still live when the row is
    // gone; its release will never arrive here. Drop the card with the row.
    if (this.#capture === null || this.#capture.pointerId === event.pointerId) this.abandon();
  };
  #onBlur = () => this.abandon();
  #onVisibility = () => {
    if (document.hidden) this.abandon();
  };
  #onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.#swallow = true;
    this.abandon();
  };

  #listen() {
    window.addEventListener("pointerup", this.#onPointerUp, true);
    window.addEventListener("pointercancel", this.#onPointerCancel, true);
    window.addEventListener("blur", this.#onBlur);
    window.addEventListener("keydown", this.#onKey, true);
    document.addEventListener("lostpointercapture", this.#onLostCapture, true);
    document.addEventListener("visibilitychange", this.#onVisibility);
  }

  #unlisten() {
    window.removeEventListener("pointerup", this.#onPointerUp, true);
    window.removeEventListener("pointercancel", this.#onPointerCancel, true);
    window.removeEventListener("blur", this.#onBlur);
    window.removeEventListener("keydown", this.#onKey, true);
    document.removeEventListener("lostpointercapture", this.#onLostCapture, true);
    document.removeEventListener("visibilitychange", this.#onVisibility);
  }

  #reset() {
    this.#unlisten();
    if (this.#frame !== 0) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    this.#down = null;
    this.#id = "";
    this.#dragging = false;
    this.#capture = null;
    this.#reorder = null;
    this.ghost = null;
    document.body.style.cursor = "";
    tabDrag.end();
  }
}
