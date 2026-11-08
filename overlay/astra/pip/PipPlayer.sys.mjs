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
    head.remove();
    playerWin.removeEventListener("unload", release);
  };
  playerWin.addEventListener("unload", release, { once: true });
}

export const PipPlayer = { dress };
