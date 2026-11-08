<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { IS_WINDOWS } from "$shared/platform";
  import WindowsPrivacy from "../WindowsPrivacy.svelte";
  import { showPreviews } from "../../lib/settings-model";
  import PreviewNotice from "../PreviewNotice.svelte";
  import ProtectionControls from "../ProtectionControls.svelte";
  import PrivacyControls from "../PrivacyControls.svelte";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import PreferenceSelect from "../PreferenceSelect.svelte";
  import PreferenceSwitch from "../PreferenceSwitch.svelte";
  import PreviewSelect from "../PreviewSelect.svelte";
  import ClearBrowsingData from "../ClearBrowsingData.svelte";
  import SiteData from "../SiteData.svelte";
  import SiteExceptions from "../SiteExceptions.svelte";
  import PasskeysGroup from "../PasskeysGroup.svelte";
  import SiteSettings from "../SiteSettings.svelte";
  import SpaceHistoryClear from "../SpaceHistoryClear.svelte";
</script>

<ProtectionControls />
<PrivacyControls />
<SettingsGroup title={m.privacy_protected_group()} description={m.privacy_protected_group_help()}>
  <PreferenceSwitch id="privacy.drm" preference="privacy.drm" />
</SettingsGroup>
{#if IS_WINDOWS}<WindowsPrivacy />{/if}
<PasskeysGroup />
<SettingsGroup title={m.site_settings_title()} description={m.site_settings_help()}>
  <SiteSettings />
</SettingsGroup>
{#if showPreviews}
  <PreviewNotice />
  <SettingsGroup title={m.settings_site_permissions()}
    ><PreferenceSelect id="privacy.camera" preference="privacy.camera" /><PreferenceSelect
      id="privacy.microphone"
      preference="privacy.microphone"
    /><PreferenceSelect id="privacy.location" preference="privacy.location" /><PreferenceSelect
      id="privacy.notifications"
      preference="privacy.notifications"
    /></SettingsGroup
  >
  <SettingsGroup title={m.privacy_media_group()}
    ><PreviewSelect id="privacy.popups" /><PreviewSelect id="privacy.clipboard" /><PreviewSelect
      id="privacy.automatic-downloads"
    /><PreviewSelect id="privacy.sound" /></SettingsGroup
  >
  <SiteExceptions />
{/if}
<SettingsGroup title="History by space">
  <PreferenceSelect id="history.scope" preference="history.scope" />
  <PreferenceSwitch id="history.show-other" preference="history.show-other" />
  <SpaceHistoryClear />
</SettingsGroup>
<SettingsGroup title={m.settings_browsing_data()}>
  {#if showPreviews}<PreferenceSwitch id="privacy.cleanup" preference="privacy.cleanup" />{/if}
  <ClearBrowsingData />
  <SiteData />
</SettingsGroup>
