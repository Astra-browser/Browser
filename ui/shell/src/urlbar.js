// P1-T10 URL bar. Built imperatively with XHTML-namespaced elements:
// Svelte-compiled templates set innerHTML on <template>, and the chrome XUL
// document sanitizer strips <button>/<form>/<input> from such fragments
// (measured 2026-11-02: <div> survives, <button> is removed). Plain DOM calls
// with createElementNS sidestep that entirely. State (url, history buttons)
// mirrors the Host API stub; every action goes through the stub so each
// navigation emits nav.committed + tab.updated.
import { newRequestId } from "./host.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function el(doc, tag, cls, text) {
  const n = doc.createElementNS(XHTML_NS, tag);
  if (cls) {
    n.setAttribute("class", cls);
  }
  if (text !== undefined) {
    n.textContent = text;
  }
  return n;
}

export function mountUrlBar(container, host) {
  const doc = container.ownerDocument;
  const bar = el(doc, "div", "astra-urlbar");
  bar.setAttribute("data-astra-urlbar", "");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Browser toolbar");

  const back = el(doc, "button", "nav", "←");
  back.setAttribute("data-action", "back");
  back.setAttribute("aria-label", "Back");
  back.title = "Back";
  back.type = "button";
  const fwd = el(doc, "button", "nav", "→");
  fwd.setAttribute("data-action", "forward");
  fwd.setAttribute("aria-label", "Forward");
  fwd.title = "Forward";
  fwd.type = "button";
  const rel = el(doc, "button", "nav", "⟳");
  rel.setAttribute("data-action", "reload");
  rel.setAttribute("aria-label", "Reload");
  rel.title = "Reload";
  rel.type = "button";

  const form = el(doc, "form", "urlform");
  form.setAttribute("role", "search");
  const input = el(doc, "input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Address bar");
  input.placeholder = "Enter a URL and press Enter";
  form.append(input);

  const count = el(doc, "span", "tabcount", "0 tabs");
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");

  bar.append(back, fwd, rel, form, count);
  container.append(bar);

  let disposed = false;

  async function refresh() {
    if (disposed) {
      return;
    }
    try {
      const list = await host.Tabs.list({ request_id: newRequestId() });
      if (disposed) {
        return;
      }
      const tabs = list.tabs ?? [];
      const active = tabs.find((t) => t.selected) ?? tabs[0];
      count.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
      if (active) {
        if (doc.activeElement !== input) {
          input.value = active.url;
        }
        back.disabled = !active.canGoBack;
        fwd.disabled = !active.canGoForward;
      }
    } catch {
      // Host gone (window teardown): leave last state painted.
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url) {
      return;
    }
    host.Content.navigate(url, { request_id: newRequestId() }).then(() => refresh());
    input.blur();
  });
  back.addEventListener("click", () => {
    host.Navigation.goBack({ request_id: newRequestId() });
  });
  fwd.addEventListener("click", () => {
    host.Navigation.goForward({ request_id: newRequestId() });
  });
  rel.addEventListener("click", () => {
    host.Navigation.reload({ request_id: newRequestId() });
  });

  const off = host.addEventListener((event) => {
    if (
      event.type === "tab.updated" ||
      event.type === "nav.committed" ||
      event.type === "tab.created" ||
      event.type === "tab.closed"
    ) {
      refresh();
    }
  });

  refresh();

  return {
    refresh,
    destroy() {
      disposed = true;
      off();
      bar.remove();
    },
  };
}
