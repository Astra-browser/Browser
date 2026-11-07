export { default as SidebarBody } from "./components/SidebarBody.svelte";
export { default as TabList } from "./components/TabList.svelte";
export { default as TabRail } from "./components/TabRail.svelte";
export { default as RailSpaces } from "./components/RailSpaces.svelte";
export const loadTabCapacityState = () => import("./components/TabCapacityState.svelte");
export const loadNavigationError = () => import("./components/NavigationError.svelte");
/** Settings → Spaces edits a space with the same editor the switcher opens. */
export const loadSpaceEditor = () => import("./components/SpaceEditor.svelte");
export { sidebarTree } from "./lib/sidebar-model";
export * as selectionGlide from "./lib/selection-glide";
export { applySpaceTheme, spaceThemeValues } from "./lib/space-theme";
