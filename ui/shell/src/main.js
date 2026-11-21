import { mount } from "svelte";
import Shell from "./Shell.svelte";
import { isPopupWindow, POPUP_ATTRIBUTE } from "./popup.js";

const target = document.getElementById("astra-root");
if (!target) {
  throw new Error("[astra-shell] #astra-root missing (ASTRA-0002 hook not applied?)");
}

if (isPopupWindow(window)) {
  // A page's sign-in popup keeps the engine's small window; the product shell
  // never mounts here, so the native chrome (and window.close()) answers.
  document.documentElement.setAttribute(POPUP_ATTRIBUTE, "");
  target.remove();
} else {
  mount(Shell, { target });
}
