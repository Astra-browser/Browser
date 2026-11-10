<script lang="ts">
  import type { Snippet } from "svelte";
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

  // The bar belongs to the content column, not the sidebar: it stands above
  // the page and carries the page's own controls. The field itself is the
  // product's one address field, composed by the app and placed here; this
  // wrapper never restyles it.
  let { field }: { field: Snippet } = $props();

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

<div class="content-bar" data-content-bar>
  <div class="content-bar-nav" role="group" aria-label={m.ui_navigation()}>
    <IconButton
      icon={ArrowLeft02Icon}
      label={m.ui_back()}
      shape="rounded"
      buttonSize={28}
      size={16}
      disabled={active?.can_go_back !== true}
      onclick={tabs.backActive}
      onmenu={(anchor) => void openHistoryMenu(false, anchor)}
    />
    <IconButton
      icon={ArrowRight02Icon}
      label={m.ui_forward()}
      shape="rounded"
      buttonSize={28}
      size={16}
      disabled={active?.can_go_forward !== true}
      onclick={tabs.forwardActive}
      onmenu={(anchor) => void openHistoryMenu(true, anchor)}
    />
    <IconButton
      icon={Refresh01Icon}
      label={m.ui_reload()}
      shape="rounded"
      buttonSize={28}
      size={16}
      disabled={active === undefined}
      onclick={tabs.reloadActive}
    />
    <IconButton
      icon={Home01Icon}
      label={m.command_nav_home()}
      shape="rounded"
      buttonSize={28}
      size={16}
      disabled={active === undefined}
      onclick={() => void commands.runCommand("nav.home").catch(() => {})}
    />
  </div>
  <div class="content-bar-field">{@render field()}</div>
</div>

<style>
  /* The bar is the page's own band: the window ground shows through, and only
     the controls stand on it. It never takes the page's room, so the card
     below it keeps the column's whole width. */
  .content-bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    block-size: var(--main-bar-height);
    padding-inline: var(--main-bar-inset);
    min-inline-size: 0;
  }

  .content-bar-nav {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }

  /* The field keeps its own shape; the wrapper only says where it stands and
     how wide it may grow. It is a block so the field's own form fills the
     width, as it did in the column. The frozen field carries an 8px trailing
     gap for the store card it can show below itself; cancelling it here
     centres the 34px field in the 40px bar without touching the field. */
  .content-bar-field {
    display: block;
    flex: 1 1 auto;
    min-inline-size: 0;
    max-inline-size: 720px;
    margin-inline: auto;
    margin-block-end: calc(-1 * var(--main-bar-inset));
  }

  @media (forced-colors: active) {
    .content-bar {
      border-block-end: 1px solid CanvasText;
    }
  }
</style>
