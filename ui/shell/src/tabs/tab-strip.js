// P3-T04 shell tab strip renderer (chrome). Imperative XHTML-namespaced DOM
// like `../urlbar.js`: Svelte templates cannot carry <button>/<input> in a
// chrome XUL document (the sanitizer strips them), so plain DOM calls with
// `createElementNS` sidestep that entirely.
//
// Driven only by the injected Host API (`{ Tabs, addEventListener }`, from
// `../host.js`'s `loadHost()` seam in production, a fake in tests); all
// grouping math lives in `./tab-strip-model.js`. Folder assignment and
// collapse persist in the provided storage (localStorage in chrome).
import {
  assignToFolder,
  blankFolders,
  createFolder,
  deleteFolder,
  fallbackLetter,
  globalDropIndex,
  groupRows,
  isCollapsed,
  loadFolderState,
  menuItems,
  normalizeHostTab,
  renameFolder,
  saveFolderState,
  splitSections,
  toggleFolder,
} from "./tab-strip-model.js";
import { newRequestId } from "../host.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function el(doc, tag, cls, text) {
  const node = doc.createElementNS(XHTML_NS, tag);
  if (cls) node.setAttribute("class", cls);
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(doc, text) {
  const header = el(doc, "div", "astra-tabs-title");
  header.setAttribute("role", "heading");
  header.setAttribute("aria-level", "2");
  header.textContent = text;
  return header;
}

export function mountTabStrip(container, host, options = {}) {
  const doc = container.ownerDocument;
  // NOTE: even `typeof localStorage` can throw NS_ERROR_NOT_AVAILABLE in a
  // chrome window without DOM storage (headless). Never touch it unguarded.
  let storage = options.storage ?? null;
  if (storage === null || storage === undefined) {
    try {
      storage = typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      storage = null;
    }
  }
  const makeId =
    options.makeId ??
    (() => `folder-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  let folders = loadFolderState(storage);
  let tabs = [];
  let disposed = false;
  let activeMenu = null;
  /** The one document listener an open menu owns; null when none is open. */
  let dismissMenu = null;
  let dragId = null;

  const persist = () => saveFolderState(storage, folders);

  const root = el(doc, "div", "astra-tabs");
  root.setAttribute("data-astra-tabs", "");
  root.setAttribute("role", "navigation");
  root.setAttribute("aria-label", "Tabs");
  container.append(root);

  // Every menu owns exactly one document listener, and closing the menu is
  // what releases it. Leaving the listener behind (the old behaviour) leaked
  // one per keyboard-opened menu and outlived `destroy`.
  function closeMenu() {
    activeMenu?.remove();
    activeMenu = null;
    if (dismissMenu) {
      doc.removeEventListener("pointerdown", dismissMenu, true);
      doc.removeEventListener("keydown", dismissMenu, true);
      dismissMenu = null;
    }
  }

  function requestId() {
    try {
      return newRequestId();
    } catch {
      return `req-${Date.now()}`;
    }
  }

  async function refresh() {
    if (disposed) return;
    try {
      const list = await host.Tabs.list({ request_id: requestId() });
      if (disposed) return;
      tabs = (list.tabs ?? []).map(normalizeHostTab).filter((tab) => tab !== null);
      paint();
    } catch {
      // Host gone (window teardown): leave last state painted.
    }
  }

  function paint() {
    closeMenu();
    root.replaceChildren();
    const { pinned, open } = splitSections(tabs);
    const activeId = tabs.find((tab) => tab.selected)?.id ?? null;
    if (pinned.length > 0) {
      root.append(sectionTitle(doc, "Pinned"));
      for (const tab of pinned) root.append(row(tab, "pinned"));
      const divider = el(doc, "div", "astra-tabs-divider");
      divider.setAttribute("aria-hidden", "true");
      root.append(divider);
    }
    for (const unit of groupRows(open, folders, activeId)) {
      if (unit.kind === "folder") root.append(folderRow(unit));
      else root.append(row(unit.tab, "open"));
    }
    const opener = el(doc, "button", "astra-tabs-new", "New tab");
    opener.type = "button";
    opener.setAttribute("aria-label", "New tab");
    opener.addEventListener("click", () => {
      void host.Tabs.create({ request_id: requestId(), url: "about:blank" }).then(() => refresh());
    });
    root.append(opener);
  }

  function favicon(tab, into) {
    if (tab.favIconUrl) {
      const img = el(doc, "img", "astra-tabs-favicon");
      img.src = tab.favIconUrl;
      img.alt = "";
      img.draggable = false;
      img.addEventListener("error", () => img.replaceWith(letterTile(tab)));
      into.append(img);
    } else {
      into.append(letterTile(tab));
    }
  }

  function letterTile(tab) {
    return el(doc, "span", "astra-tabs-letter", fallbackLetter(tab));
  }

  function row(tab, section) {
    const item = el(doc, "div", `astra-tabs-row${tab.selected ? " is-selected" : ""}`);
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-label", tab.title || "Untitled tab");
    item.setAttribute("aria-current", tab.selected ? "page" : "false");
    item.dataset.tabId = tab.id;
    item.draggable = true;

    favicon(tab, item);
    const label = el(doc, "span", "astra-tabs-label", tab.title || "Untitled tab");
    item.append(label);

    if (tab.muted) {
      const mute = el(doc, "button", "astra-tabs-mute", tab.selected ? "" : "M");
      mute.type = "button";
      mute.title = "Unmute tab";
      mute.setAttribute("aria-label", "Unmute tab");
      mute.addEventListener("click", (event) => {
        event.stopPropagation();
        void host.Tabs.setMuted({ request_id: requestId(), astra_tab_id: tab.id, muted: false }).then(
          () => refresh(),
        );
      });
      item.append(mute);
    }

    if (tab.sleeping) {
      const badge = el(doc, "button", "astra-tabs-sleeping", "Sleeping");
      badge.type = "button";
      badge.title = "Sleeping tab — activate to wake it";
      badge.setAttribute("aria-label", `Sleeping tab ${tab.title || "untitled"}, activate to wake`);
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        void host.Tabs.wakeup({ request_id: requestId(), astra_tab_id: tab.id })
          .catch(() => host.Tabs.select({ request_id: requestId(), astra_tab_id: tab.id }))
          .then(() => refresh());
      });
      item.append(badge);
    }

    if (section === "open") {
      const close = el(doc, "button", "astra-tabs-close", "×");
      close.type = "button";
      close.title = "Close tab";
      close.setAttribute("aria-label", `Close tab ${tab.title || "untitled"}`);
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void host.Tabs.close({ request_id: requestId(), astra_tab_id: tab.id }).then(() => refresh());
      });
      item.append(close);
    }

    item.addEventListener("click", () => {
      void host.Tabs.select({ request_id: requestId(), astra_tab_id: tab.id }).then(() => refresh());
    });
    // Rows are role=button, so they owe keyboard activation. The context menu
    // key (and Shift+F10) opens the same menu the pointer does.
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void host.Tabs.select({ request_id: requestId(), astra_tab_id: tab.id }).then(() => refresh());
      } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        let x = 0;
        let y = 0;
        try {
          const box = item.getBoundingClientRect?.();
          if (box) {
            x = box.left + 8;
            y = box.bottom;
          }
        } catch {
          // No layout here: the menu still opens at the origin.
        }
        openMenu(tab, x, y);
      }
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(tab, event.clientX, event.clientY);
    });
    item.addEventListener("dragstart", (event) => {
      dragId = tab.id;
      event.dataTransfer?.setData("text/x-astra-tab", tab.id);
    });
    item.addEventListener("dragend", () => {
      dragId = null;
    });
    item.addEventListener("dragover", (event) => {
      if (!dragId || dragId === tab.id) return;
      event.preventDefault();
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      const id = dragId ?? event.dataTransfer?.getData("text/x-astra-tab");
      if (!id || id === tab.id) return;
      const { pinned, open } = splitSections(tabs);
      const index = globalDropIndex({ pinned, open }, id, tab.id);
      void host.Tabs.move({ request_id: requestId(), astra_tab_id: id, index }).then(() => refresh());
    });
    return item;
  }

  function folderRow(unit) {
    const { folder, children, expanded } = unit;
    const wrap = el(doc, "div", "astra-tabs-folder");
    const head = el(doc, "button", "astra-tabs-folder-head", `${expanded ? "▾" : "▸"} ${folder.name}`);
    head.type = "button";
    head.setAttribute("aria-expanded", String(expanded));
    head.addEventListener("click", () => {
      folders = toggleFolder(folders, folder.id);
      persist();
      paint();
    });
    head.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openFolderMenu(folder, event.clientX, event.clientY);
    });
    head.addEventListener("dragover", (event) => {
      if (dragId) event.preventDefault();
    });
    head.addEventListener("drop", (event) => {
      event.preventDefault();
      const id = dragId ?? event.dataTransfer?.getData("text/x-astra-tab");
      if (!id) return;
      folders = assignToFolder(folders, id, folder.id);
      persist();
      paint();
    });
    wrap.append(head);
    if (expanded) {
      for (const tab of children) wrap.append(row(tab, "open"));
    } else if (children.length > 0) {
      const count = el(doc, "span", "astra-tabs-folder-count", `${children.length}`);
      count.title = `${children.length} tabs`;
      wrap.append(count);
    }
    return wrap;
  }

  function menu(x, y, items, onPick) {
    closeMenu();
    const popup = el(doc, "div", "astra-tabs-menu");
    popup.setAttribute("role", "menu");
    for (const item of items) {
      if (item.id === "separator") {
        popup.append(el(doc, "div", "astra-tabs-menu-separator"));
        continue;
      }
      const entry = el(doc, "button", "astra-tabs-menu-item", item.label);
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      entry.disabled = !!item.disabled;
      entry.addEventListener("click", () => {
        closeMenu();
        onPick(item.id);
      });
      popup.append(entry);
    }
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
    doc.body.append(popup);
    activeMenu = popup;
    try {
      // Keep the menu inside the window: a row near the bottom edge would
      // otherwise open a menu that runs off it.
      const view = doc.defaultView ?? null;
      const box = popup.getBoundingClientRect?.();
      const maxX = (view?.innerWidth ?? 0) - (box?.width ?? 0) - 4;
      const maxY = (view?.innerHeight ?? 0) - (box?.height ?? 0) - 4;
      if (box && maxX > 0 && x > maxX) popup.style.left = `${maxX}px`;
      if (box && maxY > 0 && y > maxY) popup.style.top = `${maxY}px`;
    } catch {
      // Not measurable here; the requested corner still places it.
    }
    const dismiss = (event) => {
      if (event.type === "keydown") {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeMenu();
        return;
      }
      if (!popup.contains(event.target)) {
        closeMenu();
      }
    };
    dismissMenu = dismiss;
    doc.addEventListener("pointerdown", dismiss, true);
    doc.addEventListener("keydown", dismiss, true);
    try {
      popup
        .querySelector?.("[role='menuitem']:not([disabled])")
        ?.focus?.();
    } catch {
      // Focus is an enhancement; the pointer path still works.
    }
    return popup;
  }

  function openMenu(tab, x, y) {
    const popup = menu(x, y, menuItems(tab), (id) => void runTabAction(tab, id));
    {
      const sep = el(doc, "div", "astra-tabs-menu-separator");
      popup.append(sep);
      for (const folder of folders.folders) {
        const entry = el(doc, "button", "astra-tabs-menu-item", `Move to ${folder.name}`);
        entry.type = "button";
        entry.setAttribute("role", "menuitem");
        entry.addEventListener("click", () => {
          closeMenu();
          folders = assignToFolder(folders, tab.id, folder.id);
          persist();
          paint();
        });
        popup.append(entry);
      }
      const fresh = el(doc, "button", "astra-tabs-menu-item", "Move to new folder");
      fresh.type = "button";
      fresh.setAttribute("role", "menuitem");
      fresh.addEventListener("click", () => {
        closeMenu();
        folders = createFolder(folders, `Folder ${folders.folders.length + 1}`, makeId);
        folders = assignToFolder(folders, tab.id, folders.folders[folders.folders.length - 1].id);
        persist();
        paint();
      });
      popup.append(fresh);
      if (folderOf(tab)) {
        const out = el(doc, "button", "astra-tabs-menu-item", "Remove from folder");
        out.type = "button";
        out.setAttribute("role", "menuitem");
        out.addEventListener("click", () => {
          closeMenu();
          folders = assignToFolder(folders, tab.id, null);
          persist();
          paint();
        });
        popup.append(out);
      }
    }
  }

  function folderOf(tab) {
    const folderId = folders.assignment[tab.id];
    return folders.folders.find((folder) => folder.id === folderId) ?? null;
  }

  function openFolderMenu(folder, x, y) {
    menu(x, y, [{ id: "rename", label: `Rename ${folder.name}` }, { id: "delete", label: "Delete folder" }], (id) => {
      if (id === "delete") {
        folders = deleteFolder(folders, folder.id);
        persist();
        paint();
      } else {
        inlineRename(folder);
      }
    });
  }

  function inlineRename(folder) {
    closeMenu();
    folders = renameFolder(folders, folder.id, `${folder.name}`);
    const heads = root.querySelectorAll(".astra-tabs-folder-head");
    const head = [...heads].find((node) => node.textContent?.includes(folder.name)) ?? null;
    if (!head) return;
    const input = el(doc, "input", "astra-tabs-rename");
    input.value = folder.name;
    input.setAttribute("aria-label", "Folder name");
    head.replaceWith(input);
    input.focus();
    input.select();
    // Enter commits and `paint()` removes the field, which fires `blur`; the
    // second commit must not repaint and re-persist the same rename.
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) {
        folders = renameFolder(folders, folder.id, input.value.trim());
        persist();
      }
      paint();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit(true);
      else if (event.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  async function runTabAction(tab, id) {
    const req = { request_id: requestId(), astra_tab_id: tab.id };
    try {
      switch (id) {
        case "activate":
          await host.Tabs.select(req);
          break;
        case "close":
          await host.Tabs.close(req);
          break;
        case "pin":
          await host.Tabs.pin(req);
          break;
        case "unpin":
          await host.Tabs.unpin(req);
          break;
        case "mute":
          await host.Tabs.setMuted({ ...req, muted: true });
          break;
        case "unmute":
          await host.Tabs.setMuted({ ...req, muted: false });
          break;
        case "duplicate":
          await host.Tabs.duplicate(req);
          break;
        case "discard":
          await host.Tabs.discard(req);
          break;
        case "wakeup":
          await host.Tabs.wakeup(req);
          break;
        case "copy-link":
          if (tab.url) {
            const clipboard = container.ownerDocument.defaultView?.navigator?.clipboard;
            await clipboard?.writeText(tab.url);
          }
          return;
        default:
          return;
      }
    } catch {
      // A refused action leaves the last painted state; the next host
      // event resynchronizes the strip.
    }
    await refresh();
  }

  const off = host.addEventListener((event) => {
    if (typeof event?.type === "string" && event.type.startsWith("tab.")) void refresh();
  });

  void refresh();

  return {
    refresh,
    get tabs() {
      return tabs;
    },
    destroy() {
      disposed = true;
      try {
        off();
      } catch {
        // Already torn down with the window.
      }
      closeMenu();
      root.remove();
    },
  };
}
