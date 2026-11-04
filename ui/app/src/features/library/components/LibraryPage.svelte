<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { surface as browser } from "$domain/surface";
  import { tabs } from "$domain/tabs";
  import { loadDownloadsList } from "$features/downloads";
  import LazyView from "$shared/ui/LazyView";
  import IconButton from "$shared/ui/IconButton";
  import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
  let { kind }: { kind: "downloads" } = $props();
</script>

<section class="library-shell" data-library={kind}>
  <header class="internal-toolbar">
    <IconButton
      icon={ArrowLeft02Icon}
      label={m.settings_back()}
      onclick={() => void browser.close()}
    /><span>{m.browser_downloads_title()}</span>
  </header>
  <div class="library-content">
    <header class="settings-page-heading">
      <h1>{m.browser_downloads_title()}</h1>
      <p>{m.browser_downloads_description()}</p>
    </header>
    {#if tabs.profile()?.id}{#key tabs.profile()?.id}<LazyView
          loader={loadDownloadsList}
          loadingLabel={m.download_loading()}
          failureLabel={m.surface_render_failed()}
          retryLabel={m.surface_retry()}
          >{#snippet children(DownloadsList)}<DownloadsList
              profile={tabs.profile()!.id}
            />{/snippet}</LazyView
        >{/key}{/if}
  </div>
</section>

<style>
  /* The paper's gutters: 48px beside a wide column, 24px in a narrow one. */
  .library-content {
    padding: 40px clamp(24px, 5vw, 48px);
  }

  .library-content .settings-page-heading h1 {
    font-size: var(--text-headline);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  @media (width <= 820px) {
    .library-content {
      padding: 28px 24px 40px;
    }
  }

  @media (width <= 760px) {
    .library-content {
      padding: 24px 20px 40px;
    }
  }
</style>
