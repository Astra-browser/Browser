// Astra window frame builders (P3-T03, Linux first). Built imperatively
// with XHTML-namespaced elements: Svelte-compiled templates set innerHTML
// on <template>, and the chrome XUL document sanitizer strips
// <button>/<form>/<input> from such fragments (measured P1-T10: <div>
// survives, <button> is removed). Plain DOM calls sidestep that entirely.
// `doc` is injected so Node contract tests can pass a fake document.

const NS = "http://www.w3.org/1999/xhtml";

function el(doc, tag, cls, text) {
  const n = doc.createElementNS(NS, tag);
  if (cls) {
    n.setAttribute("class", cls);
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

const CONTROLS = [
  { action: "minimize", label: "–", title: "Minimize" },
  { action: "maximize", label: "▢", title: "Maximize" },
  { action: "close", label: "✕", title: "Close" },
];

/**
 * Build the custom titlebar: draggable strip + title + window controls.
 * onControl(action) is called for minimize/maximize/close clicks; the
 * shell routes it through Frame.sys.mjs dispatchWindowControl (Host API
 * for close/fullscreen, chrome adapter for min/max).
 */
export function createTitlebar(doc, { title = "Astra", onControl = null } = {}) {
  const bar = el(doc, "div", "astra-titlebar");
  bar.setAttribute("data-astra-titlebar", "");
  bar.setAttribute("data-astra-drag", "true");
  bar.setAttribute("role", "banner");

  const label = el(doc, "div", "astra-titlebar-title", title);
  label.setAttribute("data-astra-title", "");
  bar.append(label);

  const controls = el(doc, "div", "astra-window-controls");
  controls.setAttribute("data-astra-window-controls", "");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Window controls");
  for (const c of CONTROLS) {
    const b = el(doc, "button", "", c.label);
    b.setAttribute("data-action", c.action);
    b.setAttribute("aria-label", c.title);
    b.title = c.title;
    b.type = "button";
    b.addEventListener("click", () => {
      if (onControl) {
        onControl(c.action);
      }
    });
    controls.append(b);
  }
  bar.append(controls);

  return {
    element: bar,
    setTitle(next) {
      label.textContent = next;
    },
    destroy() {
      bar.remove();
    },
  };
}

/**
 * Build the sidebar: vertical nav with collapsible width. items is an
 * array of { id, label }; onSelect(id) fires on click. The active item
 * gets aria-current="page".
 */
export function createSidebar(doc, { items = [], activeId = "", onSelect = null } = {}) {
  const nav = el(doc, "div", "astra-sidebar");
  nav.setAttribute("data-astra-sidebar", "");
  nav.setAttribute("role", "navigation");
  nav.setAttribute("aria-label", "Sidebar");
  let current = activeId;
  const buttons = new Map();

  const paint = () => {
    for (const [id, b] of buttons) {
      if (id === current) {
        b.setAttribute("aria-current", "page");
      } else {
        b.removeAttribute("aria-current");
      }
    }
  };

  for (const item of items) {
    const b = el(doc, "button", "", item.label);
    b.setAttribute("data-item", item.id);
    b.type = "button";
    b.addEventListener("click", () => {
      current = item.id;
      paint();
      if (onSelect) {
        onSelect(item.id);
      }
    });
    buttons.set(item.id, b);
    nav.append(b);
  }
  paint();

  return {
    element: nav,
    setCollapsed(collapsed) {
      nav.setAttribute("data-collapsed", collapsed ? "true" : "false");
    },
    select(id) {
      if (buttons.has(id)) {
        current = id;
        paint();
      }
    },
    get activeId() {
      return current;
    },
    destroy() {
      nav.remove();
    },
  };
}

/**
 * Build the toolbar row: action buttons (back/forward/reload placeholders
 * are owned by the URL bar; this row carries frame-level actions).
 * actions is an array of { id, label, disabled }; onAction(id) fires.
 */
export function createToolbar(doc, { actions = [], onAction = null } = {}) {
  const bar = el(doc, "div", "astra-toolbar");
  bar.setAttribute("data-astra-toolbar", "");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Toolbar");
  const buttons = new Map();

  for (const a of actions) {
    const b = el(doc, "button", "", a.label);
    b.setAttribute("data-action", a.id);
    b.type = "button";
    if (a.disabled) {
      b.disabled = true;
    }
    b.addEventListener("click", () => {
      if (onAction) {
        onAction(a.id);
      }
    });
    buttons.set(a.id, b);
    bar.append(b);
  }

  return {
    element: bar,
    setDisabled(id, disabled) {
      const b = buttons.get(id);
      if (b) {
        b.disabled = disabled === true;
      }
    },
    destroy() {
      bar.remove();
    },
  };
}
