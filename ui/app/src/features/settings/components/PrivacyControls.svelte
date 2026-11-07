<script lang="ts">
  import { onMount } from "svelte";
  import { commands, type PrivacyStateView } from "$shared/ipc/bindings";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";

  let view = $state<PrivacyStateView | null>(null);
  let busy = $state(false);
  let message = $state("");

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
        message = "Could not apply this privacy change.";
      }
      await refresh();
    } catch {
      message = "The privacy service did not answer.";
    } finally {
      busy = false;
    }
  }
</script>

<SettingsGroup
  title="Cookies and site data"
  description="Cookies, site storage and per-site permissions are enforced by the engine. Partitioned third-party storage keeps sign-ins working without letting a tracker read another site's state."
>
  <SettingsRow
    title="Third-party cookies"
    description={`${
      view?.cookies === "allow"
        ? "All cookies are accepted, including third-party cookies."
        : view?.cookies === "block-third-party"
          ? "Third-party cookies are blocked. Some embedded sign-ins stop working."
          : "Third-party cookies are partitioned per top-level site (Total Cookie Protection)."
    } Engine value: ${view?.cookie_behavior ?? "—"}.`}
  >
    <select
      class="select"
      aria-label="Third-party cookies"
      value={view?.cookies ?? "partition"}
      disabled={busy || view === null}
      onchange={(event) => void configure({ cookies: event.currentTarget.value })}
    >
      <option value="allow">Allow all cookies</option>
      <option value="block-third-party">Block third-party</option>
      <option value="partition">Partition (recommended)</option>
    </select>
  </SettingsRow>

  <SettingsRow
    title="Forget me when I close this site"
    description="Clear cookies, storage, cache, permissions and history for a site when its last tab closes. Turn this on globally, or choose sites from the shield menu."
  >
    <Switch
      label="Forget sites when closed"
      labelHidden
      checked={view?.forget_on_close === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ forget_on_close: enabled })}
    />
  </SettingsRow>

  <SettingsRow
    title="Ephemeral third-party storage"
    description="Partition third-party storage and purge the site's data when the last tab closes, so an embedded tracker cannot persist between visits."
  >
    <Switch
      label="Ephemeral third-party storage"
      labelHidden
      checked={view?.ephemeral === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ ephemeral: enabled })}
    />
  </SettingsRow>

  <SettingsRow
    title="Bounce tracking protection"
    description={`The engine classifies navigations that bounce through a tracker and purges the state they set (mode ${view?.bounce_mode ?? "—"}). Astra also unwraps known redirector links before the request.`}
  >
    <Switch
      label="Bounce tracking protection"
      labelHidden
      checked={view?.bounce_protection !== false}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ bounce_protection: enabled })}
    />
  </SettingsRow>

  {#if (view?.forget_sites?.length ?? 0) > 0 || Object.keys(view?.site_cookies ?? {}).length > 0 || Object.keys(view?.site_fingerprints ?? {}).length > 0}
    <SettingsRow
      title="Per-site overrides"
      description={`${view?.forget_sites?.length ?? 0} forgotten on close · ${Object.keys(view?.site_cookies ?? {}).length} cookie rules · ${Object.keys(view?.site_fingerprints ?? {}).length} fingerprint rules`}
    >
      <span></span>
    </SettingsRow>
  {/if}
  {#if (view?.forget_sites?.length ?? 0) > 0}
    <SettingsRow title="Sites forgotten on close" description={view?.forget_sites?.join(", ")}>
      <span></span>
    </SettingsRow>
  {/if}
</SettingsGroup>

<SettingsGroup
  title="Fingerprinting protection"
  description="Astra uses Firefox's native fingerprinting protection with a stronger target set than the low-breakage default. Standard randomizes canvas and audio, hides the GPU model, tiers hardware concurrency and limits font and display metrics without breaking the user agent or timezone."
>
  <SettingsRow
    title="Protection level"
    description={view?.fingerprinting === "off"
      ? "Fingerprinting protection is off."
      : view?.fingerprinting === "aggressive"
        ? "Aggressive adds screen, window and locale targets to standard protection."
        : "Standard protects canvas, audio, WebGL, fonts, display metrics and timer precision."}
  >
    <select
      class="select"
      aria-label="Fingerprinting protection level"
      value={view?.fingerprinting ?? "standard"}
      disabled={busy || view === null}
      onchange={(event) => void configure({ fingerprinting: event.currentTarget.value })}
    >
      <option value="off">Off</option>
      <option value="standard">Standard</option>
      <option value="aggressive">Aggressive</option>
    </select>
  </SettingsRow>

  <SettingsRow
    title="Language fingerprinting"
    description="Report en-US in navigator.language, navigator.languages and the Accept-Language header."
  >
    <Switch
      label="Spoof language"
      labelHidden
      checked={view?.language === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ language: enabled })}
    />
  </SettingsRow>

  <SettingsRow
    title="Screen fingerprinting"
    description="Report a rounded screen rectangle and pixel depth instead of the exact display metrics."
  >
    <Switch
      label="Spoof screen metrics"
      labelHidden
      checked={view?.screen === true}
      disabled={busy || view === null}
      onchange={(enabled) => void configure({ screen: enabled })}
    />
  </SettingsRow>

  {#if view?.targets && view.targets.length > 0}
    <SettingsRow title="Active fingerprint targets" description={view.targets.join(" · ")}>
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
