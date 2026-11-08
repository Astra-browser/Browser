/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Cross-space tab cloning.
//
// A clone is a new native tab in the target space's container; the source tab
// stays where it is. The target space must belong to the profile in front. A
// private window has no spaces and refuses.
//
// History: Gecko's `SessionStore.duplicateTab` copies the tab's session state
// (including back/forward entries) but keeps the source container. Moving that
// tab to another container with `tab.setUserContextId` does not re-open the
// document in the new partition, so the clone is loaded again in the target
// container. The back/forward entries are kept when the engine accepts the
// reload; this module never claims more than the resulting tab can show.

import {
  HOST_API_VERSION,
  Tabs,
  __activeProfileId,
  __spaceUserContextId,
  __spacesState,
} from "./Tabs.sys.mjs";
import { __nativeBinding } from "./SplitView.sys.mjs";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function services() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

function ownedSpace(spaceId) {
  const id = typeof spaceId === "string" && spaceId !== "" ? spaceId : "";
  const space = (__spacesState()?.spaces ?? []).find((row) => row.id === id);
  if (!space || space.profile_id !== __activeProfileId()) return null;
  return space;
}

function isPrivateWindow(win) {
  try {
    const CU = globalThis.ChromeUtils;
    if (win && CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      return PrivateBrowsingUtils.isWindowPrivate(win) === true;
    }
    return win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary";
  } catch {
    return false;
  }
}

function systemPrincipal() {
  try {
    return services()?.scriptSecurityManager?.getSystemPrincipal?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * A background tab is the safe default: a clone should not steal the page in
 * front, and a tab in a space that is not in front cannot be selected without
 * switching spaces.
 */
export const SpaceClone = {
  async clone({
    request_id = "",
    tab = "",
    space = "",
    include_history = false,
    background = true,
    window_id = "",
  } = {}) {
    const binding = __nativeBinding(window_id);
    if (!binding?.gb) return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(request_id, "private_context", "a private window clones no tab");
    }
    const source = binding.tabOf.get(tab);
    if (!source) return err(request_id, "no_such_tab", "that tab has no live view");
    const target = ownedSpace(space);
    if (!target) return err(request_id, "space_not_owned", "that space is not in this profile");
    let url = "";
    let title = "";
    try {
      url = source.linkedBrowser?.currentURI?.spec ?? "";
      title = source.label || source.linkedBrowser?.contentTitle || "";
    } catch {
      url = "";
    }
    if (!/^https?:/u.test(url)) {
      return err(request_id, "not_cloneable", "only a web page can be cloned");
    }
    let native = null;
    const userContextId = __spaceUserContextId(target.id);
    if (include_history === true) {
      try {
        const { SessionStore } = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
        native = SessionStore.duplicateTab(binding.win, source, 0, true, {
          inBackground: background === true,
        });
        if (native) {
          native.setUserContextId(userContextId);
          // The duplicate still holds the source container's document; load
          // it again so the target space's cookies/storage are the live ones.
          native.linkedBrowser?.reload?.();
        }
      } catch {
        native = null;
      }
    }
    if (!native) {
      try {
        native = binding.gb.addTab(url, {
          inBackground: background === true,
          triggeringPrincipal: systemPrincipal(),
          userContextId,
        });
      } catch {
        native = null;
      }
    }
    if (!native) return err(request_id, "clone_refused", "the engine refused the clone");
    // TabOpen is synchronous; Content adopts the native tab and stamps the
    // Astra id before addTab/duplicateTab returns. Wait one turn for the
    // adoption when a session restore defers TabOpen.
    let astraId = binding.idOf.get(native) ?? native.getAttribute?.("astra-tab-id") ?? "";
    if (!astraId) {
      await new Promise((resolve) => {
        try {
          binding.win.setTimeout(resolve, 0);
        } catch {
          resolve();
        }
      });
      astraId = binding.idOf.get(native) ?? native.getAttribute?.("astra-tab-id") ?? "";
    }
    if (!astraId) {
      try {
        binding.gb.removeTab(native);
      } catch {
        // Already gone.
      }
      return err(request_id, "adopt_failed", "the cloned tab did not join the model");
    }
    // The adoption put it in the active space; move it to the target space.
    await Tabs.moveTabToSpace({ request_id, tab: astraId, space: target.id });
    return ok(request_id, {
      cloned: true,
      astra_tab_id: astraId,
      space_id: target.id,
      url,
      title,
      include_history: include_history === true,
      background: background === true,
    });
  },
};
