<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { ShieldBanIcon, ShieldCheckIcon } from "@hugeicons/core-free-icons";
  import Icon from "$shared/ui/Icon";
  import { blocker, blockerSites, shieldPresentation } from "$domain/blocker";
  import { pageSite } from "$domain/site-data";
  import { tabs } from "$domain/tabs";

  // The whole-blocker switch for the page in front. It is the same policy the
  // address-panel shield uses: enable blocking globally when it is off,
  // otherwise pause/resume this site and reload the page.
  const blocking = $derived(blocker.status());
  const shield = $derived(shieldPresentation(blocking));
  const shieldSite = $derived(
    pageSite(tabs.activeTab()?.url)?.host ?? blocking.site?.context.site ?? null,
  );
  const shieldOn = $derived(blocking.applied_enabled === true && blocking.site?.paused !== true);
  const showShield = $derived(
    // The native site switch is process-wide; a private window must not offer
    // a pause that would leak into normal windows.
    tabs.profile?.()?.kind !== "incognito" &&
      shieldSite !== null &&
      blocking.site !== null &&
      blocking.protection !== "unavailable" &&
      shield.visible,
  );

  // The address panel refreshes blocking when it opens; the sidebar is always
  // present, so it reads the status itself. A fresh page and every commit get a
  // read (the site context revision moves), and a first boot — lists still
  // installing — retries briefly instead of staying silent.
  let retries = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void tabs.activeId();
    void tabs.activeTab()?.projection_revision;
    retries = 0;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void blocker.refresh(), 120);
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  });
  $effect(() => {
    if (blocking.protection !== "unavailable" || retries >= 10) return;
    retries += 1;
    const timer = setTimeout(() => void blocker.refresh(), 1000);
    return () => clearTimeout(timer);
  });

  let busy = $state(false);
  async function toggle() {
    if (busy) return;
    busy = true;
    try {
      if (blocking.applied_enabled !== true) {
        await blocker.setEnabled(true);
      } else if (blocking.site?.ready && blocking.site.busy !== true) {
        await blockerSites.setProtected(blocking.site.paused === true);
      }
    } finally {
      busy = false;
    }
  }
</script>

{#if showShield}
  <button
    type="button"
    class="site-shield"
    data-astra-shield
    data-shield-state={shieldOn ? "on" : "off"}
    data-shield-site={shieldSite ?? ""}
    title={shieldOn
      ? m.sidebar_shield_disable({ site: shieldSite ?? "" })
      : m.sidebar_shield_enable({ site: shieldSite ?? "" })}
    aria-label={shieldOn
      ? m.sidebar_shield_disable({ site: shieldSite ?? "" })
      : m.sidebar_shield_enable({ site: shieldSite ?? "" })}
    aria-pressed={shieldOn}
    disabled={busy || blocking.site?.busy === true}
    onclick={() => void toggle()}
  >
    <Icon icon={shieldOn ? ShieldCheckIcon : ShieldBanIcon} size={17} />
  </button>
{/if}

<style>
  .site-shield {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: var(--color-muted);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out),
      scale var(--motion-fast) var(--ease-out);
  }

  .site-shield[data-shield-state="off"] {
    color: var(--color-warning);
  }

  .site-shield:disabled {
    opacity: 0.5;
  }

  .site-shield:focus-visible {
    background: var(--row-hover);
    color: var(--color-text);
    box-shadow: var(--shadow-field-focus);
  }

  .site-shield:hover:not(:disabled) {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .site-shield:active:not(:disabled) {
    scale: 0.9;
    transition-duration: var(--motion-instant);
  }

  @media (prefers-reduced-motion: reduce) {
    .site-shield {
      transition: none;
    }
  }
</style>
