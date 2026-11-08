import type { TabView } from "$shared/ipc/bindings";
import * as m from "$shared/i18n/messages";
import type { PageTab } from "$domain/surface";

/** The synthetic tab ids page tabs carry; native tabs never use this shape. */
const PAGE_TAB_PREFIX = "astra-page:";

function pageTabId(kind: PageTab): string {
  return `${PAGE_TAB_PREFIX}${kind}`;
}

/**
 * The tab row a browser page wears. It is not a native tab: the page stays a
 * chrome surface, but the row gives it the same place in the list so choosing
 * another tab leaves it and choosing it again brings it back.
 */
export function pageTabView(kind: PageTab): TabView {
  return {
    id: pageTabId(kind),
    projection_revision: "0000000000000000",
    title: kind === "settings" ? m.settings_title() : m.webext_page_title(),
    url: null,
    content: kind,
    loading: false,
    can_go_back: false,
    can_go_forward: false,
    icon: null,
  };
}
