/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Astra's face on Gecko's media Picture-in-Picture player. The engine still
// owns the video, the scrubber and the transport; this only copies the
// interface's current theme and puts the title in a slim head strip. The
// stylesheet itself is linked by the player document, so it parses with the
// native player skin. Everything is released with the player window.

function dress(playerWin, parentWin) {
  const doc = playerWin?.document;
  if (!doc || doc.documentElement.hasAttribute("data-astra-pip")) {
    return;
  }
  doc.documentElement.setAttribute("data-astra-pip", "");

  const source = parentWin?.document?.querySelector(".astra-frame");
  const applyTheme = () => {
    const theme =
      source?.getAttribute("data-astra-theme") == "light" ? "light" : "dark";
    doc.documentElement.setAttribute("data-astra-theme", theme);
  };
  applyTheme();
  let observer = null;
  if (source) {
    try {
      observer = new playerWin.MutationObserver(applyTheme);
      observer.observe(source, {
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

  const syncTitle = () => {
    title.textContent = String(browser?.contentTitle || "").trim();
  };
  try {
    browser?.addEventListener("DOMTitleChanged", syncTitle);
  } catch {
    // A player without a title event keeps the first read.
  }
  syncTitle();

  const release = () => {
    try {
      browser?.removeEventListener("DOMTitleChanged", syncTitle);
    } catch {
      // The browser went away with the window.
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
