/**
 * A chrome window created by a page's `window.open` with features is a popup,
 * not a browser window. Firefox already answered it with a reduced chrome
 * (titlebar, optional URL bar, requested size) and it closes itself when the
 * page calls `window.close()`.
 *
 * The shell must not mount in such a window: the product chrome (column, tab
 * row, address field) belongs to a browser window. The engine marks the
 * removed parts on the root's `chromehidden` attribute, and a popup always
 * hides its toolbar.
 *
 * A normal Astra window has `chromehidden` present but empty, and its toolbar
 * is visible, so both signals stay false there.
 */
export function isPopupWindow(win) {
  try {
    if (!win || win.closed === true) {
      return false;
    }
    if (win.toolbar && win.toolbar.visible === false) {
      return true;
    }
    const root = win.document?.documentElement;
    const hidden = String(root?.getAttribute("chromehidden") ?? "");
    return /(^|\s)(toolbar|location)(\s|$)/u.test(hidden);
  } catch {
    return false;
  }
}

/** Marks the document so the static chrome CSS can reveal the native popup. */
export const POPUP_ATTRIBUTE = "data-astra-popup";
