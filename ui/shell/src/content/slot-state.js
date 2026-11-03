// Pure presentation state for the interim content slot (the surface the real
// `<browser>` sits in). The shell must never show the previous tab's page
// over a New Tab, and it must say "arriving" for as long as a page is, so the
// two flags are derived here and applied to the DOM by `Shell.svelte`.
//
// `hasPage`  — a real page owns the stage; without it the slot takes no space
//              and the app's own New Tab is what the person sees.
// `loading`  — the page is still arriving; the slot shows its own ground and
//              a quiet spinner instead of a blank browser layer.
//
// `null` means "this event says nothing about the slot"; the caller keeps the
// last painted flags.

/** A committed/requested address that is a page rather than a New Tab. */
export function isPageUrl(url) {
  return typeof url === "string" && url !== "" && url !== "about:blank";
}

const NO_PAGE = Object.freeze({ hasPage: false, loading: false });
const ARRIVING = Object.freeze({ hasPage: true, loading: true });
const SHOWING = Object.freeze({ hasPage: true, loading: false });

/**
 * Slot flags for one Host API event.
 *
 * @param {{type?: string, data?: object} | null | undefined} event
 * @returns {{hasPage: boolean, loading: boolean} | null}
 */
export function slotStateFor(event) {
  const type = event?.type;
  const data = event?.data;
  if (typeof type !== "string" || !data) {
    return null;
  }
  if (type === "nav.started") {
    return isPageUrl(data.url) ? ARRIVING : NO_PAGE;
  }
  if (type === "nav.committed") {
    return isPageUrl(data.url) ? SHOWING : NO_PAGE;
  }
  if (type === "items-changed") {
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    // A projection with no active tab is an empty space (or a window whose
    // last tab just closed). Nothing of the space we came from belongs on
    // the stage, so this is a New Tab, not "leave it as it was".
    const active = data.active ? tabs.find((tab) => tab?.id === data.active) : null;
    if (!active || !isPageUrl(active.url)) {
      return NO_PAGE;
    }
    return active.loading === true ? ARRIVING : SHOWING;
  }
  return null;
}
