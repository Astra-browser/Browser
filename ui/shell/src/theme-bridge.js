/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Web pages must see the interface's own light/dark choice. Firefox decides
// `prefers-color-scheme` for content from the mirrored static pref
// `layout.css.prefers-color-scheme.content-override` (0 dark, 1 light,
// 2 follow the system). The app owns the theme and writes it on its root as
// `data-theme`; this bridge copies that one attribute to the engine, and keeps
// copying it when a theme is chosen later, so a page never disagrees with the
// chrome it sits in.

/**
 * Mirror the app document's `data-theme` into content colour-scheme.
 *
 * @param {HTMLIFrameElement|null} frame the app frame
 * @param {{System?: {setContentColorScheme?: (args: {light: boolean}) => Promise<unknown>}}} host
 * @returns {() => void} teardown
 */
export function installThemeBridge(frame, host) {
  if (!frame) return () => {};
  let doc = null;
  let observer = null;
  let stopped = false;

  const apply = () => {
    if (stopped) return;
    const theme = doc?.documentElement?.getAttribute("data-theme");
    if (theme !== "light" && theme !== "dark") return;
    try {
      const set = host?.System?.setContentColorScheme;
      if (typeof set === "function") {
        void Promise.resolve(set.call(host.System, { light: theme === "light" })).catch(() => {});
      }
    } catch {
      // A window torn down mid-write: the next window will set its own.
    }
  };

  const attach = () => {
    try {
      doc = frame.contentDocument;
      if (!doc || !doc.documentElement) return false;
      const View = doc.defaultView;
      if (View?.MutationObserver) {
        observer = new View.MutationObserver(apply);
        observer.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
      }
      apply();
      return true;
    } catch {
      return false;
    }
  };

  if (!attach()) {
    // The child document is not ready at mount; its load event carries it.
    const onLoad = () => {
      attach();
      frame.removeEventListener("load", onLoad);
    };
    frame.addEventListener("load", onLoad);
    return () => {
      stopped = true;
      observer?.disconnect();
      frame.removeEventListener("load", onLoad);
    };
  }

  return () => {
    stopped = true;
    try {
      observer?.disconnect();
    } catch {
      // Already gone with the document.
    }
  };
}
