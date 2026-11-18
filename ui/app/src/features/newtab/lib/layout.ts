import type { Notch } from "./ground";
import { WORDMARK } from "$shared/lib/wordmark";

/** A box in the page's own pixels. */
export type Box = { x: number; y: number; w: number; h: number };

export type Layout = {
  /** The page is not cut any more: the field stands on it. Kept so the ground
   *  and the sky share one shape, and zeroed so the clip is a plain rectangle. */
  notch: Notch;
  /** The page's controls, each in its own round pane (a capsule when it
   *  holds words), in the top corner, the last nearest the corner. */
  controls: Box[];
  /** Where the sky meets the page. */
  horizon: number;
  /** The name, the sky's one large figure. */
  mark: Box;
  /** Where the line with the time and the date stands under the name, or
   *  null without a clock. */
  when: number | null;
  /** The one search field: a wide pill under the name and the day, where the
   *  eye lands after reading them. */
  field: Box;
};

const NOTCH: Notch = { width: 0, height: 0, radius: 0, flare: 0 };
const CORNER = 110;
const CONTROL = { size: 32, gap: 6, inset: 14, top: 9 };
/** What two round controls take from the corner, which CORNER was set for. */
const TWO_ROUND = CONTROL.inset + 2 * CONTROL.size + CONTROL.gap;
/** The line with the time and the date, and its distance under the name. */
const WHEN = { gap: 14, height: 20 };
/** The field: the measure of a search someone reads a suggestion in, and the
 *  air between it and the line above it. */
const FIELD = { width: 560, height: 50, gap: 34, min: 240 };
/** The band at the top that moves the window, kept clear of everything. */
export const TITLE_BAND = 32;

/** Everything on the page laid out from its size alone, so the sky that is
 *  cut and the things that stand on it come from the same numbers in the same
 *  frame, and a resize can never draw one ahead of the other. */
export function layout(
  width: number,
  height: number,
  {
    controls,
    clock,
    wordmark = true,
  }: { controls: readonly number[]; clock: boolean; wordmark?: boolean },
): Layout {
  // Both top corners stay clear of the notch's flare for the controls in
  // one of them, so the group stays centred however wide they are.
  const reach = controls.reduce((sum, w) => sum + w + CONTROL.gap, CONTROL.inset - CONTROL.gap);
  const corner = Math.max(CORNER, reach + CORNER - TWO_ROUND);
  const notch = { ...NOTCH, width: Math.min(NOTCH.width, width - 2 * corner) };

  const buttonY = CONTROL.top;
  let right = width - CONTROL.inset;
  const buttons = controls
    .toReversed()
    .map((w) => {
      const box = { x: right - w, y: buttonY, w, h: CONTROL.size };
      right = box.x - CONTROL.gap;
      return box;
    })
    .toReversed();

  // The sky takes the top of the page. The name stands in the open sky above
  // the horizon, the day reads under it, and the field closes the group.
  const horizon = Math.round(height * (height < 600 ? 0.62 : 0.6));
  const markW0 = Math.round(Math.min(480, Math.max(260, width * 0.36)));
  const nameH = Math.ceil(markW0 * (84 / 585) * 1.35);
  const skyRoom = Math.round((horizon - TITLE_BAND) * 0.5);
  const markH = wordmark ? Math.min(nameH, skyRoom) : 0;
  // Even width so the name is centred on a whole pixel.
  const markW = wordmark ? 2 * Math.round((markH * WORDMARK.width) / WORDMARK.height / 2) : 0;
  const clockGap = wordmark ? WHEN.gap : 0;
  const group =
    markH +
    (clock ? clockGap + WHEN.height : 0) +
    (wordmark || clock ? FIELD.gap : 0) +
    FIELD.height;
  const top = Math.max(TITLE_BAND + 16, Math.round((height - group) / 2));
  const mark = { x: Math.round((width - markW) / 2), y: top, w: markW, h: markH };
  const when = clock ? top + markH + clockGap : null;
  const fieldW = Math.round(Math.min(FIELD.width, Math.max(FIELD.min, width * 0.8)));
  const fieldY = (when ?? top + markH) + (wordmark || clock ? FIELD.gap : 0);

  return {
    notch,
    controls: buttons,
    horizon,
    mark,
    when,
    field: {
      x: Math.round((width - fieldW) / 2),
      y: fieldY,
      w: fieldW,
      h: FIELD.height,
    },
  };
}
