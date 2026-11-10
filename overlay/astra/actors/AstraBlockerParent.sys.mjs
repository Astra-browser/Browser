/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent half of the page blocker. The child asks for the selectors and
// scriptlet payload of its document; the engine lookup is synchronous and
// lives in the parent process. Nothing is cached here: the cache belongs to
// the native engine and is keyed by URL.

export class AstraBlockerParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name !== "astra-blocker-cosmetic") return null;
    let enabled = true;
    let cosmetic = true;
    let scriptlets = true;
    try {
      enabled = Services.prefs.getBoolPref("astra.blocker.enabled", true);
      cosmetic = Services.prefs.getBoolPref("astra.blocker.cosmetic", true);
      scriptlets = Services.prefs.getBoolPref("astra.blocker.scriptlets", true);
    } catch {
      // Defaults are on.
    }
    if (!enabled || (!cosmetic && !scriptlets)) {
      return { selectors: [], script: "", procedural: [], enabled: false };
    }

    const data = message.data ?? {};
    const url = typeof data.url === "string" ? data.url : "";
    if (!/^https?:/iu.test(url)) {
      return { selectors: [], script: "", procedural: [] };
    }
    try {
      const service = Cc["@astra/blocker;1"].getService(
        Ci.nsIAstraBlockerService,
      );
      const classes = Array.isArray(data.classes)
        ? data.classes.filter((value) => typeof value === "string").slice(0, 512)
        : [];
      const ids = Array.isArray(data.ids)
        ? data.ids.filter((value) => typeof value === "string").slice(0, 512)
        : [];
      const parsed = JSON.parse(
        service.cosmeticFor(
          url,
          JSON.stringify(classes),
          JSON.stringify(ids),
        ) || "{}",
      );
      return {
        selectors:
          cosmetic && Array.isArray(parsed.selectors) ? parsed.selectors : [],
        script:
          scriptlets && typeof parsed.script === "string" ? parsed.script : "",
        procedural:
          cosmetic && Array.isArray(parsed.procedural) ? parsed.procedural : [],
      };
    } catch {
      return { selectors: [], script: "", procedural: [] };
    }
  }
}
