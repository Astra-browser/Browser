/**
 * Pointer capture for synthetic gestures.
 *
 * A component test dispatches `PointerEvent`s itself; the browser treats them
 * as untrusted and has no active pointer with that id, so
 * `Element.setPointerCapture(pointerId)` throws `NotFoundError`. Drag code that
 * captures — correctly, so the release still arrives when the row is rebuilt —
 * would abort before it set any drag state, and no assertion after the gesture
 * could mean anything.
 *
 * This installs the bookkeeping a real pointer produces (capture on the element
 * that asked, `hasPointerCapture` true for it, release clearing it) for the
 * duration of a test file. The product is unchanged: it still chooses to
 * capture, and still has to cope with a capture that is lost.
 */
export function installPointerCapture(): () => void {
  const proto = Element.prototype;
  const set = proto.setPointerCapture;
  const has = proto.hasPointerCapture;
  const release = proto.releasePointerCapture;
  const captures = new WeakMap<Element, Set<number>>();

  proto.setPointerCapture = function (this: Element, pointerId: number): void {
    try {
      set.call(this, pointerId);
    } catch {
      // Untrusted pointer: the browser refuses the real capture, so the
      // bookkeeping below is the only capture this gesture can have.
    }
    const held = captures.get(this) ?? new Set<number>();
    held.add(pointerId);
    captures.set(this, held);
  };
  proto.hasPointerCapture = function (this: Element, pointerId: number): boolean {
    return captures.get(this)?.has(pointerId) === true || has.call(this, pointerId);
  };
  proto.releasePointerCapture = function (this: Element, pointerId: number): void {
    try {
      release.call(this, pointerId);
    } catch {
      // Nothing was captured natively; clearing our own is enough.
    }
    captures.get(this)?.delete(pointerId);
  };

  return () => {
    proto.setPointerCapture = set;
    proto.hasPointerCapture = has;
    proto.releasePointerCapture = release;
  };
}
