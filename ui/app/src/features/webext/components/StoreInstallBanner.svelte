<script lang="ts">
  import { CheckmarkCircle02Icon, Download01Icon } from "@hugeicons/core-free-icons";
  import { extensions } from "$domain/extensions";
  import { tabs } from "$domain/tabs";
  import { surface } from "$domain/surface";
  import { webext } from "$domain/webext";
  import Button from "$shared/ui/Button";
  import Icon from "$shared/ui/Icon";
  import * as m from "$shared/i18n/messages";

  // Always visible at the top of the sidebar while a Chrome Web Store
  // listing is in front. The store itself tells a Gecko browser to switch to
  // Chrome; Astra's own button is the install path, and it must not wait for
  // the page bar to be hovered into view.
  let listedId = $derived(
    webext.isAvailable() && surface.currentPage() === null
      ? extensions.chromeStoreListingId(tabs.activeTab()?.url ?? "")
      : null,
  );
  let installed = $derived(listedId === null ? null : webext.named(listedId));
  let busy = $derived(webext.isInstalling());
  let failure = $derived(webext.review() === null ? webext.error() : null);
</script>

{#if listedId !== null}
  <div class="store-callout" data-store-callout>
    <span class="head">
      <span class="mark" aria-hidden="true">
        {#if installed}
          <Icon icon={CheckmarkCircle02Icon} size={18} />
        {:else}
          <Icon icon={Download01Icon} size={18} />
        {/if}
      </span>
      <strong>{installed?.name ?? m.webext_store_callout_title()}</strong>
    </span>
    <p class="body">
      {installed !== null
        ? m.webext_store_callout_installed()
        : (failure ?? m.webext_store_callout_body())}
    </p>
    {#if installed === null}
      <div class="action">
        <Button
          variant="primary"
          size="compact"
          pending={busy}
          disabled={busy}
          onclick={() => {
            const id = tabs.activeTab()?.id;
            if (id !== undefined) void webext.prepare(id);
          }}>{m.webext_store_install()}</Button
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .store-callout {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 var(--sidebar-inset) 8px;
    padding: 10px 12px;
    border-radius: var(--radius-card);
    background: var(--color-lit);
    color: var(--color-on-lit);
    box-shadow: var(--shadow-card);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mark {
    display: grid;
    flex: none;
    place-items: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-control);
    background: var(--color-card);
    color: var(--color-text);
  }

  .head strong {
    min-width: 0;
    font-size: var(--text-label);
    font-weight: 600;
    line-height: 1.3;
    white-space: normal;
  }

  .body {
    margin: 0;
    font-size: var(--text-caption);
    line-height: 1.4;
    color: var(--color-muted);
  }

  .action {
    display: flex;
    inline-size: 100%;
  }

  .action :global(button) {
    inline-size: 100%;
  }
</style>
