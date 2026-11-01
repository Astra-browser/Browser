import { getBridge, type Bridge } from "@astra/bridge";

// Bridge-backed tab-strip state (P3-T04). The single place the vertical tab
// list reads when it runs on `@astra/bridge` instead of the Tauri bindings:
// every mutation goes out as `invoke("tabs_*"/"tab_*", …)` and every remote
// change arrives on `listen("tab-changed", …)`. Framework-free so the unit project
// (node env) can drive it through MockHost with no DOM.
//
// Payloads are normalized from both shapes the UI meets: Host snapshots
// (`{ astra_tab_id, pinned, discarded, muted, selected }`, see
// `overlay/astra/host/Tabs.sys.mjs`) and app `TabView`s
// (`{ id, availability: { state: "sleeping" }, audio: { muted } }`).

export interface StripTab {
  id: string;
  title: string;
  url: string | null;
  pinned: boolean;
  sleeping: boolean;
  muted: boolean;
  audible: boolean;
  favIconUrl: string | null;
  selected: boolean;
}

export interface StripFolder {
  id: string;
  name: string;
}

export type StripUnit =
  | { kind: "tab"; tab: StripTab }
  | { kind: "folder"; folder: StripFolder; children: StripTab[]; expanded: boolean };

export interface StripSnapshot {
  tabs: StripTab[];
  folders: StripFolder[];
  activeId: string | null;
}

export interface TabMenuAction {
  id: string;
  x: number;
  y: number;
  context: {
    page: boolean;
    can_split: boolean;
    essential: boolean;
    others: boolean;
    below: boolean;
    muted: boolean;
    capture: string | null;
    media_only: boolean;
  };
}

type Listener = () => void;

/** First readable character for the letter-tile favicon fallback. */
export function fallbackLetter(tab: Pick<StripTab, "title" | "url">): string {
  const source = tab.title.trim() || tab.url || "";
  const match = /[A-Za-z0-9]/u.exec(source);
  return (match?.[0] ?? "•").toUpperCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Normalize a Host snapshot or app TabView into one strip row. */
export function normalizeTab(input: unknown): StripTab | null {
  const raw = asRecord(input);
  const id = asString(raw["id"] ?? raw["astra_tab_id"]);
  if (id === null) return null;
  const availability = asRecord(raw["availability"]);
  const audio = raw["audio"] === null || raw["audio"] === undefined ? null : asRecord(raw["audio"]);
  const icon = raw["icon"];
  const sleeping = raw["discarded"] === true || asString(availability["state"]) === "sleeping";
  const muted = audio !== null ? audio["muted"] === true : raw["muted"] === true;
  const audible = audio !== null ? true : (raw["audible"] as boolean) === true || muted;
  return {
    id,
    title: asString(raw["title"]) ?? "",
    url: asString(raw["url"]),
    pinned: raw["pinned"] === true,
    sleeping,
    muted,
    audible,
    favIconUrl:
      typeof icon === "string" ? icon : ((asRecord(icon)["url"] as string | null) ?? null),
    selected: raw["selected"] === true,
  };
}

let folderSeq = 0;

export class TabsBridgeStore {
  private bridge: Bridge;
  private tabs: StripTab[] = [];
  private folders: StripFolder[] = [];
  private assignment = new Map<string, string>();
  private collapsed = new Set<string>();
  private listeners = new Set<Listener>();
  private unlisten: (() => void) | null = null;
  private bootstrapped = false;

  constructor(bridge?: Bridge) {
    this.bridge = bridge ?? getBridge();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): StripSnapshot {
    return {
      tabs: [...this.tabs],
      folders: [...this.folders],
      activeId: this.tabs.find((tab) => tab.selected)?.id ?? null,
    };
  }

  tab(id: string): StripTab | undefined {
    return this.tabs.find((tab) => tab.id === id);
  }

  /** Open tabs in display order: folders stay with the list, pins stay out. */
  get openTabs(): StripTab[] {
    return this.tabs.filter((tab) => !tab.pinned);
  }

  get pinnedTabs(): StripTab[] {
    return this.tabs.filter((tab) => tab.pinned);
  }

  /** Folder the tab was put in, if it is still there. */
  folderOf(id: string): StripFolder | null {
    const folderId = this.assignment.get(id);
    if (folderId === undefined) return null;
    return this.folders.find((folder) => folder.id === folderId) ?? null;
  }

  isCollapsed(folderId: string): boolean {
    return this.collapsed.has(folderId);
  }

  /**
   * Rows the vertical list renders: pinned tabs lead and never enter
   * folders, open tabs group under their folder, and a folded folder still
   * shows while one of its own rows is the selected one.
   */
  visibleUnits(): StripUnit[] {
    const activeId = this.snapshot().activeId;
    const byFolder = new Map<string, StripTab[]>();
    const root: StripTab[] = [];
    for (const tab of this.openTabs) {
      const folder = this.folderOf(tab.id);
      if (folder === null) root.push(tab);
      else {
        const group = byFolder.get(folder.id) ?? [];
        group.push(tab);
        byFolder.set(folder.id, group);
      }
    }
    const units: StripUnit[] = this.pinnedTabs.map((tab) => ({ kind: "tab" as const, tab }));
    for (const folder of this.folders) {
      const children = byFolder.get(folder.id) ?? [];
      if (children.length === 0) {
        units.push({
          kind: "folder",
          folder,
          children: [],
          expanded: !this.isCollapsed(folder.id),
        });
        continue;
      }
      const expanded = !this.isCollapsed(folder.id) || children.some((tab) => tab.id === activeId);
      units.push({ kind: "folder", folder, children, expanded });
    }
    for (const tab of root) units.push({ kind: "tab", tab });
    return units;
  }

  /**
   * Connect `tab-changed` and ask native for the first projection.
   * `tabs_bootstrap` is best-effort: MockHost answers `undefined` and the
   * live host answers once its listeners exist.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    this.unlisten = this.bridge.listen<unknown>("tab-changed", (event) => {
      this.applyEvent(event.payload);
    });
    try {
      await this.bridge.invoke("tabs_bootstrap");
    } catch {
      // Standalone/dev: the snapshot arrives as events instead.
    }
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.bootstrapped = false;
    this.listeners.clear();
  }

  /** Apply one `tab-changed` payload; returns whether the list moved. */
  applyEvent(payload: unknown): boolean {
    const raw = asRecord(payload);
    const reason = asString(raw["reason"]);
    const id = asString(raw["id"] ?? raw["astra_tab_id"]);
    if (reason === "closed" && id !== null) return this.removeTab(id);
    const tab = normalizeTab(payload);
    if (tab === null) return false;
    const at = this.tabs.findIndex((candidate) => candidate.id === tab.id);
    if (at === -1) {
      this.tabs = [...this.tabs, tab];
    } else if (JSON.stringify(this.tabs[at]) !== JSON.stringify(tab)) {
      const next = this.tabs.slice();
      next[at] = tab;
      this.tabs = next;
    } else {
      return false;
    }
    if (tab.selected) {
      this.tabs = this.tabs.map((candidate) =>
        candidate.id === tab.id
          ? candidate
          : candidate.selected
            ? { ...candidate, selected: false }
            : candidate,
      );
    }
    this.emit();
    return true;
  }

  private removeTab(id: string): boolean {
    if (!this.tabs.some((candidate) => candidate.id === id)) return false;
    this.tabs = this.tabs.filter((candidate) => candidate.id !== id);
    if (this.assignment.get(id) !== undefined) this.assignment.delete(id);
    this.emit();
    return true;
  }

  /** Seed the list (tests, previews); events remain the live path. */
  seed(inputs: unknown[]): void {
    const tabs: StripTab[] = [];
    for (const input of inputs) {
      const tab = normalizeTab(input);
      if (tab !== null && !tabs.some((candidate) => candidate.id === tab.id)) tabs.push(tab);
    }
    this.tabs = tabs;
    this.emit();
  }

  async activate(id: string): Promise<void> {
    await this.bridge.invoke("tabs_activate", { id });
  }

  async closeTab(id: string): Promise<void> {
    await this.bridge.invoke("tabs_close", { id });
  }

  async openTab(background = false): Promise<void> {
    await this.bridge.invoke("tabs_open", { background });
  }

  /**
   * Persist a drag-reorder: the tab takes the position just before
   * `beforeId` (or the end when null), in the pinned or the open run.
   */
  async move(id: string, beforeId: string | null): Promise<void> {
    const moving = this.tab(id);
    if (!moving) return;
    const run = this.tabs.filter((tab) => tab.pinned === moving.pinned && tab.id !== id);
    const found = beforeId === null ? -1 : run.findIndex((tab) => tab.id === beforeId);
    const insertAt = found === -1 ? run.length : found;
    const ordered = [...run.slice(0, insertAt), moving, ...run.slice(insertAt)];
    const others = this.tabs.filter((tab) => tab.pinned !== moving.pinned);
    this.tabs = moving.pinned ? [...ordered, ...others] : [...others, ...ordered];
    this.emit();
    await this.bridge.invoke("tabs_set_essential", {
      id,
      essential: moving.pinned,
      before: beforeId,
    });
  }

  /** Pin or unpin; native keeps the address, the strip keeps the section. */
  async togglePin(id: string): Promise<void> {
    const tab = this.tab(id);
    if (!tab) return;
    const essential = !tab.pinned;
    const admitted = await this.bridge.invoke<{ admitted?: boolean }>("tabs_set_essential", {
      id,
      essential,
      before: null,
    });
    if (admitted?.admitted === false) return;
    this.tabs = this.tabs.map((candidate) =>
      candidate.id === id ? { ...candidate, pinned: essential } : candidate,
    );
    this.emit();
  }

  /** Mute or unmute; the projected tab says what native applied. */
  async toggleMute(id: string): Promise<void> {
    const tab = this.tab(id);
    if (!tab) return;
    await this.bridge.invoke("tab_set_muted", { id, muted: !tab.muted });
  }

  /** The tab menu is a native popup; this only asks for it with context. */
  async openMenu(id: string, x: number, y: number): Promise<TabMenuAction> {
    const tab = this.tab(id);
    const open = this.openTabs;
    const at = open.findIndex((candidate) => candidate.id === id);
    const action: TabMenuAction = {
      id,
      x,
      y,
      context: {
        page: (tab?.url ?? null) !== null,
        can_split: open.length > 1 && this.snapshot().activeId !== id,
        essential: tab?.pinned ?? false,
        others: open.some((candidate) => candidate.id !== id),
        below: at >= 0 && at < open.length - 1,
        muted: tab?.muted ?? false,
        capture: null,
        media_only: false,
      },
    };
    await this.bridge.invoke("tab_menu_popup", {
      id: action.id,
      x: action.x,
      y: action.y,
      context: action.context,
    });
    return action;
  }

  /** Probe favicons for http(s) origins the strip has no icon for yet. */
  async ensureFavicons(): Promise<void> {
    const origins = new Set<string>();
    for (const tab of this.tabs) {
      if (tab.favIconUrl !== null || tab.url === null) continue;
      try {
        const origin = new URL(tab.url).origin;
        if (origin.startsWith("http")) origins.add(origin);
      } catch {
        // Unparseable addresses never reach the prober.
      }
    }
    if (origins.size === 0) return;
    try {
      await this.bridge.invoke("favicon_probe", { origins: [...origins] });
    } catch {
      // Favicons are decoration; a failed probe never breaks the list.
    }
  }

  createFolder(name: string): StripFolder {
    const folder = { id: `folder-${++folderSeq}-${Date.now().toString(36)}`, name };
    this.folders = [...this.folders, folder];
    this.emit();
    return folder;
  }

  renameFolder(id: string, name: string): void {
    this.folders = this.folders.map((folder) => (folder.id === id ? { ...folder, name } : folder));
    this.emit();
  }

  /** Deleting a folder spills its tabs back to the list root. */
  deleteFolder(id: string): void {
    this.folders = this.folders.filter((folder) => folder.id !== id);
    for (const [tabId, folderId] of [...this.assignment]) {
      if (folderId === id) this.assignment.delete(tabId);
    }
    this.collapsed.delete(id);
    this.emit();
  }

  assignToFolder(tabId: string, folderId: string | null): void {
    if (folderId === null) this.assignment.delete(tabId);
    else if (this.folders.some((folder) => folder.id === folderId)) {
      this.assignment.set(tabId, folderId);
    }
    this.emit();
  }

  toggleFolder(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A throwing subscriber never breaks the strip.
      }
    }
  }
}
