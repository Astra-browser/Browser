<script lang="ts">
  import { onMount, untrack } from "svelte";
  import * as m from "$shared/i18n/messages";
  import { commands, type SearchContext, type SearchResult } from "$shared/ipc/bindings";
  import { events } from "$shared/ipc/native-events";
  import Icon from "$shared/ui/Icon";
  import { Search01Icon } from "@hugeicons/core-free-icons";

  /**
   * The launcher, drawn over the browser chrome.
   *
   * The product's launcher began as a separate window. Until that window is
   * part of the browser, this overlay is the surface the shortcut opens: the
   * same host calls (`launcher_search` / `launcher_run`) the window used, with
   * the field, the list and Return doing what they do there.
   */
  let { onclose, initial = "" }: { onclose: () => void; initial?: string } = $props();

  const EMPTY_CONTEXT: SearchContext = {
    window_id: "",
    session_id: "",
    request_id: "",
    profile_id: "",
    space_id: "",
  };

  let input = $state<HTMLInputElement>();
  // A hand-off from Ctrl+L starts on the page's own address, selected, so the
  // next keystroke replaces it — the same contract as every other browser.
  // Read once: the seed belongs to this opening, not to later prop changes.
  let query = $state(untrack(() => initial));
  let rows = $state.raw<SearchResult[]>([]);
  let selected = $state(0);
  // Whether the person moved the cursor themselves. Until they do, Return
  // means "the words I typed" — the host decides address vs search, exactly as
  // the address field does. Without this, a typed address ran the first
  // suggestion row (always a web search) and could never navigate.
  let touched = $state(false);
  let pending = $state(false);
  let failed = $state(false);
  let sequence = 0;

  $effect(() => {
    const text = query;
    const request = `overlay-${++sequence}`;
    selected = 0;
    touched = false;
    if (text.trim() === "") {
      rows = [];
      pending = false;
      failed = false;
      return;
    }
    pending = true;
    failed = false;
    void commands.launcherSearch(text, request).catch(() => {
      pending = false;
      failed = true;
    });
  });

  onMount(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    // The host answers on the search channel with a null context: that is the
    // launcher's own answer rather than the New Tab field's.
    void events.searchChanged
      .listen(({ payload }) => {
        if (disposed || payload.context !== null) return;
        if (payload.query !== query) return;
        rows = payload.results;
        pending = payload.pending;
        failed = false;
        if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      });
    input?.focus();
    if (initial !== "") input?.select();
    return () => {
      disposed = true;
      stop?.();
    };
  });

  async function run(): Promise<void> {
    const row = touched ? rows[selected] : undefined;
    try {
      if (row) {
        const result = await commands.launcherRun(row.action, EMPTY_CONTEXT, false);
        if (!result?.accepted) {
          failed = true;
          return;
        }
      } else if (query.trim() !== "") {
        const result = await commands.browserOpenUrl(query.trim(), false);
        if (!result?.accepted) {
          failed = true;
          return;
        }
      } else {
        return;
      }
    } catch {
      failed = true;
      return;
    }
    onclose();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query !== "") {
        query = "";
        input?.focus();
      } else onclose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      touched = true;
      selected = Math.min(rows.length - 1, selected + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      touched = true;
      selected = Math.max(0, selected - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void run();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="launcher-overlay" data-launcher-overlay>
  <button class="backdrop" type="button" aria-label={m.settings_back()} onclick={onclose}></button>
  <div class="launcher" role="dialog" aria-modal="true" aria-label={m.launcher_search()}>
    <div class="field">
      <Icon icon={Search01Icon} size={16} />
      <input
        bind:this={input}
        bind:value={query}
        type="text"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        placeholder={m.panel_search_placeholder()}
        aria-label={m.panel_search_placeholder()}
      />
    </div>
    {#if failed}
      <p class="note" role="alert">{m.launcher_search_failed()}</p>
    {:else if query.trim() !== ""}
      <ul class="rows" role="listbox" aria-label={m.panel_search_mode()}>
        {#each rows as row, index (row.title + row.detail + index)}
          <li role="option" aria-selected={index === selected} class:selected={index === selected}>
            <button
              type="button"
              onclick={() => ((touched = true), (selected = index), void run())}
            >
              <span class="title">{row.title}</span>
              {#if row.detail}<span class="detail">{row.detail}</span>{/if}
            </button>
          </li>
        {/each}
        {#if !pending && rows.length === 0}
          <li class="note" role="status">{m.panel_no_results()}</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>

<style>
  .launcher-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: start center;
    padding-block-start: 12vh;
  }

  .backdrop {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--overlay-scrim);
    cursor: default;
  }

  .launcher {
    position: relative;
    inline-size: min(640px, calc(100vw - 48px));
    max-block-size: min(520px, 64vh);
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--overlay-radius);
    background: var(--color-surface);
    box-shadow: var(--shadow-popover);
  }

  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-block-end: 1px solid var(--color-border);
    color: var(--color-muted);
  }

  .field input {
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: 16px;
  }

  .rows {
    margin: 0;
    padding: 6px;
    list-style: none;
  }

  .rows li {
    border-radius: var(--radius-control-compact);
  }

  .rows li.selected {
    /* `--color-hover` never existed, so the whole declaration was invalid and
       the arrow-key cursor was invisible. */
    background: var(--color-fill-active);
  }

  .rows button {
    display: flex;
    align-items: baseline;
    gap: 10px;
    inline-size: 100%;
    padding: 10px 12px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    color: var(--color-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin: 0;
    padding: 14px 16px;
    color: var(--color-muted);
    font-size: 13px;
  }
</style>
