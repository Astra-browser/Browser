<script lang="ts">
  import { onMount } from "svelte";
  import * as m from "$shared/i18n/messages";
  import { commands, type PrivacyStateView } from "$shared/ipc/bindings";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";

  let view = $state<PrivacyStateView | null>(null);
  let busy = $state(false);
  let message = $state("");

  const engineValue = $derived(view?.cookie_behavior ?? "—");

  onMount(() => {
    void refresh();
  });

  async function refresh() {
    try {
      view = await commands.privacyState();
    } catch {
      view = null;
    }
  }

  async function configure(patch: {
    cookies?: string;
    forget_on_close?: boolean;
    ephemeral?: boolean;
    fingerprinting?: string;
    language?: boolean;
    screen?: boolean;
    bounce_protection?: boolean;
  }) {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const result = await commands.privacyConfigure(
        (patch.cookies as string | null | undefined) ?? null,
        (patch.forget_on_close as boolean | null | undefined) ?? null,
        (patch.ephemeral as boolean | null | undefined) ?? null,
        (patch.fingerprinting as string | null | undefined) ?? null,
        (patch.language as boolean | null | undefined) ?? null,
        (patch.screen as boolean | null | undefined) ?? null,
        (patch.bounce_protection as boolean | null | undefined) ?? null,
      );
      if (!result?.accepted) {
        message = m.privacy_change_failed();
      }
      await refresh();
    } catch {
      message = m.privacy_service_silent();
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup title={m.privacy_cookies_group()} description={m.privacy_cookies_group_help()}>
  <SettingsRow
    title={m.privacy_cookies()}
    description={view?.cookies === "allow"
      ? m.privacy_cookies_allow_help({ value: engineValue })
      : view?.cookies === "block-third-party"
        ? m.privacy_cookies_block_help({ value: engineValue })
        : m.privacy_cookies_partition_help({ value: engineValue })}
  >
    <select
      class="select"
      aria-label={m.privacy_cookies()}
      value={view?.cookies ?? "partition"}
      disabled={busy || view === null}
      onchange={(event) => void configure({ cookies: event.currentTarget.value })}
    >
      <option value="allow">{m.privacy_cookies_allow()}</option>
      <option value="block-third-party">{m.privacy_cookies_block()}</option>
      <option value="partition">{m.privacy_cookies_partition()}</option>
    </select>
  </SettingsRow>

  <SettingsRow title={m.privacy_forget()} description={m.privacy_forget_help()}>
    <Switch
      label={m.privacy_forget_label()}
      labelHidden
      checked={view?.forget_on_close === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ forget_on_close: enabled })}
    />
  </SettingsRow>

  <SettingsRow title={m.privacy_ephemeral()} description={m.privacy_ephemeral_help()}>
    <Switch
      label={m.privacy_ephemeral()}
      labelHidden
      checked={view?.ephemeral === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ ephemeral: enabled })}
    />
  </SettingsRow>

  <SettingsRow
    title={m.privacy_bounce()}
    description={m.privacy_bounce_help({ mode: view?.bounce_mode ?? "—" })}
  >
    <Switch
      label={m.privacy_bounce()}
      labelHidden
      checked={view?.bounce_protection !== false}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ bounce_protection: enabled })}
    />
  </SettingsRow>

  {#if (view?.forget_sites?.length ?? 0) > 0 || Object.keys(view?.site_cookies ?? {}).length > 0 || Object.keys(view?.site_fingerprints ?? {}).length > 0}
    <SettingsRow
      title={m.privacy_overrides()}
      description={m.privacy_overrides_summary({
        forgotten: view?.forget_sites?.length ?? 0,
        cookies: Object.keys(view?.site_cookies ?? {}).length,
        fingerprints: Object.keys(view?.site_fingerprints ?? {}).length,
      })}
    >
      <span></span>
    </SettingsRow>
  {/if}
  {#if (view?.forget_sites?.length ?? 0) > 0}
    <SettingsRow title={m.privacy_forget_sites()} description={view?.forget_sites?.join(", ")}>
      <span></span>
    </SettingsRow>
  {/if}
</SettingsGroup>

<SettingsGroup
  title={m.privacy_fingerprint_group()}
  description={m.privacy_fingerprint_group_help()}
>
  <SettingsRow
    title={m.privacy_fingerprint_level()}
    description={view?.fingerprinting === "off"
      ? m.privacy_fingerprint_off_help()
      : view?.fingerprinting === "aggressive"
        ? m.privacy_fingerprint_aggressive_help()
        : m.privacy_fingerprint_standard_help()}
  >
    <select
      class="select"
      aria-label={m.privacy_fingerprint_level_label()}
      value={view?.fingerprinting ?? "standard"}
      disabled={busy || view === null}
      onchange={(event) => void configure({ fingerprinting: event.currentTarget.value })}
    >
      <option value="off">{m.privacy_fingerprint_off()}</option>
      <option value="standard">{m.privacy_fingerprint_standard()}</option>
      <option value="aggressive">{m.privacy_fingerprint_aggressive()}</option>
    </select>
  </SettingsRow>

  <SettingsRow title={m.privacy_language()} description={m.privacy_language_help()}>
    <Switch
      label={m.privacy_language_label()}
      labelHidden
      checked={view?.language === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ language: enabled })}
    />
  </SettingsRow>

  <SettingsRow title={m.privacy_screen()} description={m.privacy_screen_help()}>
    <Switch
      label={m.privacy_screen_label()}
      labelHidden
      checked={view?.screen === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ screen: enabled })}
    />
  </SettingsRow>

  {#if view?.targets && view.targets.length > 0}
    <SettingsRow title={m.privacy_targets()} description={view.targets.join(" · ")}>
      <span></span>
    </SettingsRow>
  {/if}
</SettingsGroup>
{#if message}<p class="feedback" role="status">{message}</p>{/if}

<style>
  .select {
    min-width: 170px;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .feedback {
    margin: 4px 18px;
    color: var(--color-muted);
    font-size: var(--text-body);
  }
</style>
