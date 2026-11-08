<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { flags } from "$shared/flags";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import FeatureSwitch from "../FeatureSwitch.svelte";
</script>

<SettingsGroup title={flags.work ? m.features_ai_group() : m.feature_ai_title()}>
  <FeatureSwitch feature="ai" />
  {#if flags.work}<FeatureSwitch feature="work" />{/if}
</SettingsGroup>

<SettingsGroup title={m.features_tools_group()}>
  <FeatureSwitch feature="notes" />
  <FeatureSwitch feature="tasks" />
  <FeatureSwitch feature="time" />
</SettingsGroup>
