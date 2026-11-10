import boundaries from "eslint-plugin-boundaries";
import { fileURLToPath } from "node:url";

const element = (type) => ({ element: { type } });
const layers = ["app", "features", "session", "domain", "shared"];
const downward = layers.map((layer, at) => ({
  from: element(layer),
  allow: { to: element(layers.slice(layer === "features" ? at + 1 : at).concat("styles")) },
}));

export const architecture = {
  files: ["src/**/*.{ts,svelte}"],
  plugins: { boundaries },
  settings: {
    "boundaries/root-path": fileURLToPath(new URL(".", import.meta.url)),
    "boundaries/elements": [
      ...["features", "domain"].map((type) => ({
        type,
        pattern: `src/${type}/*`,
        capture: ["module"],
      })),
      ...["app", "session", "shared", "styles"].map((type) => ({ type, pattern: `src/${type}` })),
    ],
    "boundaries/files": [
      { category: "test", pattern: "**/*.test.ts" },
      { category: "entry", pattern: "src/entries/*.ts" },
    ],
    // P2-T08: `@astra/bridge` lives in `ui/packages/*` (outside root-path),
    // as will any later workspace package. Treat out-of-root resolves as
    // external so `no-unknown-dependencies` stays meaningful for real code.
    "boundaries/flag-as-external": { outsideRootPath: true },
    "import/resolver": {
      typescript: {
        project: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
        extensions: [".ts", ".svelte", ".js"],
      },
    },
  },
  rules: {
    "boundaries/dependencies": [
      "error",
      {
        default: "disallow",
        policies: [
          ...downward,
          // The sidebar composes the utility rail as its leading edge.
          {
            from: { element: { type: "features", captured: { module: "sidebar" } } },
            allow: { to: { element: { type: "features", captured: { module: "rail" } } } },
          },
          // The rail opens the existing space switcher through its public API.
          {
            from: { element: { type: "features", captured: { module: "rail" } } },
            allow: { to: { element: { type: "features", captured: { module: "tabs" } } } },
          },
          // The existing utility host composes real entity views through public APIs.
          {
            from: { element: { type: "features", captured: { module: "tools" } } },
            allow: {
              to: {
                element: {
                  type: "features",
                  captured: {
                    module: [
                      "notes",
                      "tasks",
                      "history",
                      "downloads",
                      "bookmarks",
                      "time",
                      "assist",
                    ],
                  },
                },
              },
            },
          },
          // Bookmark rows open the shared app menu (the menu is the one
          // presenter, not a native popup).
          {
            from: { element: { type: "features", captured: { module: "bookmarks" } } },
            allow: { to: { element: { type: "features", captured: { module: "menus" } } } },
          },
          // The sidebar's options button opens that same shared app menu.
          {
            from: { element: { type: "features", captured: { module: "sidebar" } } },
            allow: { to: { element: { type: "features", captured: { module: "menus" } } } },
          },
          // The tool shelf's right-click menu is the app menu too.
          {
            from: { element: { type: "features", captured: { module: "dock" } } },
            allow: { to: { element: { type: "features", captured: { module: "menus" } } } },
          },
          // The content bar's Back/Forward history menu is the same shared
          // presenter: its rows are drawn by the app, not a native popup.
          {
            from: { element: { type: "features", captured: { module: "toolbar" } } },
            allow: { to: { element: { type: "features", captured: { module: "menus" } } } },
          },
          // Settings edits the sites focus shuts with the same control as Time.
          {
            from: { element: { type: "features", captured: { module: "settings" } } },
            allow: { to: { element: { type: "features", captured: { module: "time" } } } },
          },
          // Page styles are listed and removed where the other per-site choices are.
          {
            from: { element: { type: "features", captured: { module: "settings" } } },
            allow: { to: { element: { type: "features", captured: { module: "assist" } } } },
          },
          // Settings → Spaces edits a space with the switcher's own editor.
          {
            from: { element: { type: "features", captured: { module: "settings" } } },
            allow: { to: { element: { type: "features", captured: { module: "tabs" } } } },
          },
          // The sidebar assistant's composer borrows Work's model chip and dictation.
          {
            from: { element: { type: "features", captured: { module: "assist" } } },
            allow: { to: { element: { type: "features", captured: { module: "work" } } } },
          },
          {
            from: { element: { type: "features", captured: { module: "library" } } },
            allow: { to: { element: { type: "features", captured: { module: "downloads" } } } },
          },
          {
            from: { file: { categories: "entry" } },
            allow: { to: element(["app", "shared", "styles"]) },
          },
          {
            from: { element: { type: "features", captured: { module: "work" } } },
            allow: {
              to: {
                element: {
                  type: "features",
                  captured: {
                    module: ["tasks", "notes", "focus", "activity", "resources", "library"],
                  },
                },
              },
            },
          },
          { from: { file: { categories: "test" } }, allow: { to: element("shared") } },
          {
            to: { element: { type: ["features", "domain"], fileInternalPath: "!index.ts" } },
            disallow: { to: element(["features", "domain"]) },
            message:
              "Import the module public API (index.ts), not another module's implementation.",
          },
        ],
      },
    ],
    "boundaries/no-unknown-dependencies": "error",
    "boundaries/no-unknown-files": "error",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@tauri-apps/api/event",
            message: "Use scoped DOM events; generic Tauri event targets cross surface authority.",
          },
          { name: "@tauri-apps/api/core", message: "Native invocation belongs in shared/ipc." },
        ],
      },
    ],
  },
};

export const primitiveArchitecture = {
  files: ["src/shared/ui/**/*.{ts,svelte}"],
  ignores: ["**/*.test.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: architecture.rules["no-restricted-imports"][1].paths,
        patterns: [
          {
            regex: "(?:^\\$shared/ipc(?:/|$)|(?:^|/)ipc/)",
            message:
              "UI primitives receive props and callbacks; native transport belongs to their owner.",
          },
        ],
      },
    ],
  },
};

export const ipcArchitecture = {
  files: ["src/shared/ipc/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: architecture.rules["no-restricted-imports"][1].paths.filter(
          (path) => path.name !== "@tauri-apps/api/core",
        ),
      },
    ],
  },
};
