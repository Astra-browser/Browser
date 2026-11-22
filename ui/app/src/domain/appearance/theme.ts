import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";

import {
  DEFAULT_CONTRAST,
  DEFAULT_THEME,
  contrastOf,
  forkOf,
  preset,
  resolveTheme,
  sameSpec,
  seedVars,
  type ThemeSpec,
} from "./palette";

export type Appearance = "system" | "light" | "dark";

/** The appearance choice. One spelling, the one `astra_core::settings`
 *  validates; the onboarding flow writes the same key. */
const APPEARANCE_KEY = "appearance.theme";
/** The pre-0.1.755 spelling. Read once to migrate, never written. */
const LEGACY_APPEARANCE_KEY = "appearance";

/** The stored customization, as preference values. */
export type Customization = {
  theme: string;
  custom: string;
  /** `ui.theme-contrast`, 0 to 100. */
  level: string;
  /** The accessibility switch, which takes contrast to its full. */
  contrast: boolean;
  font: string;
  fontSize: string;
  codeFont: string;
};

const media = window.matchMedia("(prefers-color-scheme: light)");
// The interface ships on its warm light field; dark is the explicit choice.
let appearance: Appearance = "light";
let lifecycle = 0;
let initialized = false;
let initializing: Promise<void> | null = null;
let unlisten: (() => void) | null = null;

/** Only this module writes appearance axes on the document root. */
export function applyUiPreferences(tint: string, reduceMotion: boolean) {
  document.documentElement.setAttribute("data-tint", tint);
  setReducedMotion(reduceMotion);
  publishAppearance();
}

/** The shell document paints the window ground behind this frame, so it has
 *  to hear the same material, theme, accent and density this root resolves.
 *  It also needs the resolved ground itself: while the page bar floats, the
 *  frame is raised and clipped, and the gutter outside that clip is the
 *  shell's. A hardcoded shell colour there changed the window on reveal; the
 *  same ground on both layers keeps the edge still. */
function publishAppearance() {
  const root = document.documentElement;
  try {
    if (window.parent === window) return;
    // `.shell` is the element that paints the field, not `body` (a material
    // tier gives the body its own chrome and the field sits above it).
    const shell = document.querySelector<HTMLElement>(".shell");
    const ground = shell ? getComputedStyle(shell) : null;
    window.parent.postMessage(
      {
        ns: "astra-shell",
        kind: "appearance",
        material: root.getAttribute("data-material") ?? "none",
        theme: root.getAttribute("data-theme") === "light" ? "light" : "dark",
        accent: root.getAttribute("data-tint") ?? "graphite",
        density: root.getAttribute("data-density") ?? "comfortable",
        groundImage:
          ground && ground.backgroundImage !== "none" && !ground.backgroundImage.includes("url(")
            ? ground.backgroundImage
            : "",
        groundColor:
          ground?.backgroundColor && ground.backgroundColor !== "rgba(0, 0, 0, 0)"
            ? ground.backgroundColor
            : "",
      },
      "*",
    );
  } catch {
    // A standalone preview has no shell to tell.
  }
}

export function setReducedMotion(reduceMotion: boolean) {
  document.documentElement.setAttribute("data-reduce-motion", String(reduceMotion));
}

let customization: Customization | null = null;
let draft: ThemeSpec | null = null;
let draftLevel: number | null = null;
const graphite = forkOf(preset(DEFAULT_THEME)!);

export function applyCustomization(next: Customization) {
  customization = next;
  render();
}

const fields = {
  "ui.theme": "theme",
  "ui.theme-custom": "custom",
  "ui.theme-contrast": "level",
  "ui.contrast": "contrast",
  "ui.font": "font",
  "ui.font-size": "fontSize",
  "ui.code-font": "codeFont",
} as const satisfies Record<string, keyof Customization>;
export type CustomizationKey = keyof typeof fields;
export const customizationKeys = Object.keys(fields) as CustomizationKey[];

/** For a surface without the preferences store, such as the launcher: one
 *  stored or projected value at a time. */
export function customize(key: CustomizationKey, value: string) {
  const next: Customization = customization ?? {
    theme: "astra",
    custom: "",
    level: String(DEFAULT_CONTRAST),
    contrast: false,
    font: "system",
    fontSize: "13",
    codeFont: "system",
  };
  const field = fields[key];
  applyCustomization(
    field === "contrast" ? { ...next, contrast: value === "true" } : { ...next, [field]: value },
  );
}

/** A theme being edited, shown everywhere before it is written. */
export function previewTheme(spec: ThemeSpec | null) {
  draft = spec;
  render();
}

/** A contrast being dragged, shown before it is written. */
export function previewContrast(level: number | null) {
  draftLevel = level;
  render();
}

function render() {
  if (customization === null) return;
  const root = document.documentElement;
  const raised = customization.contrast;
  const spec = draft ?? resolveTheme(customization.theme, customization.custom).spec;
  const level = raised ? 100 : (draftLevel ?? contrastOf(customization.level));
  const vars = seedVars(spec, level);
  // Graphite keeps its literal tokens: only a chosen theme derives a ladder.
  if (level === DEFAULT_CONTRAST && sameSpec(spec, graphite)) {
    root.removeAttribute("data-palette");
    for (const name of Object.keys(vars)) root.style.removeProperty(name);
  } else {
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.setAttribute("data-palette", "");
  }
  root.setAttribute("data-font", customization.font);
  root.setAttribute("data-font-size", customization.fontSize);
  root.setAttribute("data-code-font", customization.codeFont);
  publishAppearance();
}

export function applyLayout(axes: { density: "compact" | "comfortable"; contrast: boolean }) {
  document.documentElement.setAttribute("data-density", axes.density);
  document.documentElement.setAttribute("data-contrast", String(axes.contrast));
  publishAppearance();
}

function apply() {
  const light = appearance === "light" || (appearance === "system" && media.matches);
  document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
  publishAppearance();
}

/**
 * The window material the host actually resolved, plus the tiers this build
 * can draw. The settings picker reads `data-materials` so an unsupported
 * platform shows only the solid tier instead of a list that does nothing.
 */
function applyMaterial(material: string, materials?: readonly string[]) {
  const root = document.documentElement;
  root.setAttribute("data-material", material);
  if (Array.isArray(materials) && materials.length > 0) {
    root.setAttribute("data-materials", materials.join(","));
  }
  publishAppearance();
}

async function initialize(generation: number) {
  // Establish system dark/light synchronously before the first native IPC
  // await so the hidden bootstrap document already has deterministic tokens.
  apply();
  let commandAppearance: Appearance | null = null;
  let commandMaterial: string | null = null;
  const listener = events.uiCommand.listen((e) => {
    if (generation !== lifecycle) return;
    const id = e.payload;
    if (id.startsWith("material.")) {
      const material = id.slice("material.".length);
      if (["none", "vibrancy", "liquid_glass", "acrylic", "mica"].includes(material)) {
        commandMaterial = material;
        applyMaterial(material);
      }
      return;
    }
    // A keyboard or menu theme command is also a choice: store it so the next
    // launch starts in the same mode. Settings' own write arrives typed below.
    if (!id.startsWith("theme.")) return;
    const next = id.slice("theme.".length);
    if (next !== "light" && next !== "dark" && next !== "system") return;
    commandAppearance = next;
    appearance = next;
    apply();
    void commands.settingSet(APPEARANCE_KEY, next).catch(() => {});
  });
  const preferenceListener = events.preferenceChanged.listen(({ payload }) => {
    if (generation !== lifecycle) return;
    const key = payload?.key;
    const value = String(payload?.value ?? "");
    // A material choice is a capability decision, not just a stored string:
    // ask the host to resolve and apply it, then paint the tier it can draw.
    if (key === "ui.material") {
      void commands
        .uiInfo()
        .then((info) => {
          if (generation !== lifecycle) return;
          applyMaterial(info.material, info.materials);
        })
        .catch(() => {});
      return;
    }
    // Settings writes the stored `appearance.theme` preference; every other
    // surface hears that push, so the window must apply it too. The old
    // `appearance` spelling is still accepted while profiles migrate.
    if (key !== "appearance.theme" && key !== "appearance") return;
    if (value !== "light" && value !== "dark" && value !== "system") return;
    commandAppearance = value;
    appearance = value;
    apply();
  });
  const stopListeners = async () => {
    (await listener)();
    (await preferenceListener)();
  };

  try {
    const info = await commands.uiInfo();
    if (generation !== lifecycle) {
      await stopListeners();
      return;
    }
    applyMaterial(commandMaterial ?? info.material, info.materials);

    let stored = await commands.settingGet(APPEARANCE_KEY);
    if (generation !== lifecycle) {
      await stopListeners();
      return;
    }
    if (stored === null) {
      // A profile from before the split kept the choice under `appearance`.
      // Adopt it into the key the core validates.
      const legacy = await commands.settingGet(LEGACY_APPEARANCE_KEY);
      if (generation !== lifecycle) {
        await stopListeners();
        return;
      }
      if (legacy === "light" || legacy === "dark" || legacy === "system") {
        void commands.settingSet(APPEARANCE_KEY, legacy).catch(() => {});
        stored = legacy;
      }
    }
    if (
      commandAppearance === null &&
      (stored === "light" || stored === "dark" || stored === "system")
    ) {
      appearance = stored;
    }
    apply();

    const [stopCommand, stopPreference] = await Promise.all([listener, preferenceListener]);
    if (generation !== lifecycle) {
      stopCommand();
      stopPreference();
      return;
    }
    media.addEventListener("change", apply);
    unlisten = () => {
      stopCommand();
      stopPreference();
    };
    initialized = true;
  } catch (error) {
    await stopListeners().catch(() => {});
    throw error;
  }
}

export function init(): Promise<void> {
  if (initializing !== null) return initializing;
  if (initialized) {
    apply();
    return Promise.resolve();
  }

  const generation = ++lifecycle;
  const task = initialize(generation);
  initializing = task;
  void task.then(
    () => {
      if (initializing === task) initializing = null;
    },
    () => {
      if (initializing === task) initializing = null;
    },
  );
  return task;
}

export function dispose() {
  if (!initialized && initializing === null && unlisten === null) return;

  lifecycle += 1;
  initialized = false;
  initializing = null;
  media.removeEventListener("change", apply);
  unlisten?.();
  unlisten = null;
}
