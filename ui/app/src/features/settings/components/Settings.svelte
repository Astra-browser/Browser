<script lang="ts">
  import LazyView from "$shared/ui/LazyView";
  import { tick, onMount } from "svelte";
  import * as m from "$shared/i18n/messages";
  import { preferences } from "$domain/preferences";
  import {
    sections,
    searchSettings,
    shownSections,
    type SettingsSection,
  } from "../lib/settings-model";
  import * as state from "../lib/settings-state.svelte";
  import NewTabPage from "./sections/NewTabPage.svelte";
  import Icon from "$shared/ui/Icon";
  import IconButton from "$shared/ui/IconButton";
  import Select from "$shared/ui/Select";
  import { ArrowRight01Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
  import EmptyState from "$shared/ui/EmptyState";
  import Button from "$shared/ui/Button";
  import { surface as browser } from "$domain/surface";
  const loaders = {
    appearance: () => import("./sections/AppearancePage.svelte"),
    general: () => import("./sections/GeneralPage.svelte"),
    tabs: () => import("./sections/TabsPage.svelte"),
    profiles: () => import("./sections/ProfilesPage.svelte"),
    spaces: () => import("./sections/SpacesPage.svelte"),
    gallery: () => import("./sections/GalleryPage.svelte"),
    search: () => import("./sections/SearchPage.svelte"),
    privacy: () => import("./sections/PrivacyPage.svelte"),
    extensions: () => import("./sections/ExtensionsPage.svelte"),
    shortcuts: () => import("./sections/KeyboardPage.svelte"),
    features: () => import("./sections/FeaturesPage.svelte"),
    focus: () => import("./sections/FocusPage.svelte"),
    work: () => import("./sections/WorkPage.svelte"),
    ai: () => import("./sections/AiPage.svelte"),
    skills: () => import("./sections/SkillsPage.svelte"),
    memory: () => import("./sections/MemoryPage.svelte"),
    sites: () => import("./sections/SitesPage.svelte"),
    mcp: () => import("./sections/ConnectionsPage.svelte"),
    performance: () => import("./sections/PerformancePage.svelte"),
    account: () => import("./sections/AccountPage.svelte"),
    about: () => import("./sections/AboutPage.svelte"),
  };
  // A section this build does not offer opens another in its group; when the
  // whole group is gone it opens the first page instead.
  let offered = $derived(shownSections());
  let current = $derived.by(() => {
    const wanted = sections.find((section) => section.id === state.section());
    return (
      offered.find((section) => section === wanted) ??
      offered.find((section) => section.group === wanted?.group) ??
      offered[0]!
    );
  });
  let loader = $derived(current.id in loaders ? loaders[current.id as keyof typeof loaders] : null);
  let results = $derived(searchSettings(state.query()));
  // Below 760px the sections rail folds and these three stand in for it:
  // a section picker, the same search, and the way back out.
  let sectionOptions = $derived(
    offered.map((section) => ({ value: section.id, label: section.title() })),
  );
  let content: HTMLElement;
  let focusedRevision = -1;
  async function focusTarget() {
    const revision = state.selectionRevision();
    if (focusedRevision === revision) return;
    await tick();
    const target = state.highlighted();
    const row = target
      ? [...content.querySelectorAll<HTMLElement>("[data-setting]")].find(
          (element) => element.dataset.setting === target,
        )
      : null;
    if (target && !row) return;
    if (revision !== state.selectionRevision()) return;
    focusedRevision = revision;
    if (row) {
      content
        .querySelectorAll<HTMLElement>("[data-highlighted]")
        .forEach((element) => delete element.dataset.highlighted);
      row.dataset.highlighted = "true";
      row.tabIndex = -1;
      row.scrollIntoView({ block: "center" });
      row.focus();
    } else {
      content.scrollTop = 0;
      content.querySelector<HTMLElement>("h1")?.focus();
    }
  }
  $effect(() => {
    state.selectionRevision();
    state.section();
    state.highlighted();
    void focusTarget();
  });
  onMount(() => {
    const observer = new MutationObserver(() => {
      if (state.highlighted()) void focusTarget();
    });
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  });
</script>

<section class="settings-shell" aria-label={m.settings_title()}>
  <div class="settings-content scrolls" bind:this={content}>
    <div class="settings-page">
      <div class="settings-compact-nav">
        <Select
          label={m.settings_title()}
          labelHidden
          options={sectionOptions}
          value={current.id}
          onchange={(value) => state.select(value as SettingsSection)}
        />
        <label class="settings-compact-search">
          <Icon icon={Search01Icon} size={14} />
          <input
            type="search"
            aria-label={m.settings_search()}
            placeholder={m.settings_search()}
            value={state.query()}
            oninput={(event) => state.setQuery(event.currentTarget.value)}
          />
        </label>
        <IconButton
          icon={Cancel01Icon}
          label={m.settings_back()}
          onclick={() => void browser.close()}
        />
      </div>
      {#key state.query() ? "search" : current.id}<div class="settings-view">
          <header class="settings-page-heading">
            <h1 tabindex="-1">
              {state.query() ? m.settings_search_results() : current.title()}
            </h1>
            {#if !state.query() && current.description()}<p>{current.description()}</p>{/if}
          </header>
          {#if preferences.saveFailed()}<div class="settings-feedback" role="alert">
              {m.settings_save_error()}
            </div>{/if}
          {#if state.query()}
            {#if results.length === 0}<EmptyState
                title={m.settings_no_results()}
                description={m.settings_no_results_desc()}
                >{#snippet icon()}<Icon
                    icon={Search01Icon}
                    size={24}
                  />{/snippet}{#snippet action()}<Button onclick={() => state.setQuery("")}
                    >{m.settings_clear_search()}</Button
                  >{/snippet}</EmptyState
              >
            {:else}<div class="settings-results">
                {#each results as result (result.id)}<button
                    type="button"
                    onclick={() => state.select(result.section as SettingsSection, result.target)}
                    ><span
                      ><span class="settings-result-section"
                        >{offered.find((section) => section.id === result.section)?.title()}</span
                      ><strong>{result.label()}</strong><small>{result.description()}</small></span
                    ><Icon icon={ArrowRight01Icon} size={16} /></button
                  >{/each}
              </div>{/if}
          {:else if current.id === "newtab"}<NewTabPage />
          {:else if loader}<LazyView
              {loader}
              loadingLabel={m.surface_loading()}
              failureLabel={m.surface_render_failed()}
              retryLabel={m.surface_retry()}>{#snippet children(View)}<View />{/snippet}</LazyView
            >{/if}
        </div>{/key}
      <span class="sr-only" role="status">{preferences.saving() ? m.settings_saving() : ""}</span>
    </div>
  </div>
</section>

<style>
  /* The paper's gutters: 48px beside a wide column, 24px in a narrow one. The
     page never runs its groups into the edge of the card. */
  .settings-page {
    padding: 48px clamp(24px, 5cqi, 48px) 64px;
  }

  .settings-page-heading h1 {
    font-size: var(--text-headline);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  /* The rail's stand-in for a window too narrow to hold one. It is absent at
     every width that shows the sections panel, so the page keeps its single
     heading and nothing is offered twice. */
  .settings-compact-nav {
    display: none;
  }

  @media (width <= 760px) {
    .settings-compact-nav {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-block-end: 22px;
    }

    .settings-compact-nav > :global(.field) {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 240px;
    }

    .settings-compact-nav > :global(.field .ui-select) {
      width: 100%;
      min-width: 0;
    }

    .settings-compact-search {
      display: flex;
      flex: 1 1 140px;
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: var(--search-height);
      padding-inline: var(--control-inset);
      border-radius: var(--radius-field);
      background: var(--color-field);
      color: var(--color-faint);
    }

    .settings-compact-search:focus-within {
      background: var(--color-field-hover);
      box-shadow: var(--shadow-field-focus);
      color: var(--color-muted);
    }

    .settings-compact-search input {
      min-width: 0;
      width: 100%;
      border: 0;
      background: transparent;
      outline: none;
      color: var(--color-text);
      font-size: var(--text-body);
    }
  }

  @media (width <= 520px) {
    .settings-compact-nav {
      flex-wrap: wrap;
    }

    .settings-compact-nav > :global(.field) {
      flex: 1 1 auto;
      max-width: none;
    }

    .settings-compact-search {
      order: 2;
      flex-basis: 100%;
    }
  }

  /* Narrow: the page keeps 24px, then 20px, of paper beside its column. */
  @media (width <= 820px) {
    .settings-page {
      padding: 28px 24px 48px;
    }
  }

  @media (width <= 760px) {
    .settings-page {
      padding: 24px 20px 44px;
    }
  }
</style>
