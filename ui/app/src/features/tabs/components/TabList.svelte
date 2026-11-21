<script lang="ts">
  import * as tabDrag from "$session/tab-drag.svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { collapseTabGroup } from "$shared/ipc/surfaces";
  import type { SidebarSectionView, TabView } from "$shared/ipc/bindings";
  import { tabs } from "$domain/tabs";
  import { preferences } from "$domain/preferences";
  import type { Snippet } from "svelte";
  import type { TabTileProps } from "../lib/tab-tile";
  import FolderRow from "./FolderRow.svelte";
  import {
    sidebarDisplayUnits,
    collapsedSidebarUnits,
    type SidebarEntry,
  } from "../lib/sidebar-model";
  import SplitGroupRow from "./SplitGroupRow.svelte";
  import TabRow from "./TabRow.svelte";
  import { untrack } from "svelte";
  import { ListMotion } from "$shared/lib/list-motion";
  import { RowDrag } from "$session/row-drag.svelte";
  import { favicons } from "$domain/favicons";
  import DragMark from "$shared/ui/DragMark";
  import * as notices from "$session/notice.svelte";
  import * as m from "$shared/i18n/messages";
  import { splitDropTarget } from "../lib/split-drop";

  let {
    entries,
    section,
    variant = "list",
    essentialTile,
    label,
    splitting,
    cascadeFrom = 0,
    columns,
    onSelect,
    activeId,
  }: {
    /** Lay the tiles out in rows of this many even columns, filling upwards. */
    columns?: number;
    /** Where this list's first row falls in the launch cascade. */
    cascadeFrom?: number;
    entries: SidebarEntry[];
    section: SidebarSectionView;
    variant?: "list" | "essentials";
    essentialTile?: Snippet<[TabTileProps]>;
    label: string;
    splitting: boolean;
    onSelect: (id: string) => void;
    /** Which row reads as the tab in front; null while a page tab is in front. */
    activeId?: string | null;
  } = $props();

  let inFront = $derived(activeId === undefined ? tabs.activeId() : activeId);

  let displayUnits = $derived(
    sidebarDisplayUnits(
      section,
      entries,
      tabs.splitGroup(),
      preferences.value("split.groups") !== "false",
      tabs.splitGroups(),
    ),
  );
  // The close-button choice is one setting for both the Today list and the
  // Essentials dock. `always` reveals the control on every closable row;
  // `hover` leaves the row's own rule in charge. Pinned/essential rows have
  // no close control at all (`closable` is only true for Today), so the
  // setting never invents a way to close a kept site.
  let closeButtons = $derived(preferences.value("tabs.close-button"));
  const folded = new SvelteSet<string>();
  let hiddenUnits = $derived(collapsedSidebarUnits(displayUnits, folded, inFront));
  // A collapsed native group hides its rows unless one of them owns the page
  // in front; the heading stays so it can be expanded again.
  let collapsedHidden = $derived.by(() => {
    const hidden = new SvelteSet<string>();
    if (preferences.value("split.group-collapse") !== "true") return hidden;
    let collapsed: string | null = null;
    for (const unit of displayUnits) {
      if (unit.kind === "group") {
        collapsed = unit.group.collapsed ? unit.group.id : null;
        continue;
      }
      if (collapsed === null) continue;
      if (unit.kind === "tab" && unit.tab.id !== inFront) hidden.add(unit.key);
      if (unit.kind === "split" && !unit.tabs.some((entry) => entry.tab.id === inFront)) {
        hidden.add(unit.key);
      }
    }
    return hidden;
  });

  /** Whether dragging one tab onto another can pair them. A tab already in
   *  another split cannot live in two, and a full split takes no more panes. */
  function canSplit(dragged: string, target: string): boolean {
    if (dragged === target) return false;
    const source = tabs.splitGroupFor(dragged);
    const other = tabs.splitGroupFor(target);
    if (source !== null && other !== null && source !== other) return false;
    const joining = source ?? other;
    if (joining === null) return true;
    const max = Number(preferences.value("split.max-panes")) || 3;
    return joining.members.length < max;
  }

  const drag = new RowDrag({
    list: () => list,
    region: () => list?.closest<HTMLElement>("[data-tabs-drop]") ?? undefined,
    // Only open tabs reorder in place; native places anything dropped in
    // this list among them.
    reorder: () => (variant === "list" && section === "today" ? { essential: false } : null),
    splitTarget: (id, over, x, y) =>
      splitDropTarget({
        dragged: id,
        over,
        x,
        y,
        enabled: preferences.value("split.drag-tab") !== "false",
        canJoin: (target) => canSplit(id, target),
      }),
    split: (id, target) => {
      void tabs.splitWith(id, target).catch(() => notices.show(m.split_failed()));
    },
    drop: ({ id, x, y, over, before }) => {
      // A split's tabs share one row, so they never reorder in place; let go
      // anywhere in the sidebar and the tab leaves its split for there.
      // A tab that cannot be kept goes back where it was.
      if (over?.closest("[data-essentials-drop]") && !tabDrag.keepable(id)) return;
      if (tabs.inSplit(id) && over?.closest("[data-essentials-drop], [data-tabs-drop]")) {
        const essential = !!over.closest("[data-essentials-drop]");
        void tabDrag.leaveSplit(id, essential || before ? { essential, before } : null);
        return;
      }
      if (over?.closest("[data-essentials-drop]")) {
        void tabDrag.move(id, true, before);
        return;
      }
      // Dropped on another tab without a split: with drag-to-split off this
      // is a no-op, not a page-edge split. A real reorder was already
      // committed above.
      if (section === "today" && over?.closest("[data-astra-tab-id]")) return;
      // Dropped among the open tabs from anywhere else: it joins them there.
      // Dropping onto a row does not pair the two; that is Split View's job,
      // from the menu or by dropping onto the page.
      if (over?.closest("[data-tabs-drop]") && section !== "today") {
        void tabDrag.move(id, false, before);
        return;
      }
      tabs.dropTab(id, x, y);
    },
  });
  const handlePointerDown = (event: PointerEvent, tab: TabView) => drag.down(event, tab.id);
  const handlePointerMove = (event: PointerEvent) => drag.move(event);
  const handlePointerUp = (event: PointerEvent) => drag.up(event);
  const handlePointerCancel = (event: PointerEvent) => drag.cancel(event);

  // Motion follows the list's shape, not its content: a title or a loading
  // state changing moves nothing, so only a change of order or membership
  // is measured at all.
  let list = $state<HTMLUListElement>();
  const motion = new ListMotion({ enter: () => (variant === "essentials" ? "grow" : "rise") });
  let shape = $derived(
    `${displayUnits.map((unit) => unit.key).join(" ")}|${[...hiddenUnits].join(" ")}`,
  );
  $effect.pre(() => {
    void shape;
    untrack(() => {
      motion.capture(list);
      // A drop's rows are held where they were drawn until the reordered
      // list arrives; the capture above has just recorded exactly that, so
      // the list's own motion lands them from there.
      drag.landed();
    });
  });
  $effect(() => {
    void shape;
    untrack(() => motion.play(list));
  });

  function toggleFolder(key: string) {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
  }

  function handleContextMenu(event: MouseEvent, tab: TabView) {
    // A DOM menu cannot reach past the chrome WebView, so the tab menu is a
    // real native popup owned by Rust.
    event.preventDefault();
    drag.abandon();
    tabs.openTabMenu(tab.id, event.clientX, event.clientY);
  }

  function select(id: string, event?: MouseEvent) {
    if (drag.swallowClick()) return;
    // Shift-click peeks without changing the page in front.
    if (event?.shiftKey) {
      import("$domain/peek").then(({ peek }) => {
        if (!peek.settings().trigger.includes("shift")) return;
        peek.open({ tab_id: id, source: "shift-click" });
      });
      return;
    }
    onSelect(id);
  }

  // A folded folder still shows as open while one of its own rows is shown;
  // only its subtree is looked at, which ends at the next row as shallow.
  function showsChild(position: number, depth: number): boolean {
    for (let next = position + 1; next < displayUnits.length; next++) {
      const child = displayUnits[next]!;
      if (child.depth <= depth) return false;
      if (!hiddenUnits.has(child.key)) return true;
    }
    return false;
  }
</script>

<!--
  Mounted even when empty, and hidden instead: the first site kept, or the
  first tab opened, is an arrival the list has to be present to see.
-->
<nav
  class={["tab-list", variant === "essentials" && "tab-list-flush"]}
  aria-label={label}
  hidden={entries.length === 0}
  data-close-buttons={closeButtons}
>
  <!-- The column reads as sections rather than as one unbroken stack; the
       label is visual only, because the nav already carries this name. -->
  {#if variant === "list"}
    <p class="tab-section" aria-hidden="true">{label}</p>
  {/if}
  <ul
    bind:this={list}
    class:flex={variant === "list"}
    class:dock-row={variant === "essentials" && columns === undefined}
    class:dock-stack={variant === "essentials" && columns !== undefined}
    style:--dock-columns={columns}
    class:flex-col={variant === "list"}
    class:tab-list-rows={variant === "list"}
    role="list"
  >
    {#each displayUnits as unit, index (unit.key)}
      {#if unit.kind === "folder"}
        <FolderRow
          motionKey={unit.key}
          expanded={!folded.has(unit.key) || showsChild(index, unit.depth)}
          ontoggle={() => toggleFolder(unit.key)}
          name={unit.node.kind.name}
          depth={unit.depth}
          class={[
            variant === "essentials" ? "col-span-full" : "",
            hiddenUnits.has(unit.key) || collapsedHidden.has(unit.key) ? "hidden" : "",
          ].join(" ")}
        />
      {:else if unit.kind === "group"}
        <li class="tab-group-row" data-motion-key={unit.key}>
          <button
            type="button"
            class="tab-group-head"
            data-group-id={unit.group.id}
            style:--group-color={unit.group.color ?? "var(--color-accent)"}
            aria-label={`${unit.group.collapsed ? "Expand" : "Collapse"} group ${unit.group.label || "tab group"}`}
            aria-expanded={!unit.group.collapsed}
            onclick={() =>
              void collapseTabGroup(unit.group.id, !unit.group.collapsed).catch(() => {})}
          >
            <span class="tab-group-dot" aria-hidden="true"></span>
            <span class="tab-group-name">{unit.group.label || "Tab group"}</span>
            {#if unit.group.collapsed}<span class="tab-group-state">collapsed</span>{/if}
          </button>
        </li>
      {:else if unit.kind === "separator"}
        <li class="tab-list-separator" aria-hidden="true"></li>
      {:else if unit.kind === "split"}
        <SplitGroupRow
          motionKey={unit.key}
          tabs={unit.tabs.map((entry) => entry.tab)}
          activeId={inFront}
          {splitting}
          closable={section === "today"}
          class={[
            variant === "essentials" ? "col-span-full" : "",
            hiddenUnits.has(unit.key) || collapsedHidden.has(unit.key) ? "hidden" : "",
          ].join(" ")}
          onSelect={select}
          onClose={tabs.close}
          onDetach={(id) => tabs.leaveSplit(id)}
          onContextMenu={handleContextMenu}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      {:else if variant === "essentials" && unit.depth === 0 && essentialTile}
        {@render essentialTile({
          tab: unit.tab,
          active: unit.tab.id === inFront,
          splitCandidate: splitting && unit.tab.id !== inFront,
          onSelect: select,
          onContextMenu: handleContextMenu,
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerCancel,
        })}
      {:else}
        <TabRow
          cascade={cascadeFrom + index}
          tab={unit.tab}
          active={unit.tab.id === inFront}
          depth={unit.depth}
          closable={section === "today" && !tabs.loneNewTab(unit.tab.id)}
          class={[
            variant === "essentials" ? "col-span-full" : "",
            hiddenUnits.has(unit.key) || collapsedHidden.has(unit.key) ? "hidden" : "",
          ].join(" ")}
          splitCandidate={splitting && unit.tab.id !== inFront}
          autoPeek={section === "favorites"}
          onSelect={select}
          onClose={tabs.close}
          onContextMenu={handleContextMenu}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      {/if}
    {/each}
  </ul>
</nav>

{#if drag.ghost !== null}{@const held = tabs
    .tabs()
    .find((tab) => tab.id === drag.ghost?.id)}<DragMark
    x={drag.ghost.x}
    y={drag.ghost.y}
    image={favicons.image(held?.icon)}
    tone={favicons.tone(held?.icon)}
    title={held?.title}
  />{/if}

<style>
  .tab-list {
    padding-inline: var(--tab-inset);
    padding-block: var(--tab-gap);
  }

  .tab-section {
    margin: 0;
    padding-inline: var(--tab-inset);
    padding-block-end: var(--tab-gap);
    color: var(--color-faint);
    font-size: var(--text-label);
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1.4;
  }

  /* The dock owns the band's inset, so its site row adds none of its own. */
  .tab-list-flush {
    padding: 0;
  }

  /* The row beside the shelf: its sites share its width, so one alone
     fills it. The caller hands it only as many as fit. */
  .dock-row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: var(--dock-gap);
  }

  /* Rows over the shelf's row: even columns, and wrapping upwards, so a row
     that is not yet full sits on top as a ragged edge rather than leaving a
     hole in the middle of the stack. */
  .dock-stack {
    display: flex;
    flex-wrap: wrap-reverse;
    gap: var(--dock-gap);
  }

  .dock-stack > :global(li) {
    flex: 0 0 calc((100% - (var(--dock-columns) - 1) * var(--dock-gap)) / var(--dock-columns));
  }

  /* One pixel between rows read as a stack of stripes rather than a list. */
  .tab-list-rows {
    gap: var(--tab-gap);
  }

  /* A native tab-group heading: small, coloured and quiet, so the group is
     legible without becoming a second tab strip. */
  .tab-group-row {
    list-style: none;
  }

  /* The split cards are their own section; this line is the boundary before
     the ordinary single-tab rows. */
  .tab-list-separator {
    block-size: 1px;
    margin: 7px 6px 6px;
    background: var(--color-border);
    list-style: none;
  }

  .tab-group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    inline-size: 100%;
    min-block-size: 20px;
    padding: 4px 8px 1px;
    border: 0;
    background: transparent;
    color: var(--color-faint);
    font: inherit;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-align: start;
    text-transform: uppercase;
    cursor: pointer;
  }

  .tab-group-head:hover,
  .tab-group-head:focus-visible {
    color: var(--color-label-secondary);
  }

  .tab-group-dot {
    inline-size: 7px;
    block-size: 7px;
    border-radius: 999px;
    background: var(--group-color, var(--color-accent));
    flex: none;
  }

  .tab-group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-group-state {
    margin-inline-start: auto;
    color: var(--color-faint);
    font-size: 9px;
    letter-spacing: 0.02em;
    text-transform: none;
  }
</style>
