<script lang="ts">
  import PreferenceSelect from "../PreferenceSelect.svelte";
  import ZoomLevels from "../ZoomLevels.svelte";
  import ModePicker from "../appearance/ModePicker.svelte";
  import ThemeGallery from "../appearance/ThemeGallery.svelte";
  import ThemeColors from "../appearance/ThemeColors.svelte";
  import FontPicker from "../appearance/FontPicker.svelte";
  import { createThemeEditor } from "../../lib/theme-editor.svelte";
  import { codeFonts, installedCodeFonts } from "../../lib/code-fonts";
  import * as m from "$shared/i18n/messages";
  import { preferences } from "$domain/preferences";
  import type { Mode } from "$domain/appearance";
  import Select from "$shared/ui/Select";
  import Switch from "$shared/ui/Switch";
  import Slider from "$shared/ui/Slider";
  import SegmentedControl from "$shared/ui/SegmentedControl";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import { onDestroy, onMount } from "svelte";
  import { IS_WINDOWS } from "$shared/platform";

  const editor = createThemeEditor();
  onDestroy(() => editor.dispose());

  // Read from the root as the page is created, so its first frame is
  // already in the window's mode and material.
  const root = document.documentElement;
  const rootMode = (): Mode => (root.dataset.theme === "light" ? "light" : "dark");
  let material = $state(root.dataset.material ?? "none");
  // The tiers the host can draw on this machine (`uiInfo().materials`). It is
  // empty in a standalone preview, where the window's own list is the
  // fallback below.
  let materialTiers = $state<string[]>([]);
  let windowMode = $state<Mode>(rootMode());
  // Colours are edited for one mode at a time; it starts as the window's.
  let mode = $state<Mode>(rootMode());
  let installed = $state<string[]>([]);
  onMount(() => {
    const readTiers = () =>
      (root.dataset.materials ?? "")
        .split(",")
        .map((tier) => tier.trim())
        .filter(Boolean);
    const update = () => {
      material = root.dataset.material ?? "none";
      materialTiers = readTiers();
      const next = rootMode();
      if (next !== windowMode) mode = next;
      windowMode = next;
    };
    update();
    installed = installedCodeFonts();
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-material", "data-materials", "data-theme"],
    });
    return () => observer.disconnect();
  });

  // Then material labels, and the one the setting offers. A platform with no
  // native glass offers only the solid tier: the list is a capability, not a
  // wish. `auto` is only a choice when there is a tier above solid.
  const materialLabels: Record<string, () => string> = {
    liquid_glass: m.settings_material_glass,
    vibrancy: m.settings_material_vibrancy,
    acrylic: m.settings_material_acrylic,
    mica: m.settings_material_mica,
    none: m.settings_material_solid,
  };
  const availableMaterials = $derived(
    materialTiers.length > 0 ? materialTiers : IS_WINDOWS ? ["none", "mica"] : ["none"],
  );
  const materialOptions = $derived.by(() => {
    const tiers = availableMaterials.filter((tier) => tier !== "none");
    return [
      ...(tiers.length > 0 ? [{ value: "auto", label: m.settings_material_automatic() }] : []),
      ...tiers.map((tier) => ({
        value: tier,
        label: (materialLabels[tier] ?? m.settings_material_solid)(),
      })),
      { value: "none", label: m.settings_material_solid() },
    ];
  });
  const materialChoice = $derived(preferences.value("ui.material"));
  const materialValue = $derived(
    materialOptions.some((option) => option.value === materialChoice) ? materialChoice : "none",
  );
  // A stored choice this window cannot install says what it is showing
  // instead; the choice is kept, so a machine that gains the tier gets it back.
  let fallback = $derived.by(() => {
    const chosen = materialChoice;
    if (chosen === null || chosen === undefined || chosen === "") return false;
    if (!materialOptions.some((option) => option.value === chosen)) return true;
    return chosen !== "auto" && chosen !== "none" && chosen !== material;
  });

  // The tint is shown as it is dragged and written once it rests. Windows
  // tints with the theme on its own, so there it is not offered.
  let tintDraft = $state<number | null>(null);
  let tint = $derived(tintDraft ?? Number(preferences.value("ui.window-tint")));
  let tintTimer: ReturnType<typeof setTimeout> | null = null;
  function writeTint() {
    if (tintTimer !== null) clearTimeout(tintTimer);
    tintTimer = null;
    if (tintDraft === null) return;
    const next = String(tintDraft);
    void preferences.set("ui.window-tint", next).finally(() => {
      if (tintTimer === null) tintDraft = null;
    });
  }
  function dragTint(value: number) {
    tintDraft = value;
    if (tintTimer !== null) clearTimeout(tintTimer);
    tintTimer = setTimeout(writeTint, 400);
  }
  onDestroy(writeTint);

  let codeFontOptions = $derived([
    { value: "system", label: m.look_code_system() },
    ...codeFonts
      .filter(({ id }) => installed.includes(id) || preferences.value("ui.code-font") === id)
      .map(({ id, family }) => ({ value: id, label: family })),
  ]);
</script>

<SettingsGroup title={m.look_mode()}>
  <ModePicker
    spec={editor.current}
    contrast={preferences.value("ui.contrast") === "true" ? 100 : editor.contrast}
    glass={material !== "none" && material !== ""}
    tint={IS_WINDOWS ? 0 : tint}
  />
</SettingsGroup>

<SettingsGroup title={m.look_theme()} description={m.look_theme_desc()}>
  <ThemeGallery {editor} {mode} />
</SettingsGroup>

<SettingsGroup title={m.look_colors()}>
  <ThemeColors {editor} bind:mode />
</SettingsGroup>

<SettingsGroup title={m.look_window()}>
  <SettingsRow
    settingId="appearance.material"
    title={m.settings_material()}
    description={fallback
      ? m.settings_material_fallback({ material: materialLabels[material]?.() ?? "" })
      : m.settings_material_desc()}
    ><Select
      label={m.settings_material()}
      labelHidden
      value={materialValue}
      disabled={preferences.saving()}
      options={materialOptions}
      onchange={(v) => void preferences.set("ui.material", v)}
    /></SettingsRow
  >
  {#if !IS_WINDOWS && material !== "none" && material !== ""}
    <SettingsRow settingId="appearance.tint" title={m.look_tint()} description={m.look_tint_desc()}>
      <div class="slider">
        <Slider
          label={m.look_tint()}
          slim
          value={tint}
          format={(value) => `${value}%`}
          onchange={dragTint}
          oncommit={(value) => {
            tintDraft = value;
            writeTint();
          }}
        />
      </div>
    </SettingsRow>
  {/if}
  <SettingsRow
    settingId="appearance.sidebar"
    title={m.settings_sidebar()}
    description={m.settings_sidebar_desc()}
  >
    <Select
      label={m.settings_sidebar()}
      labelHidden
      value={preferences.value("sidebar.mode")}
      disabled={preferences.saving()}
      options={[
        { value: "default", label: m.settings_expanded() },
        IS_WINDOWS
          ? { value: "compact", label: m.settings_compact() }
          : { value: "hidden", label: m.settings_hidden() },
      ]}
      onchange={(v) => void preferences.set("sidebar.mode", v)}
    />
  </SettingsRow>
</SettingsGroup>

<SettingsGroup title={m.look_typography()}>
  <FontPicker />
  <SettingsRow
    settingId="appearance.font-size"
    title={m.look_size()}
    description={m.look_size_desc()}
  >
    <SegmentedControl
      label={m.look_size()}
      size="compact"
      value={preferences.value("ui.font-size")}
      disabled={preferences.saving()}
      options={[
        { value: "13", label: "13" },
        { value: "14", label: "14" },
        { value: "15", label: "15" },
      ]}
      onchange={(v) => void preferences.set("ui.font-size", v)}
    />
  </SettingsRow>
  <SettingsRow
    settingId="appearance.code-font"
    title={m.look_code_font()}
    description={m.look_code_font_desc()}
  >
    <Select
      label={m.look_code_font()}
      labelHidden
      value={preferences.value("ui.code-font")}
      disabled={preferences.saving()}
      options={codeFontOptions}
      onchange={(v) => void preferences.set("ui.code-font", v)}
    />
  </SettingsRow>
</SettingsGroup>

<SettingsGroup title={m.settings_zoom()}>
  <PreferenceSelect id="appearance.zoom" preference="zoom.default" />
  <ZoomLevels />
</SettingsGroup>

<SettingsGroup title={m.look_advanced()}>
  <PreferenceSelect id="appearance.density" preference="ui.density" />
  <SettingsRow
    settingId="appearance.motion"
    title={m.settings_reduce_motion()}
    description={m.settings_reduce_motion_desc()}
    ><Switch
      label={m.settings_reduce_motion()}
      labelHidden
      checked={preferences.value("ui.reduce-motion") === "true"}
      disabled={preferences.saving()}
      onchange={(v) => void preferences.set("ui.reduce-motion", String(v))}
    /></SettingsRow
  >
</SettingsGroup>

<style>
  .slider {
    width: 240px;
  }
</style>
