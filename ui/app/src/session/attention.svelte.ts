/**
 * What the column shows that the person has to see: a question it asks, a
 * download setting off. While anything holds it, a hidden column comes out as
 * the card the pointer at the window's edge brings, and goes back once
 * nothing does and the pointer isn't on it.
 */
import { untrack } from "svelte";

let holds = $state(0);

export const wanted = () => holds > 0;

/** Holds the column out until the returned function is called. Effects
 *  hold and release it without coming to depend on the count. */
export function hold(): () => void {
  untrack(() => (holds += 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    untrack(() => (holds -= 1));
  };
}

/** Brings the column out for something brief. */
export function pulse(ms = 3000): void {
  setTimeout(hold(), ms);
}

/** How long a popup has to take the keyboard before the hold lets go. */
const TAKE_MS = 1500;
/** Where nothing says the popup went, the hold never outlasts this. */
const LONGEST_MS = 45_000;

/** Holds the column out while an extension popup owns the keyboard. */
export function holdWhilePopupOpen(): void {
  const release = hold();
  let taken = false;
  const blurred = () => (taken = true);
  const focused = () => {
    if (!taken) return;
    done();
  };
  const closed = () => done();
  const unused = setTimeout(() => {
    if (!taken) done();
  }, TAKE_MS);
  const longest = setTimeout(done, LONGEST_MS);
  function done() {
    clearTimeout(unused);
    clearTimeout(longest);
    window.removeEventListener("blur", blurred);
    window.removeEventListener("focus", focused);
    window.removeEventListener("astra:popover-closed", closed);
    release();
  }
  window.addEventListener("blur", blurred);
  window.addEventListener("focus", focused);
  window.addEventListener("astra:popover-closed", closed);
}
