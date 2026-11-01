// P3-T04 shell tab strip: pure model (no DOM). The renderer
// (`tab-strip.js`) keeps all document access; this module owns grouping,
// persistence shapes and drop-index math so `node --test` covers it with a
// fake Host and no browser.
//
// Host snapshots look like (see `overlay/astra/host/Tabs.sys.mjs`):
// `{ astra_tab_id, title, url, pinned, discarded, muted, selected, index }`.
// `icon` is accepted when the snapshot carries one; otherwise rows fall back
// to a letter tile.

export function normalizeHostTab(snapshot) {
  if (!snapshot || typeof snapshot.astra_tab_id !== "string") return null;
  return {
    id: snapshot.astra_tab_id,
    title: typeof snapshot.title === "string" ? snapshot.title : "",
    url: typeof snapshot.url === "string" ? snapshot.url : null,
    pinned: snapshot.pinned === true,
    sleeping: snapshot.discarded === true,
    muted: snapshot.muted === true,
    selected: snapshot.selected === true,
    favIconUrl: typeof snapshot.icon === "string" ? snapshot.icon : null,
    index: Number.isInteger(snapshot.index) ? snapshot.index : 0,
  };
}

/** Pinned tabs lead in Host display order; the rest follow. */
export function splitSections(tabs) {
  const pinned = [];
  const open = [];
  for (const tab of tabs) {
    if (tab.pinned) pinned.push(tab);
    else open.push(tab);
  }
  return { pinned, open };
}

export function fallbackLetter(tab) {
  const source = (tab.title || "").trim() || tab.url || "";
  const match = /[A-Za-z0-9]/u.exec(source);
  return (match ? match[0] : "•").toUpperCase();
}

const STORAGE_KEY = "astra.tabstrip.folders.v1";

export function blankFolders() {
  return { folders: [], assignment: {}, collapsed: {} };
}

/** Folder state survives restarts; a corrupt entry resets to empty. */
export function loadFolderState(storage) {
  try {
    if (!storage) return blankFolders();
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return blankFolders();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.folders)) return blankFolders();
    const folders = parsed.folders.filter(
      (folder) => folder && typeof folder.id === "string" && typeof folder.name === "string",
    );
    const ids = new Set(folders.map((folder) => folder.id));
    const assignment = {};
    for (const [tabId, folderId] of Object.entries(parsed.assignment ?? {})) {
      if (ids.has(folderId)) assignment[tabId] = folderId;
    }
    const collapsed = {};
    for (const [folderId, value] of Object.entries(parsed.collapsed ?? {})) {
      if (ids.has(folderId) && value === true) collapsed[folderId] = true;
    }
    return { folders, assignment, collapsed };
  } catch {
    return blankFolders();
  }
}

export function saveFolderState(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked store never breaks the strip.
  }
}

export function createFolder(state, name, makeId) {
  const folder = { id: makeId(), name };
  return { ...state, folders: [...state.folders, folder] };
}

export function renameFolder(state, id, name) {
  return {
    ...state,
    folders: state.folders.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
  };
}

/** Deleting a folder spills its tabs back to the list root. */
export function deleteFolder(state, id) {
  const folders = state.folders.filter((folder) => folder.id !== id);
  const assignment = {};
  for (const [tabId, folderId] of Object.entries(state.assignment)) {
    if (folderId !== id) assignment[tabId] = folderId;
  }
  const collapsed = { ...state.collapsed };
  delete collapsed[id];
  return { folders, assignment, collapsed };
}

export function assignToFolder(state, tabId, folderId) {
  if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) return state;
  const assignment = { ...state.assignment };
  if (folderId === null) delete assignment[tabId];
  else assignment[tabId] = folderId;
  return { ...state, assignment };
}

export function toggleFolder(state, id) {
  const collapsed = { ...state.collapsed };
  if (collapsed[id]) delete collapsed[id];
  else collapsed[id] = true;
  return { ...state, collapsed };
}

export function isCollapsed(state, id) {
  return state.collapsed[id] === true;
}

export function folderOf(state, tabId) {
  const folderId = state.assignment[tabId];
  if (!folderId) return null;
  return state.folders.find((folder) => folder.id === folderId) ?? null;
}

/**
 * Rows the strip renders: pinned tabs lead and never enter folders; open
 * tabs group under their folder in Host order; a folded folder still shows
 * while one of its own rows is selected.
 */
export function groupRows(openTabs, state, activeId) {
  const byFolder = new Map();
  const root = [];
  for (const tab of openTabs) {
    const folder = folderOf(state, tab.id);
    if (folder === null) root.push(tab);
    else {
      const group = byFolder.get(folder.id) ?? [];
      group.push(tab);
      byFolder.set(folder.id, group);
    }
  }
  const rows = [];
  for (const folder of state.folders) {
    const children = byFolder.get(folder.id) ?? [];
    if (children.length === 0) {
      rows.push({ kind: "folder", folder, children: [], expanded: !isCollapsed(state, folder.id) });
      continue;
    }
    rows.push({
      kind: "folder",
      folder,
      children,
      expanded: !isCollapsed(state, folder.id) || children.some((tab) => tab.id === activeId),
    });
  }
  for (const tab of root) rows.push({ kind: "tab", tab });
  return rows;
}

/**
 * Translate a drop onto the rendered list into the global `Tabs.move`
 * index. The dragged tab leaves its run first, lands before `beforeId`
 * (or at its run's end when null), and pinned runs always lead open runs,
 * so the returned index is the tab's position in the rebuilt order.
 */
export function globalDropIndex(sections, draggedId, beforeId) {
  const isPinned = sections.pinned.some((tab) => tab.id === draggedId);
  if (beforeId === draggedId) {
    // A drop onto its own row moves nothing.
    const current = isPinned ? sections.pinned : sections.open;
    return (isPinned ? 0 : sections.pinned.length) + current.findIndex((tab) => tab.id === draggedId);
  }
  const runIds = (isPinned ? sections.pinned : sections.open)
    .map((tab) => tab.id)
    .filter((id) => id !== draggedId);
  const at = beforeId === null ? runIds.length : runIds.indexOf(beforeId);
  const insertAt = at === -1 ? runIds.length : at;
  const placed = [...runIds.slice(0, insertAt), draggedId, ...runIds.slice(insertAt)];
  const other = (isPinned ? sections.open : sections.pinned)
    .map((tab) => tab.id)
    .filter((id) => id !== draggedId);
  const full = isPinned ? [...placed, ...other] : [...other, ...placed];
  return full.indexOf(draggedId);
}

/** Context-menu entries for one tab; the renderer turns these into a popup. */
export function menuItems(tab) {
  return [
    { id: "activate", label: tab.selected ? "Already active" : "Activate", disabled: tab.selected },
    { id: "close", label: "Close tab" },
    { id: tab.pinned ? "unpin" : "pin", label: tab.pinned ? "Unpin tab" : "Pin tab" },
    { id: tab.muted ? "unmute" : "mute", label: tab.muted ? "Unmute tab" : "Mute tab" },
    { id: "duplicate", label: "Duplicate tab" },
    {
      id: tab.sleeping ? "wakeup" : "discard",
      label: tab.sleeping ? "Wake up tab" : "Sleep tab",
    },
    { id: "copy-link", label: "Copy link", disabled: !tab.url },
  ];
}
