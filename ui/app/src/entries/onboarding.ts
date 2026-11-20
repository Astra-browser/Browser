import { getCurrentWindow } from "@tauri-apps/api/window";
import { mount } from "svelte";
import App from "$app/onboarding/OnboardingApp.svelte";
import { ensureBridge } from "$shared/ipc/bridge";

// A first run opens this page in the main window's app frame instead of the
// browser; the host replaces it with the browser once the flow is finished
// (`Boot.onboardingFinish`). The page is packaged beside browser-chrome.html
// by `bun run --filter @astra/frame build:chrome`.

const SURFACE = "onboarding";
const SHELL_NS = "astra-shell";

/**
 * Tell the embedding shell this document is ready, so it retires its boot
 * ground and reveals the frame. Same seam as `chrome-entry/browser-chrome.ts`;
 * standalone (no shell) is a no-op.
 */
function announce(mode: string): void {
  try {
    const hook = (globalThis as Record<string, unknown>).__ASTRA_READY__;
    if (typeof hook === "function") {
      (hook as (mode: string) => void)(mode);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ ns: SHELL_NS, kind: "ready", mode }, "*");
    }
  } catch {
    // No shell to tell; the page still runs.
  }
}

/** Announce once the first onboarding frame exists, or shortly after mount so
 *  the shell never keeps its boot ground over a page that is still decoding
 *  its sky. */
function announceWhenDrawn(mode: string): void {
  const target = document.getElementById("root");
  if (!(target instanceof HTMLElement)) return;
  let done = false;
  let timer = 0;
  const say = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    observer.disconnect();
    announce(mode);
  };
  const observer = new MutationObserver(() => {
    if (target.querySelector(".onboarding")) say();
  });
  observer.observe(target, { childList: true, subtree: true });
  if (target.querySelector(".onboarding")) say();
  timer = window.setTimeout(say, 2500);
}

try {
  const bridge = await ensureBridge(SURFACE, window.location.search);
  if (getCurrentWindow().label !== SURFACE) throw new Error("unexpected native surface");
  const target = document.getElementById("root");
  if (!(target instanceof HTMLElement)) throw new Error("trusted UI root is unavailable");
  mount(App, { target });
  announceWhenDrawn(bridge.mode);
} catch {
  console.error("trusted onboarding initialization failed");
}
