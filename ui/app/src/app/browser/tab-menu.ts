import { openAt } from "$features/menus";
import { tabs } from "$domain/tabs";
import { commands } from "$shared/ipc/bindings";
import {
  cloneTabToSpace,
  collapseTabGroup,
  createTabGroup,
  splitSaveArrangement,
  ungroupTabs,
} from "$shared/ipc/surfaces";
import { peek } from "$domain/peek";
import { preferences } from "$domain/preferences";
import { clearRequest } from "$domain/site-data";
import * as notices from "$session/notice.svelte";
import * as m from "$shared/i18n/messages";

/** The shape `openAt` accepts, so the rows are checked against the renderer. */
type MenuItems = Parameters<typeof openAt>[0]["items"];

/**
 * The window's tab menu. `tab_menu_popup` had no host route in this build, so
 * right-clicking a tab asked for a native menu that never opened. The app now
 * draws it with the same menu system as everything else; every row has a real
 * caller in the tab projection.
 */
function present(id: string, x: number, y: number, mediaOnly: boolean) {
  const tab = tabs.tabs().find((candidate) => candidate.id === id);
  if (!tab) return;
  if (mediaOnly) {
    if (!tab.audio?.can_mute) return;
    const muted = tab.audio.muted;
    openAt(
      {
        x,
        y,
        items: [
          {
            kind: "item",
            id: "tab.mute",
            label: muted ? m.native_unmute_tab() : m.native_mute_tab(),
          },
        ],
      },
      () => void tabs.setMuted(id, !muted),
    );
    return;
  }

  const url = tab.url;
  const page = (tab.content ?? "web") === "web" && url !== null;
  const kept = tabs.isKept(id);
  const muted = tab.audio?.muted ?? false;
  const others = tabs.profileSpaces().filter((space) => space.id !== tabs.activeSpaceId());
  const rows: MenuItems = [
    { kind: "item", id: "tab.new", label: m.native_new_tab() },
    ...(page
      ? [
          { kind: "item" as const, id: "tab.reload", label: m.native_reload_tab() },
          { kind: "item" as const, id: "tab.preview", label: "Preview" },
          { kind: "item" as const, id: "tab.copyLink", label: m.native_copy_link() },
        ]
      : []),
    // The host has had `Tabs.duplicate` all along; without a row the only
    // caller was a probe. A split pane's own row is fine: the copy is a new
    // tab beside the view, not a third pane.
    { kind: "item", id: "tab.duplicate", label: m.native_duplicate_tab() },
    { kind: "separator" },
    {
      kind: "item",
      id: "tab.keep",
      label: kept ? m.native_remove_from_essentials() : m.native_add_to_essentials(),
    },
    ...(tabs.canSplitWith(id) && !tabs.inSplit(id)
      ? [{ kind: "item" as const, id: "tab.split", label: m.native_open_in_split_view() }]
      : []),
    ...(tabs.inSplit(id)
      ? [
          { kind: "item" as const, id: "tab.replacePane", label: "Replace This Pane…" },
          { kind: "item" as const, id: "tab.leaveSplit", label: "Remove from Split View" },
          // End/Save act on the split in front; on a tab whose split is parked
          // behind another tab they would end the wrong view.
          ...(tabs.splitMembers().includes(id)
            ? [
                { kind: "item" as const, id: "tab.unsplit", label: "End Split View" },
                { kind: "item" as const, id: "tab.saveSplit", label: "Save Split Arrangement…" },
              ]
            : []),
        ]
      : []),
    ...(tab.group
      ? [
          {
            kind: "item" as const,
            id: "tab.groupCollapse",
            label: tab.group.collapsed ? "Expand Group" : "Collapse Group",
          },
          { kind: "item" as const, id: "tab.ungroup", label: "Remove from Group" },
        ]
      : tabs.canSplitWith(id)
        ? [{ kind: "item" as const, id: "tab.group", label: "Group with This Tab" }]
        : []),
    ...(tab.audio?.can_mute
      ? [
          {
            kind: "item" as const,
            id: "tab.mute",
            label: muted ? m.native_unmute_tab() : m.native_mute_tab(),
          },
        ]
      : []),
    ...(others.length > 0
      ? [
          { kind: "separator" as const },
          { kind: "heading" as const, label: m.native_move_to_space() },
          ...others.map((space) => ({
            kind: "item" as const,
            id: `tab.move.${space.id}`,
            label: space.name,
          })),
          { kind: "heading" as const, label: "Clone to space" },
          ...others.map((space) => ({
            kind: "item" as const,
            id: `tab.clone.${space.id}`,
            label: space.name,
          })),
        ]
      : []),
    ...(page && tabs.profile()?.kind !== "incognito"
      ? [
          {
            kind: "item" as const,
            id: "tab.clearData",
            label: m.native_clear_data_for_this_site_more(),
          },
        ]
      : []),
    ...(tabs.loneNewTab(id)
      ? []
      : [
          { kind: "separator" as const },
          { kind: "item" as const, id: "tab.close", label: m.native_close_tab(), danger: true },
        ]),
  ];
  openAt({ x, y, items: rows }, (choice) => {
    if (choice === "tab.new") tabs.open();
    else if (choice === "tab.reload") tabs.reloadTab(id);
    else if (choice === "tab.preview") void peek.open({ tab_id: id, source: "menu" });
    else if (choice === "tab.copyLink")
      void tabs.copyLinkFor(id).then((copied) => {
        if (copied) notices.show(m.notice_link_copied());
      });
    else if (choice === "tab.keep") void tabs.setKept(id, !kept);
    else if (choice === "tab.duplicate") {
      // The command duplicates the tab in front of this window, so put this
      // row's tab in front first: the two relay calls reach the host in that
      // order, and a refusal must not look like a copy that was never made.
      tabs.activate(id);
      void commands.runCommand("tab.duplicate").then(
        (admission) => {
          if (!admission?.accepted) notices.show("This tab could not be duplicated");
        },
        () => notices.show("This tab could not be duplicated"),
      );
    } else if (choice === "tab.split") tabs.split(id);
    else if (choice === "tab.replacePane") tabs.beginReplace(id);
    else if (choice === "tab.group")
      void createTabGroup(id).catch(() => notices.show("The tabs could not be grouped"));
    else if (choice === "tab.ungroup" && tab.group)
      void ungroupTabs(tab.group.id).catch(() => notices.show("The group could not be dissolved"));
    else if (choice === "tab.groupCollapse" && tab.group)
      void collapseTabGroup(tab.group.id, !tab.group.collapsed).catch(() => {});
    else if (choice === "tab.leaveSplit") tabs.leaveSplit(id);
    else if (choice === "tab.unsplit") tabs.unsplit();
    else if (choice === "tab.saveSplit")
      void splitSaveArrangement("").then(
        () => notices.show("Split arrangement saved"),
        () => notices.show("Could not save this split arrangement"),
      );
    else if (choice === "tab.mute") void tabs.setMuted(id, !muted);
    else if (choice === "tab.clearData") clearRequest.ask(url);
    else if (choice === "tab.close") tabs.close(id);
    else if (choice.startsWith("tab.move."))
      void tabs.moveTabToSpace(id, choice.slice("tab.move.".length));
    else if (choice.startsWith("tab.clone.")) {
      const space = choice.slice("tab.clone.".length);
      void cloneTabToSpace(
        id,
        space,
        preferences.value("tabs.clone-history") === "true",
        preferences.value("tabs.clone-background") === "true",
      ).then(
        () =>
          notices.show(
            `Cloned to ${tabs.profileSpaces().find((row) => row.id === space)?.name ?? "space"}`,
          ),
        () => notices.show("That tab could not be cloned"),
      );
    }
  });
}

/** Registers this window's presenter; called once by the shell on mount. */
export function installTabMenuPresenter(): () => void {
  return tabs.installTabMenu(present);
}
