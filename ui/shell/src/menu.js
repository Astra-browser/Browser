/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A page menu in the chrome document itself.
//
// The menu used to live in the app iframe, which had to be raised above the
// content browser so it could paint — and restacking a chrome iframe over a
// remote browser flashed the page black on dismissal. This builder draws the
// same menu as ordinary XHTML directly above the content browser, so opening
// or closing it never touches the stage's stacking.

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function element(doc, tag, className = "", text = null) {
  const node = doc.createElementNS(XHTML_NS, tag);
  if (className) node.setAttribute("class", className);
  if (text !== null) node.textContent = text;
  return node;
}

/**
 * @param {Window} win the browser window
 * @param {{onChoose?: (id: string, menu: object) => void, onClose?: () => void}} hooks
 */
export function createShellMenu(win, { onChoose, onClose } = {}) {
  const doc = win.document;
  let overlay = null;
  let panel = null;
  let current = null;

  const onKey = (event) => {
    if (!current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
    }
  };

  function hide(notify = true) {
    win.removeEventListener("keydown", onKey, true);
    try {
      overlay?.remove();
    } catch {
      // Already gone with the window.
    }
    overlay = null;
    panel = null;
    const had = current !== null;
    current = null;
    if (had && notify) onClose?.();
  }

  function show(menu) {
    hide(false);
    current = menu;
    overlay = element(doc, "div", "astra-shell-menu-backdrop");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.zIndex = "90";

    panel = element(doc, "div", "astra-shell-menu");
    panel.setAttribute("role", "menu");
    panel.tabIndex = -1;
    panel.style.position = "absolute";
    panel.style.minWidth = "220px";
    panel.style.maxWidth = "320px";
    panel.style.maxHeight = "min(70vh, 560px)";
    panel.style.overflowY = "auto";
    panel.style.padding = "4px";
    panel.style.border = "1px solid #52525e";
    panel.style.borderRadius = "10px";
    panel.style.background = "#2b2a33";
    panel.style.color = "#fbfbfe";
    panel.style.boxShadow = "0 12px 32px rgb(0 0 0 / 45%)";
    panel.style.left = `${Math.max(8, Math.min(Number(menu.x) || 0, win.innerWidth - 300))}px`;
    panel.style.top = `${Math.max(8, Math.min(Number(menu.y) || 0, win.innerHeight - 240))}px`;

    let first = null;
    for (const entry of menu.items ?? []) {
      if (entry.kind === "separator") {
        const line = element(doc, "div", "astra-shell-menu-separator");
        line.style.height = "1px";
        line.style.margin = "4px 6px";
        line.style.background = "#52525e";
        panel.append(line);
        continue;
      }
      if (entry.kind === "heading") {
        const head = element(doc, "div", "astra-shell-menu-heading", entry.label ?? "");
        head.style.padding = "6px 8px 2px";
        head.style.color = "#b1b1c0";
        head.style.fontSize = "11px";
        head.style.fontWeight = "600";
        panel.append(head);
        continue;
      }
      const row = element(doc, "button", "astra-shell-menu-item");
      row.type = "button";
      row.setAttribute("role", "menuitem");
      row.disabled = entry.disabled === true;
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "12px";
      row.style.width = "100%";
      row.style.minHeight = "30px";
      row.style.padding = "0 8px";
      row.style.border = "0";
      row.style.borderRadius = "6px";
      row.style.background = "transparent";
      row.style.color = "inherit";
      row.style.font = "inherit";
      row.style.fontSize = "13px";
      row.style.textAlign = "start";
      row.style.cursor = "default";
      const label = element(doc, "span", "", entry.label ?? "");
      row.append(label);
      if (entry.hint) {
        const hint = element(doc, "span", "astra-shell-menu-hint", entry.hint);
        hint.style.color = "#b1b1c0";
        hint.style.fontSize = "11px";
        row.append(hint);
      }
      row.addEventListener("pointerenter", () => {
        row.style.background = "#3a3a44";
      });
      row.addEventListener("pointerleave", () => {
        row.style.background = "transparent";
      });
      row.addEventListener("click", () => {
        const id = entry.id;
        const chosen = current;
        hide(false);
        if (chosen && typeof chosen.choose === "function") {
          void chosen.choose(id);
        }
      });
      panel.append(row);
      if (!first && !row.disabled) first = row;
    }

    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) hide();
    });
    overlay.addEventListener("contextmenu", (event) => event.preventDefault());
    overlay.append(panel);
    const root = doc.getElementById("astra-root") ?? doc.documentElement;
    root.append(overlay);
    win.addEventListener("keydown", onKey, true);
    try {
      first?.focus();
    } catch {
      // Keyboard focus is a convenience; the mouse still works.
    }
  }

  return {
    show,
    hide: () => hide(),
    destroy: () => hide(false),
    get open() {
      return current !== null;
    },
  };
}
