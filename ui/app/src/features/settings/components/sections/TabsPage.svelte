<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import PreferenceSelect from "../PreferenceSelect.svelte";
  import PreferenceSwitch from "../PreferenceSwitch.svelte";
  import SplitArrangements from "../SplitArrangements.svelte";
</script>

<SettingsGroup title={m.tabs_group_opening()}
  ><PreferenceSelect id="tabs.new-position" preference="tabs.new-position" /><PreferenceSelect
    id="tabs.external"
    preference="tabs.external-position"
  /><PreferenceSwitch id="tabs.duplicates" preference="tabs.switch-to-open" /><PreferenceSwitch
    id="tabs.automatic-pip"
    preference="tabs.automatic-pip"
  /></SettingsGroup
>
<SettingsGroup title={m.tabs_group_closing()}
  ><PreferenceSelect id="tabs.close" preference="tabs.after-close" /><PreferenceSelect
    id="tabs.close-button"
    preference="tabs.close-button"
  /></SettingsGroup
>
<SettingsGroup title={m.tabs_group_archive()}
  ><PreferenceSelect id="tabs.archive" preference="tabs.archive" /></SettingsGroup
>

<SettingsGroup title="Split view">
  <PreferenceSwitch id="split.enabled" preference="split.enabled" />
  <PreferenceSelect id="split.max-panes" preference="split.max-panes" />
  <PreferenceSwitch id="split.restore" preference="split.restore" />
  <PreferenceSwitch id="split.remember-width" preference="split.remember-width" />
  <PreferenceSelect id="split.link-target" preference="split.link-target" />
  <PreferenceSwitch id="split.drag-edge" preference="split.drag-edge" />
  <PreferenceSwitch id="split.drag-tab" preference="split.drag-tab" />
  <PreferenceSwitch id="split.double-click-reset" preference="split.double-click-reset" />
  <PreferenceSwitch id="split.groups" preference="split.groups" />
  <PreferenceSwitch id="split.group-collapse" preference="split.group-collapse" />
  <SplitArrangements />
</SettingsGroup>

<SettingsGroup title="Page previews">
  <PreferenceSwitch id="peek.enabled" preference="peek.enabled" />
  <PreferenceSelect id="peek.trigger" preference="peek.trigger" />
  <PreferenceSelect id="peek.delay" preference="peek.delay" />
  <PreferenceSelect id="peek.size" preference="peek.size" />
  <PreferenceSelect id="peek.position" preference="peek.position" />
  <PreferenceSelect id="peek.scale" preference="peek.scale" />
  <PreferenceSwitch id="peek.restore" preference="peek.restore" />
  <PreferenceSwitch id="peek.close-leave" preference="peek.close-leave" />
  <PreferenceSwitch id="peek.show-url" preference="peek.show-url" />
  <PreferenceSwitch id="peek.show-title" preference="peek.show-title" />
  <PreferenceSwitch id="peek.pinned" preference="peek.pinned" />
  <PreferenceSwitch id="peek.bookmarks" preference="peek.bookmarks" />
</SettingsGroup>

<SettingsGroup title="Cross-space tabs">
  <PreferenceSwitch id="tabs.clone-history" preference="tabs.clone-history" />
  <PreferenceSwitch id="tabs.clone-background" preference="tabs.clone-background" />
</SettingsGroup>
