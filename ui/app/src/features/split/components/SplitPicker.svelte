<script lang="ts">
  import { Add01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
  import type { TabView } from "$shared/ipc/bindings";
  import { tabs } from "$domain/tabs";
  import { favicons } from "$domain/favicons";
  import * as m from "$shared/i18n/messages";
  import Button from "$shared/ui/Button";
  import FavIcon from "$shared/ui/FavIcon";
  import Icon from "$shared/ui/Icon";
  import * as notices from "$session/notice.svelte";
  import * as picker from "$session/split-picker.svelte";

  let dialog = $state<HTMLDialogElement>();
  let busy = $state(false);
  const uid = $props.id();

  let source = $derived(picker.sourceTab());
  let candidates = $derived(picker.candidates());
  let room = $derived(picker.hasRoom());

  $effect(() => {
    if (!dialog) return;
    if (picker.isOpen() && !dialog.open) dialog.showModal();
    else if (!picker.isOpen() && dialog.open) dialog.close();
  });

  function name(tab: TabView): string {
    return tab.title || tab.url || m.untitled_tab();
  }

  function host(tab: TabView): string {
    try {
      return tab.url ? new URL(tab.url).host : "";
    } catch {
      return "";
    }
  }

  function failure(error: unknown): string {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "pane_limit") return m.split_full({ count: picker.maxPanes() });
    if (code === "space_mismatch") return m.split_space_mismatch();
    if (code === "already_in_split") return m.split_already_other();
    if (code === "disabled") return m.split_disabled();
    return m.split_failed();
  }

  async function choose(target: string | null) {
    const origin = picker.sourceId();
    if (origin === null || busy) return;
    busy = true;
    picker.close();
    try {
      if (target === null) await tabs.splitNewPane(origin);
      else await tabs.splitWith(origin, target);
    } catch (error) {
      notices.show(failure(error));
    } finally {
      busy = false;
    }
  }

  function dismiss() {
    if (busy) return;
    picker.close();
  }
</script>

<dialog
  bind:this={dialog}
  class="split-picker"
  aria-labelledby={`${uid}-title`}
  aria-describedby={`${uid}-body`}
  onclose={() => {
    if (!busy) picker.close();
  }}
  onclick={(event) => {
    if (event.target === dialog) dismiss();
  }}
>
  {#if source}
    <header class="picker-head">
      <span class="picker-mark" aria-hidden="true"><span></span><span></span><span></span></span>
      <div class="picker-words">
        <h2 id={`${uid}-title`}>{room ? m.split_picker_title() : m.split_full_title()}</h2>
        <p id={`${uid}-body`}>
          {room
            ? m.split_picker_body({ title: name(source) })
            : m.split_full_body({ count: picker.maxPanes() })}
        </p>
      </div>
    </header>

    {#if room}
      <button type="button" class="picker-row picker-new" onclick={() => void choose(null)}>
        <span class="row-mark"><Icon icon={Add01Icon} size={16} /></span>
        <span class="row-words">
          <span class="row-title">{m.split_picker_new_tab()}</span>
          <span class="row-detail">{m.split_picker_new_tab_detail()}</span>
        </span>
        <Icon icon={ArrowUpRight01Icon} size={14} />
      </button>

      {#if candidates.length > 0}
        <p class="picker-label">{m.split_picker_existing()}</p>
        <ul class="picker-list" role="list">
          {#each candidates as tab (tab.id)}
            <li>
              <button type="button" class="picker-row" onclick={() => void choose(tab.id)}>
                <FavIcon
                  image={favicons.image(tab.icon)}
                  tone={favicons.tone(tab.icon)}
                  size={16}
                  notched={!!tab.audio}
                  sleeping={tab.availability?.state === "sleeping"}
                />
                <span class="row-words">
                  <span class="row-title">{name(tab)}</span>
                  {#if host(tab)}<span class="row-detail">{host(tab)}</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <div class="picker-full" role="note">
        <p>{m.split_full_hint()}</p>
        <Button
          size="compact"
          variant="ghost"
          onclick={() => {
            const id = picker.sourceId();
            picker.close();
            if (id) void tabs.endSplit(id).catch(() => notices.show(m.split_failed()));
          }}
        >
          {m.split_end_view()}
        </Button>
      </div>
    {/if}

    <footer>
      <Button size="compact" variant="ghost" pending={busy} onclick={dismiss}
        >{m.action_cancel()}</Button
      >
    </footer>
  {/if}
</dialog>

<style>
  .split-picker {
    box-sizing: border-box;
    inline-size: min(440px, calc(100vw - 32px));
    max-block-size: min(560px, calc(100vh - 32px));
    margin: auto;
    padding: 20px;
    overflow: hidden;
    border: 0;
    border-radius: var(--overlay-radius);
    background: var(--overlay-ground);
    color: var(--color-text);
    box-shadow: var(--overlay-shadow);
  }

  .split-picker::backdrop {
    background: var(--overlay-scrim);
    backdrop-filter: blur(2px);
  }

  .split-picker[open] {
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: interface-fade var(--motion-base) var(--ease-out);
  }

  .picker-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .picker-mark {
    display: flex;
    flex: none;
    gap: 2px;
    padding-block-start: 5px;
  }

  .picker-mark > span {
    display: block;
    inline-size: 3px;
    block-size: 14px;
    border-radius: 1px;
    background: var(--color-accent);
    opacity: 0.75;
  }

  .picker-words {
    min-inline-size: 0;
  }

  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 550;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  p {
    margin: 4px 0 0;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.5;
  }

  .picker-label {
    margin-block-start: 2px;
    color: var(--color-faint);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .picker-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  .picker-row {
    display: flex;
    gap: 10px;
    align-items: center;
    inline-size: 100%;
    min-block-size: 42px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-row);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: default;
  }

  .picker-row:hover,
  .picker-row:focus-visible {
    background: var(--row-hover);
  }

  .picker-new {
    background: var(--color-fill);
    box-shadow: inset 0 0 0 1px var(--color-border);
  }

  .row-mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    border-radius: var(--radius-inset);
    background: var(--row-active);
    color: var(--color-label-secondary);
  }

  .row-words {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
  }

  .row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-label);
    font-weight: 500;
  }

  .row-detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-faint);
    font-size: 11px;
  }

  .picker-full {
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-start;
    padding: 10px;
    border-radius: var(--radius-row);
    background: var(--color-fill);
  }

  footer {
    display: flex;
    justify-content: flex-end;
  }

  @media (prefers-reduced-motion: reduce) {
    .split-picker[open] {
      animation: none;
    }
  }
</style>
