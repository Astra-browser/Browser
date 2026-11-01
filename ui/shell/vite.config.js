import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// P1-T08: builds the Svelte hello bundle for chrome://astra/.
// Stable filenames (no hashes) so overlay/astra/jar.mn stays fixed.
// Separate .css via <link> (no runtime style injection -> chrome-CSP safe).
// Output is COMMITTED under overlay/astra/chrome/shell/ (generated artifact;
// rebuild with `bun run --filter @astra/shell-hello build`).
export default defineConfig({
  plugins: [svelte({ compilerOptions: { dev: false } })],
  build: {
    outDir: "../../overlay/astra/chrome/shell",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/main.js",
      output: {
        entryFileNames: "shell.mjs",
        assetFileNames: "shell.css",
        chunkFileNames: "shell.mjs",
        codeSplitting: false,
        format: "es",
      },
    },
  },
});
