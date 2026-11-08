<script lang="ts">
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import PreferenceSwitch from "../PreferenceSwitch.svelte";
  import PreferenceSelect from "../PreferenceSelect.svelte";
  import SpaceExtensionList from "../SpaceExtensionList.svelte";
</script>

<SettingsGroup title="Per-space extension sets">
  <PreferenceSwitch id="extensions.per-space" preference="extensions.per-space" />
  <PreferenceSelect id="extensions.new-space" preference="extensions.new-space" />
  <SpaceExtensionList />
</SettingsGroup>
