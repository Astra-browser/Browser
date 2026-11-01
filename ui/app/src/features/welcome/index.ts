export { default as Welcome } from "./components/Welcome.svelte";
export { WELCOME_STEPS, neighbour, position, type WelcomeStep } from "./lib/steps";
export {
  COMPLETED_KEY,
  THEMES,
  THEME_KEY,
  isFirstRun,
  isThemeChoice,
  persistWelcome,
  readTheme,
  type ThemeChoice,
  type WelcomeResult,
} from "./lib/first-run";
