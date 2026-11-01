// P0-T07 golden build: the production UI graph with `@tauri-apps/api/*`
// aliased to deterministic mocks, served as plain documents for headless
// capture. Not shipped: output goes to tools/golden-capture/dist/.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { alias } from "./aliases.ts";
import { i18nLocales } from "./i18n-locales.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const golden = fileURLToPath(new URL("./golden/mocks/", import.meta.url));

export default defineConfig({
  appType: "mpa",
  resolve: {
    alias: {
      ...alias,
      "@tauri-apps/api/core": `${golden}/tauri-core.ts`,
      "@tauri-apps/api/event": `${golden}/tauri-event.ts`,
      "@tauri-apps/api/window": `${golden}/tauri-window.ts`,
      "@tauri-apps/api/webview": `${golden}/tauri-webview.ts`,
    },
  },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/shared/i18n",
      emitTsDeclarations: false,
      strategy: ["baseLocale"],
    }),
    i18nLocales(),
    svelte(),
    tailwindcss(),
  ],
  clearScreen: false,
  build: {
    outDir: "../../tools/golden-capture/dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      input: { golden: fileURLToPath(new URL("./golden.html", import.meta.url)) },
    },
  },
  server: { port: 1421, strictPort: true },
  root,
});
