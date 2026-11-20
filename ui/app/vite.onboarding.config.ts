import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import { alias } from "./aliases.ts";
import { frameConfig } from "./vite.frame.ts";

// Two builds of the same page:
//   - the golden `build` (no mode): onboarding.html under the default outDir,
//     byte-budgeted by astra-bootstrap-boundaries like the browser page;
//   - `--mode chrome` (run by `build:chrome`): the packaged page beside
//     browser-chrome.html in `overlay/astra/chrome/app/`, so the first-run
//     document is jar.mn-registered with relative asset URLs and the bridge
//     shim instead of a Tauri runtime.
//
// The chrome build is a second pass into the same outDir, so it must not empty
// it (the browser graph is already there) and it drops the golden page-set
// plugin like vite.chrome.ts does — stage-chrome.mjs owns the chrome audits.

const chromeOutDir = fileURLToPath(new URL("../../overlay/astra/chrome/app", import.meta.url));
const shim = fileURLToPath(new URL("../packages/bridge/src/tauri-shim.ts", import.meta.url));

function chromeSanitizeFileName(name: string): string {
  // jar.mn entries allow [\w\d.\-_/+@] only; Vite joins merged chunk names
  // with `~`, which breaks `mach build faster` at jar parsing.
  // eslint-disable-next-line no-control-regex -- Vite's default sanitizer strips control bytes.
  return name.replace(/[?*~|<>:"\\\x00-\x1f]/g, (ch) => (ch === "~" ? "-" : "_"));
}

export default defineConfig(({ mode }) => {
  const base = frameConfig(["onboarding"]) as UserConfig;
  if (mode !== "chrome") return base;

  const baseBuild = base.build ?? {};
  const baseRolldown = baseBuild.rolldownOptions ?? {};
  const baseOutput = baseRolldown.output ?? {};
  const basePlugins = base.plugins ?? [];

  return {
    ...base,
    base: "./",
    plugins: (Array.isArray(basePlugins) ? basePlugins.flat(10) : [basePlugins]).filter(
      (p) => p && (p as { name?: string }).name !== "astra-bootstrap-boundaries",
    ),
    resolve: {
      ...base.resolve,
      alias: {
        ...alias,
        "@tauri-apps/api/core": shim,
        "@tauri-apps/api/event": shim,
        "@tauri-apps/api/window": shim,
      },
    },
    build: {
      ...baseBuild,
      outDir: chromeOutDir,
      // The browser graph is built first into the same tree.
      emptyOutDir: false,
      rolldownOptions: {
        ...baseRolldown,
        output: {
          ...baseOutput,
          sanitizeFileName: chromeSanitizeFileName,
        },
        input: {
          onboarding: fileURLToPath(new URL("./onboarding.html", import.meta.url)),
        },
      },
    },
  };
});
