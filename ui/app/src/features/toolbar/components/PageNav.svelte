<script lang="ts">
  import {
    ArrowLeft02Icon,
    ArrowRight02Icon,
    Home01Icon,
    Refresh01Icon,
  } from "@hugeicons/core-free-icons";
  import * as m from "$shared/i18n/messages";
  import { commands } from "$shared/ipc/bindings";
  import { tabHistory, tabHistoryGo } from "$shared/ipc/surfaces";
  import { openAt } from "$features/menus";
  import IconButton from "$shared/ui/IconButton";
  import { tabs } from "$domain/tabs";

  /**
   * The page's own controls: back, forward, reload and home.
   *
   * They stood in the content bar alone. The column draws the same group at
   * its head, so a page's navigation is part of the window's left edge
   * wherever the person is looking; both places mount this one component so
   * the disabled states and the history menus cannot drift apart.
   */
  let {
    buttonSize = 28,
    iconSize = 16,
    labels = true,
  }: {
    /** The plate each control sits on. The bar's row is 40px; the column's
     *  head is taller, so the same group can take a bigger plate. */
    buttonSize?: number;
    iconSize?: number;
    /** False where the group is announced by its own landmark instead. */
    labels?: boolean;
  } = $props();

  let active = $derived(tabs.activeTab());

  // A menu row shows a page, not a stack position; this many is enough to
  // reach back or ahead without turning the menu into a history browser.
  const HISTORY_ROWS = 15;

  // Back and Forward hold the pages behind and ahead. The rows come from the
  // engine's session history (`TabHistory`), so the titles are the ones the
  // pages really carry, and a choice jumps straight to that entry.
  async function openHistoryMenu(forward: boolean, anchor: DOMRect) {
    const id = tabs.activeId();
    if (!id) return;
    let view;
    try {
      view = await tabHistory(id);
    } catch {
      return;
    }
    const entries = Array.isArray(view?.entries) ? view.entries : [];
    const index = Number.isInteger(view?.index) ? view.index : -1;
    if (index < 0 || entries.length === 0) return;
    const rows = forward
      ? entries.slice(index + 1, index + 1 + HISTORY_ROWS)
      : entries.slice(Math.max(0, index - HISTORY_ROWS), index).reverse();
    if (rows.length === 0) return;
    const items = rows.map((entry, offset) => ({
      kind: "item" as const,
      id: String(forward ? index + 1 + offset : index - 1 - offset),
      label: entry.title || entry.url,
    }));
    openAt(
      { x: anchor.left, y: anchor.bottom, items },
      (choice) => void tabHistoryGo(id, Number(choice)).catch(() => {}),
    );
  }
</script>

<div class="page-nav" role="group" aria-label={labels ? m.ui_navigation() : undefined}>
  <IconButton
    icon={ArrowLeft02Icon}
    label={m.ui_back()}
    shape="rounded"
    {buttonSize}
    size={iconSize}
    disabled={active?.can_go_back !== true}
    onclick={tabs.backActive}
    onmenu={(anchor) => void openHistoryMenu(false, anchor)}
  />
  <IconButton
    icon={ArrowRight02Icon}
    label={m.ui_forward()}
    shape="rounded"
    {buttonSize}
    size={iconSize}
    disabled={active?.can_go_forward !== true}
    onclick={tabs.forwardActive}
    onmenu={(anchor) => void openHistoryMenu(true, anchor)}
  />
  <IconButton
    icon={Refresh01Icon}
    label={m.ui_reload()}
    shape="rounded"
    {buttonSize}
    size={iconSize}
    disabled={active === undefined}
    onclick={tabs.reloadActive}
  />
  <IconButton
    icon={Home01Icon}
    label={m.command_nav_home()}
    shape="rounded"
    {buttonSize}
    size={iconSize}
    disabled={active === undefined}
    onclick={() => void commands.runCommand("nav.home").catch(() => {})}
  />
</div>

<style>
  .page-nav {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }
</style>
