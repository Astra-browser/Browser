/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One registry owns a browser surface (D-38, P7-T03).
//
// A "surface" is either a page that stands over the stage (`browser.<id>`)
// or a side-panel tool (`tool.<id>`). The same id can be both: Notes, Tasks,
// Time, History and Downloads are full pages *and* side-panel tools, so an
// id is unique within its kind, not across all rows.
//
// This file is the single source of the page ids, the tool kinds, the
// component each one mounts and the message key that names it. The `ui-command`
// guard, `ToolKind`, the Shell stage, the page-tab label and the contract gate
// all derive from these rows.
//
// `Downloads` is deliberately a page *and* a tool. The page mounts the shared
// library with `kind="downloads"`; the tool opens the side-panel's own
// downloads view. That is the existing behaviour, now stated here instead of
// living in the Shell's catch-all branch.
//
// The loader is a lazy thunk: importing this file must not pull a view, and
// the Node contract suite must be able to read the rows without resolving a
// Vite alias or parsing Svelte. Each thunk goes through the owning feature's
// public API, never its implementation files.
import type { Component } from "svelte";

type MessageKey = keyof typeof import("$shared/i18n/messages");

export type SurfaceKind = "page" | "tool";

// Pages do not share a prop contract: Settings and History take none, Notes
// takes a profile and a close callback, Source takes a tab id, and the tool
// panel takes its kind. The stage owns those props per page, so the registry
// stores the loader slot rather than a page-specific component type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one slot for differently-propped views
type SurfaceView = Component<any>;

export interface SurfaceRow {
  readonly id: string;
  readonly kind: SurfaceKind;
  /** Lazy view loader; resolved only when the surface is opened. */
  readonly loader: () => Promise<{ default: SurfaceView }>;
  /** Message key used wherever the surface needs a written name. */
  readonly labelKey: MessageKey;
}

// The tool panel is one component that takes the kind it shows, so every tool
// row names the same loader; the reference is stable, which is also what
// `LazyView` uses as its resolved-view cache key.
const loadTool = () => import("$features/tools").then((module) => module.loadToolSlot());

export const PAGE_SURFACES = [
  {
    id: "settings",
    kind: "page",
    loader: () => import("$features/settings").then((module) => module.loadSettings()),
    labelKey: "settings_title",
  },
  {
    id: "extensions",
    kind: "page",
    loader: () => import("$features/webext").then((module) => module.loadWebExtensionManager()),
    labelKey: "webext_page_title",
  },
  {
    id: "history",
    kind: "page",
    loader: () => import("$features/history").then((module) => module.loadHistoryPage()),
    labelKey: "menu_history",
  },
  {
    id: "downloads",
    kind: "page",
    loader: () => import("$features/library").then((module) => module.loadLibraryPage()),
    labelKey: "menu_downloads",
  },
  {
    id: "gallery",
    kind: "page",
    loader: () => import("$features/gallery").then((module) => module.loadGalleryPage()),
    labelKey: "gallery_title",
  },
  {
    id: "work",
    kind: "page",
    loader: () => import("$app/browser/WorkWorkspace.svelte"),
    labelKey: "mode_work",
  },
  {
    id: "tasks",
    kind: "page",
    loader: () => import("$features/tasks").then((module) => module.loadTasksPage()),
    labelKey: "panel_tasks",
  },
  {
    id: "notes",
    kind: "page",
    loader: () => import("$features/notes").then((module) => module.loadNotesPage()),
    labelKey: "panel_notes",
  },
  {
    id: "time",
    kind: "page",
    loader: () => import("$features/time").then((module) => module.loadTimePage()),
    labelKey: "time_title",
  },
  {
    id: "source",
    kind: "page",
    loader: () => import("$features/source").then((module) => module.loadSourcePage()),
    labelKey: "source_title",
  },
] as const satisfies readonly SurfaceRow[];

export const TOOL_SURFACES = [
  { id: "notes", kind: "tool", loader: loadTool, labelKey: "panel_notes" },
  { id: "tasks", kind: "tool", loader: loadTool, labelKey: "panel_tasks" },
  { id: "ai", kind: "tool", loader: loadTool, labelKey: "panel_ask_astra" },
  { id: "time", kind: "tool", loader: loadTool, labelKey: "panel_time" },
  { id: "history", kind: "tool", loader: loadTool, labelKey: "menu_history" },
  { id: "downloads", kind: "tool", loader: loadTool, labelKey: "menu_downloads" },
  { id: "bookmarks", kind: "tool", loader: loadTool, labelKey: "tool_bookmarks" },
] as const satisfies readonly SurfaceRow[];

export const SURFACES = [...PAGE_SURFACES, ...TOOL_SURFACES] as const;

export type BrowserPage = (typeof PAGE_SURFACES)[number]["id"];
export type ToolKind = (typeof TOOL_SURFACES)[number]["id"];

export const BROWSER_PAGES: readonly BrowserPage[] = PAGE_SURFACES.map((row) => row.id);
export const TOOL_KINDS: readonly ToolKind[] = TOOL_SURFACES.map((row) => row.id);

const PAGE_IDS = new Set<string>(BROWSER_PAGES);
const TOOL_IDS = new Set<string>(TOOL_KINDS);

export const isBrowserPage = (id: string): id is BrowserPage => PAGE_IDS.has(id);
export const isToolKind = (id: string): id is ToolKind => TOOL_IDS.has(id);

/** The row for a page id; the caller already knows the id is a page. */
export const pageSurface = (id: BrowserPage): SurfaceRow =>
  PAGE_SURFACES.find((row) => row.id === id)!;

/** The row for a tool id; the caller already knows the id is a tool. */
export const toolSurface = (id: ToolKind): SurfaceRow =>
  TOOL_SURFACES.find((row) => row.id === id)!;
