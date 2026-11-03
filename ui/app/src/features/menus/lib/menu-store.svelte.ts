import type { IconSvgElement } from "@hugeicons/svelte";

/** One row the chrome can draw in the context menu. */
type ShellMenuItem =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: IconSvgElement;
      /** A shortcut or an explanation, drawn at the trailing edge. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

type ShellMenu = {
  items: ShellMenuItem[];
  x: number;
  y: number;
};

type MenuHandler = (id: string) => void;

let menu = $state.raw<ShellMenu | null>(null);
let handler: MenuHandler | null = null;

export const current = () => menu;

/** Opens a menu at a point in this document's coordinates. */
export function openAt(next: ShellMenu, onChoose: MenuHandler) {
  const items = next.items.filter(
    (entry, index, all) =>
      entry.kind !== "separator" || (index > 0 && all[index - 1]?.kind !== "separator"),
  );
  while (items.length > 0 && items[items.length - 1]?.kind === "separator") items.pop();
  if (items.length === 0) return;
  handler = onChoose;
  menuEpoch += 1;
  menu = { items, x: next.x, y: next.y };
  // The menu is drawn in the app frame, which sits under the page surface.
  // Mark the document and tell the shell to raise the frame while it is open;
  // the same marker makes the frame's own ground transparent so the page
  // still shows around the menu.
  try {
    document.documentElement.dataset.astraMenu = "true";
  } catch {
    // Diagnostics only.
  }
  postShell({ kind: "menu-open" });
}

let menuEpoch = 0;

export function close() {
  const wasOpen = menu !== null;
  const epoch = menuEpoch;
  menu = null;
  handler = null;
  if (wasOpen) postShell({ kind: "menu-close" });
  // The shell lowers the raised frame on `menu-close`. Restoring the frame's
  // opaque ground in the same turn would let it cover the page for one frame
  // before it is lowered — the black flash on dismissal. Keep the ground
  // transparent until the frame is back under the page.
  try {
    requestAnimationFrame(() => {
      if (menuEpoch !== epoch) return;
      delete document.documentElement.dataset.astraMenu;
    });
  } catch {
    try {
      delete document.documentElement.dataset.astraMenu;
    } catch {
      // Diagnostics only.
    }
  }
}

/** One-way note to the shell that owns the frame stacking/clip. */
function postShell(message: Record<string, unknown>) {
  try {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage({ ns: SHELL_NS, ...message }, "*");
  } catch {
    // No shell: the app still runs standalone.
  }
}

/** Runs the chosen row, then closes. The chrome owns what the id means. */
export function choose(id: string) {
  const run = handler;
  close();
  run?.(id);
}

const SHELL_NS = "astra-shell";

type ShellMenuMessage = {
  ns?: string;
  kind?: string;
  menu?: {
    x?: number;
    y?: number;
    items?: Array<
      | (Omit<Extract<ShellMenuItem, { kind: "item" }>, "kind"> & { kind?: "item" })
      | { kind: "separator" }
      | { kind: "heading"; label: string }
    >;
  };
};

function sanitize(message: ShellMenuMessage): ShellMenu | null {
  const raw = message.menu;
  if (!raw || !Array.isArray(raw.items)) return null;
  const items: ShellMenuItem[] = [];
  for (const entry of raw.items) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "separator") {
      items.push({ kind: "separator" });
      continue;
    }
    if (entry.kind === "heading") {
      items.push({ kind: "heading", label: String(entry.label ?? "") });
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id === "") continue;
    items.push({
      kind: "item",
      id,
      label: String(entry.label ?? ""),
      hint: typeof entry.hint === "string" ? entry.hint : undefined,
      danger: entry.danger === true,
      disabled: entry.disabled === true,
    });
  }
  const x = Number.isFinite(raw.x) ? Number(raw.x) : 0;
  const y = Number.isFinite(raw.y) ? Number(raw.y) : 0;
  return { items, x, y };
}

let installed = false;
let stop: (() => void) | null = null;

/**
 * Listens for the chrome's content menu. The web page owns the pointer, so the
 * shell intercepts the engine's menu, turns it into this shape and posts it
 * here; choosing a row posts the id back, and the shell performs it on the
 * page. Nothing is rendered outside this document.
 */
export function install(): () => void {
  if (installed) return stop ?? (() => {});
  installed = true;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as ShellMenuMessage | null;
    if (!data || data.ns !== SHELL_NS || data.kind !== "menu") return;
    const next = sanitize(data);
    if (!next) return;
    openAt(next, (id) => {
      try {
        window.parent.postMessage({ ns: SHELL_NS, kind: "menu-run", id }, "*");
      } catch {
        // The shell went away with the window: nothing left to run it.
      }
    });
  };
  window.addEventListener("message", onMessage);
  const off = () => {
    window.removeEventListener("message", onMessage);
    installed = false;
    stop = null;
    close();
  };
  stop = off;
  return off;
}
