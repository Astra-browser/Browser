// P0-T07 golden entry: deterministic standalone boot for screenshots.
// `?screen=<name>&theme=<light|dark>` selects the capture. The build aliases
// `@tauri-apps/api/*` to the mocks in `./mocks`, so no native host exists.

import { screens } from "./screens";

const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "shell";

async function boot(): Promise<void> {
  const setup = screens[screen];
  if (!setup) {
    document.body.textContent = `unknown golden screen: ${screen}`;
    throw new Error(`unknown golden screen: ${screen}`);
  }
  try {
    await setup();
  } catch (error) {
    console.error(`[golden] screen ${screen} failed`, error);
    document.documentElement.dataset.golden = "failed";
    throw error;
  }
}

void boot();
