// P4 stage dock: the native tabbrowser panel is positioned over the Astra
// content slot. Pure geometry/state helpers so the shell and tests agree.
//
// The native panel is not reparented: `#tabbrowser-tabbox` stays where
// gBrowser owns it and is absolutely positioned over the slot's rectangle.

export function stageRectOf(slot) {
  let rect = null;
  try {
    rect = slot?.getBoundingClientRect?.() ?? null;
  } catch {
    rect = null;
  }
  if (!rect) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.max(0, Math.round(rect.width)),
    h: Math.max(0, Math.round(rect.height)),
  };
}

/**
 * `app`     no page in the stage, an internal Astra surface, or not booted
 * `loading` a page is arriving; the native panel stays hidden
 * `page`    a committed page owns the stage; the native panel is visible
 */
export function stageStateFor({ booted = false, hasPage = false, loading = false, internal = false } = {}) {
  if (booted !== true || internal === true || hasPage !== true) {
    return "app";
  }
  return loading === true ? "loading" : "page";
}

/** CSS variables the chrome stylesheet reads for the docked panel. */
export function stageStyle(rect) {
  return {
    "--astra-stage-x": `${rect.x}px`,
    "--astra-stage-y": `${rect.y}px`,
    "--astra-stage-w": `${rect.w}px`,
    "--astra-stage-h": `${rect.h}px`,
  };
}
