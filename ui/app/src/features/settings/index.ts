export * as preview from "./lib/preview.svelte";
export const loadSettings = () => import("./components/Settings.svelte");
// The column's settings rail belongs to the page it stands beside, so it
// loads with it rather than in the browser's startup graph.
export const loadSettingsNavigation = () => import("./components/SettingsNavigation.svelte");
export { ask as askSettings, handleNativeSection } from "./lib/settings-state.svelte";
export const loadClearSiteData = () => import("./components/ClearSiteData.svelte");
