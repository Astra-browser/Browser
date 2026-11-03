import { globSync, readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { alias } from "./aliases.ts";
import { i18nLocales } from "./i18n-locales.ts";
import { benchPhotos, webkitFootprint } from "./vitest.bench-commands.ts";

// Phase-2 native artifacts (`desktop/`, `crates/…`) do not exist yet in the
// Astra tree. Component-project `provide` values degrade to "" with a warning
// so config load and the unit project keep working; component tests regain
// full fixtures when the artifacts land (P2/P4). Fixture paths get rewired to
// the Astra layout at that point (tracked in SESSION.md).
const warnedArtifacts = new Set<string>();
function readNativeArtifact(url: URL): string {
  try {
    return readFileSync(url, "utf8");
  } catch {
    if (!warnedArtifacts.has(url.href)) {
      warnedArtifacts.add(url.href);
      console.warn(`[astra] native artifact missing (Phase 2): ${url.pathname}`);
    }
    return "";
  }
}

// Icons are imported one module each, and Vite meets each only when a test
// first reaches it. On a cold cache (every CI runner) that re-optimises the
// dependencies mid-run and reloads the page under the running tests, so the
// whole set is named up front.
const icons = [
  ...new Set(
    globSync("src/**/*.{ts,svelte}").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/["'](@hugeicons\/core-free-icons\/\w+)["']/gu)].map(
        (match) => match[1]!,
      ),
    ),
  ),
].sort();

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        plugins: [svelte(), i18nLocales()],
        test: {
          name: "unit",
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.ts", "*.test.ts"],
          exclude: ["**/*.component.test.ts"],
          restoreMocks: true,
          unstubGlobals: true,
        },
      },
      {
        resolve: { alias },
        plugins: [svelte(), tailwindcss(), i18nLocales()],
        optimizeDeps: {
          include: [
            "@xyflow/svelte",
            "elkjs/lib/elk-worker.min.js",
            "@tiptap/core",
            "@tiptap/extension-document",
            "@tiptap/extension-paragraph",
            "@tiptap/extension-text",
            "@tiptap/extension-heading",
            "@tiptap/extension-bold",
            "@tiptap/extension-italic",
            "@tiptap/extension-code",
            "@tiptap/extension-bullet-list",
            "@tiptap/extension-ordered-list",
            "@tiptap/extension-list-item",
            "@tiptap/extension-blockquote",
            "@tiptap/extension-code-block",
            "@tiptap/extension-hard-break",
            "@tiptap/extension-strike",
            "@tiptap/extension-horizontal-rule",
            "@tiptap/pm/history",
            "@tiptap/pm/model",
            "@tiptap/pm/state",
            "@tiptap/pm/view",
            "marked",
            "@hugeicons/core-free-icons",
            ...icons,
          ],
        },
        test: {
          name: "component",
          provide: {
            privilegedPermissionsPolicy:
              /const PRIVILEGED_PERMISSIONS_POLICY: &str = "([^"]+)";/u.exec(
                readNativeArtifact(new URL("../desktop/src/lib.rs", import.meta.url)),
              )?.[1] ?? "",
            formSubmitRuntime: readNativeArtifact(
              new URL(
                "../crates/astra-engine/src/platform/form_submit_observer.js",
                import.meta.url,
              ),

            ),
            formActionRuntime: readNativeArtifact(
              new URL(
                "../crates/astra-engine/src/platform/macos/agentic_form_diagnostic_probe.js",
                import.meta.url,
              ),

            ),
            formOracleRuntime: readNativeArtifact(
              new URL("../crates/astra-engine/src/host/work_form_oracle.js", import.meta.url),

            ),
            pixelPrivacyRuntime: readNativeArtifact(
              new URL(
                "../crates/astra-agentic/assets/semantic-pixel-privacy-v1.js",
                import.meta.url,
              ),

            ),
            semanticMediaRuntime:
              readNativeArtifact(
                new URL(
                  "../crates/astra-agentic/assets/semantic-record-media-v1.js",
                  import.meta.url,
                ),

              ) +
              readNativeArtifact(
                new URL("../crates/astra-agentic/assets/semantic-runtime-v1.js", import.meta.url),

              ),
            humanWallSurvey: readNativeArtifact(
              new URL("../crates/astra-agentic/assets/work-human-wall-v1.js", import.meta.url),

            ),
            contentStyleSource: readNativeArtifact(
              new URL("../crates/astra-engine/src/host/content_style.js", import.meta.url),

            ),
            packagedStylePolicy: {
              styleSource: (() => {
                // No Tauri desktop exists in the Astra tree (Gecko host owns
                // CSP; enforced at P1-T06). Empty policy until the native
                // artifact this mirrors lands.
                try {
                  return JSON.parse(
                    readNativeArtifact(new URL("../desktop/tauri.conf.json", import.meta.url)),
                  ).app.security.csp["style-src"] as string;
                } catch {
                  return "";
                }
              })(),
              // Match the HTML style elements to which Tauri adds nonce sources.
              inlineStyleCount: ["./browser.html", "./panel.html"].reduce(
                (count, path) =>
                  count +
                  (readNativeArtifact(new URL(path, import.meta.url)).match(/<style(?:\s|>)/giu)
                    ?.length ?? 0),
                0,
              ),
            },
          },
          setupFiles: ["./vitest.component.setup.ts"],
          include: ["src/**/*.component.test.ts"],
          // Playwright retires the oldest of 10,000 live requests. Parallel
          // files flood that window while a slow manual mock is still being
          // resolved, and its route is collected before it can be fulfilled.
          fileParallelism: false,
          browser: {
            enabled: true,
            headless: true,
            screenshotFailures: false,
            commands: { benchPhotos, webkitFootprint },
            // Retina is the display this chrome is drawn for, and the one
            // where a radius or a hairline can actually be judged.
            provider: playwright({ contextOptions: { deviceScaleFactor: 2 } }),
            instances: [
              {
                browser:
                  process.env.ASTRA_COMPONENT_BROWSER === "chromium" ||
                  process.env.ASTRA_COMPONENT_BROWSER === "webkit"
                    ? process.env.ASTRA_COMPONENT_BROWSER
                    : process.platform === "darwin"
                      ? "webkit"
                      : "chromium",
              },
            ],
          },
        },
      },
    ],
  },
});
