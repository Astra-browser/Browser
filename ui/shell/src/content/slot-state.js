// Pure presentation state for the interim content slot (the surface the real
// `<browser>` sits in). The shell must never show the previous tab's page
// over a New Tab, and it must say "arriving" for as long as a page is, so the
// two flags are derived here and applied to the DOM by `Shell.svelte`.
//
// `hasPage`  — a real page owns the stage; without it the slot takes no space
//              and the app's own New Tab is what the person sees.
// `loading`  — the page is still arriving; the slot covers it with its own
//              ground, a skeleton and a quiet spinner instead of a blank
//              browser layer.
//
// The cover ends at the **commit**, not at the end of the load. A committed
// document is already in front and painting; a page that keeps fetching
// images, fonts or analytics for seconds must not stay hidden behind the
// skeleton until the last byte lands. The tab's own `loading` flag (the row
// spinner, the stop button) keeps telling the truth for the whole document.
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
 * `options.activeId` is the tab the stage currently shows. Navigation events
 * for any other tab (a background tab restoring, a second tab loading) say
 * nothing about what is in front, so they are ignored rather than flipping the
 * stage to "arriving" over the page the person is reading.
 *
 * `options.committedUrl` / `options.committedId` are the address and tab the
 * stage has already committed (the shell records them from a real document
 * commit, and clears them on `nav.started`). A projection that still reports
 * `loading: true` for that same address is the rest of an already-visible
 * document; it must not put the cover back over the page.
 *
 * @param {{type?: string, data?: object} | null | undefined} event
 * @param {{activeId?: string | null, committedId?: string | null, committedUrl?: string | null}} [options]
 * @returns {{hasPage: boolean, loading: boolean} | null}
 */
export function slotStateFor(event, { activeId = null, committedId = null, committedUrl = null } = {}) {
  const type = event?.type;
  const data = event?.data;
  if (typeof type !== "string" || !data) {
    return null;
  }
  if (type === "nav.started" || type === "nav.committed") {
    const id = data.astra_tab_id;
    if (typeof id === "string" && typeof activeId === "string" && activeId !== "" && id !== activeId) {
      return null;
    }
  }
  if (type === "nav.started") {
    return isPageUrl(data.url) ? ARRIVING : NO_PAGE;
  }
  if (type === "nav.committed") {
    // Two commits per navigation. The model commits the address the moment
    // the person asks for it (no `external`: the document is not in front
    // yet), and the content binding reports the document actually taking the
    // stage (`external: true`, raised by the progress listener). Only the
    // second one is a first paint, so the model's own commit says nothing
    // about the cover and an address-bar load keeps its skeleton.
    if (data.external !== true) {
      return null;
    }
    return isPageUrl(data.url) ? SHOWING : NO_PAGE;
  }
  if (type === "items-changed") {
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    // A projection with no active tab is an empty space (or a window whose
    // last tab just closed). Nothing of the space we came from belongs on
    // the stage, so this is a New Tab, not "leave it as it was".
    const active = data.active ? tabs.find((tab) => tab?.id === data.active) : null;
    // A failed page stands in place of the page: the engine's own error panel
    // must not cover the app's interstitial.
    if (active?.failure?.covers_page === true) {
      return NO_PAGE;
    }
    if (!active || !isPageUrl(active.url)) {
      return NO_PAGE;
    }
    // Committed, still fetching subresources: the page is what the person is
    // looking at, so the cover stays down.
    const committed =
      typeof committedUrl === "string" &&
      committedUrl !== "" &&
      active.url === committedUrl &&
      (committedId === null || committedId === "" || committedId === active.id);
    if (committed) {
      return SHOWING;
    }
    return active.loading === true ? ARRIVING : SHOWING;
  }
  return null;
}
