export { default as ExtensionsSection } from "./components/ExtensionsSection.svelte";
export { default as PinnedExtensions } from "./components/PinnedExtensions.svelte";
/** The top bar's hub is opened on demand: its menu machinery is not startup. */
export const loadExtensionHub = () => import("./components/ExtensionHub.svelte");
