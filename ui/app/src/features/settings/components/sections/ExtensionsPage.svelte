<script lang="ts">
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import PreferenceSwitch from "../PreferenceSwitch.svelte";
  import PreferenceSelect from "../PreferenceSelect.svelte";
  import SpaceExtensionList from "../SpaceExtensionList.svelte";
</script>

<SettingsGroup
  title="Per-space extension sets"
  description="Extensions stay installed once per profile. Turning one off only changes the space in front; switching spaces applies that space's own set."
>
  <PreferenceSwitch id="extensions.per-space" preference="extensions.per-space" />
  <PreferenceSelect id="extensions.new-space" preference="extensions.new-space" />
  <SpaceExtensionList />
</SettingsGroup>
