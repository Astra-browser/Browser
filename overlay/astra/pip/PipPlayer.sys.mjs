/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Astra's face on Gecko's media Picture-in-Picture player. The engine still
// owns the video, the scrubber and the transport; this only copies the
// interface's current theme and puts the title in a slim head strip. The
// stylesheet itself is linked by the player document, so it parses with the
// native player skin. Everything is released with the player window.

let pipModule = false;

/** The engine's module, or null where this build has no player. */
function pictureInPicture() {
  if (pipModule !== false) return pipModule;
  try {
    pipModule =
      ChromeUtils.importESModule(
        "resource://gre/modules/PictureInPicture.sys.mjs",
      ).PictureInPicture ?? null;
  } catch {
    pipModule = null;
  }
  return pipModule;
}

/** The tab whose video this player clones. */
function sourceBrowser(playerWin) {
  try {
    return pictureInPicture()?.weakWinToBrowser?.get(playerWin) ?? null;
  } catch {
    return null;
  }
}

function dress(playerWin, parentWin) {
  const doc = playerWin?.document;
  if (!doc || doc.documentElement.hasAttribute("data-astra-pip")) {
    return;
  }
  doc.documentElement.setAttribute("data-astra-pip", "");

  const themeSource = parentWin?.document?.querySelector(".astra-frame");
  const applyTheme = () => {
    const theme =
      themeSource?.getAttribute("data-astra-theme") == "light"
        ? "light"
        : "dark";
    doc.documentElement.setAttribute("data-astra-theme", theme);
  };
  applyTheme();
  let observer = null;
  if (themeSource) {
    try {
      observer = new playerWin.MutationObserver(applyTheme);
      observer.observe(themeSource, {
        attributes: true,
        attributeFilter: ["data-astra-theme"],
      });
    } catch {
      observer = null;
    }
  }

  const browser = doc.getElementById("browser");
  const head = doc.createElement("div");
  head.className = "astra-pip-head";
  const word = doc.createElement("span");
  word.className = "astra-pip-word";
  word.textContent = "Astra";
  const title = doc.createElement("span");
  title.className = "astra-pip-title";
  head.append(word, title);
  doc.body.prepend(head);

  // A tiling Wayland compositor ignores minimize() for an always-on-top
  // dependent dialog, and a browser window cannot hide itself without
  // closing. The player's own close path has the right primitive: Shift+close
  // unpips without pausing, so the player window goes away while the page
  // behind it keeps the song or video playing. Astra's button runs that same
  // path instead of inventing a second one.
  const minimize = doc.createElement("button");
  minimize.type = "button";
  minimize.className = "astra-pip-min";
  minimize.setAttribute("aria-label", "Minimize player (audio keeps playing)");
  minimize.title = "Minimize player — audio keeps playing";
  const minimizePlayer = () => {
    try {
      const close = doc.getElementById("close");
      close?.dispatchEvent(
        new playerWin.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          shiftKey: true,
        }),
      );
    } catch {
      // The native close path is the only owner of the player's teardown.
    }
  };
  minimize.addEventListener("click", minimizePlayer);
  doc.body.append(minimize);

  // The player's own browser holds the PiP document, whose title is always
  // "Picture-in-Picture"; the site's title lives on the tab being cloned.
  // Read that tab, and follow its label while the player is open.
  const tabStrip = parentWin?.gBrowser?.tabContainer ?? null;
  const syncTitle = () => {
    let value = "";
    try {
      value = String(sourceBrowser(playerWin)?.contentTitle || "").trim();
    } catch {
      value = "";
    }
    if (!value) {
      try {
        const clone = String(browser?.contentTitle || "").trim();
        value = clone === "Picture-in-Picture" ? "" : clone;
      } catch {
        value = "";
      }
    }
    title.textContent = value;
  };
  const onTabAttr = (event) => {
    const changed = event.detail?.changed;
    if (!changed || changed.includes("label")) syncTitle();
  };
  try {
    browser?.addEventListener("DOMTitleChanged", syncTitle);
  } catch {
    // A player without a title event keeps the first read.
  }
  try {
    tabStrip?.addEventListener("TabAttrModified", onTabAttr);
    tabStrip?.addEventListener("TabSwapPictureInPicture", onTabAttr, true);
  } catch {
    // No native tab strip in this build; the first read still lands.
  }
  // The engine links the window and its source in the same turn the player
  // attaches, which can be after this load handler. Read again as it settles.
  const retries = [0, 200, 800, 2000].map((ms) =>
    playerWin.setTimeout(syncTitle, ms),
  );
  syncTitle();

  const release = () => {
    for (const timer of retries) playerWin.clearTimeout(timer);
    try {
      browser?.removeEventListener("DOMTitleChanged", syncTitle);
    } catch {
      // The browser went away with the window.
    }
    try {
      tabStrip?.removeEventListener("TabAttrModified", onTabAttr);
      tabStrip?.removeEventListener("TabSwapPictureInPicture", onTabAttr, true);
    } catch {
      // The tab strip went away with the window.
    }
    try {
      observer?.disconnect();
    } catch {
      // Already detached.
    }
    observer = null;
    minimize.removeEventListener("click", minimizePlayer);
    minimize.remove();
    head.remove();
    playerWin.removeEventListener("unload", release);
  };
  playerWin.addEventListener("unload", release, { once: true });
}

export const PipPlayer = { dress };
