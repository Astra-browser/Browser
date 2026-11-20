<script lang="ts">
  import { tick, onMount, untrack } from "svelte";
  import {
    ArrowLeft02Icon,
    ArrowRight02Icon,
    Cancel01Icon,
    FolderOpenIcon,
    Image02Icon,
    MoreHorizontalIcon,
  } from "@hugeicons/core-free-icons";
  import type { GalleryItem } from "$shared/ipc/bindings";
  import * as m from "$shared/i18n/messages";
  import { getLocale } from "$shared/i18n/runtime";
  import Icon from "$shared/ui/Icon";
  import IconButton from "$shared/ui/IconButton";
  import Menu from "$shared/ui/Menu";
  import type { MenuEntry } from "$shared/ui/Menu";
  import type { GallerySession } from "../lib/gallery-session.svelte";
  import { openLabel, relativeDay } from "../lib/gallery-model";

  let {
    items,
    index: start,
    session,
    origin = null,
    thumb = null,
    onclose,
    onmanage,
  }: {
    items: GalleryItem[];
    index: number;
    session: GallerySession;
    origin?: HTMLElement | null;
    thumb?: string | null;
    onclose: () => void;
    onmanage: () => void;
  } = $props();

  // The dialog opens on the tile that was clicked; later pages do not reset it.
  // svelte-ignore state_referenced_locally
  let index = $state(start);
  let panel = $state<HTMLElement | null>(null);
  let backdrop = $state<HTMLElement | null>(null);
  let opener = $state("");
  let previewFailed = $state(false);
  let copied = $state(false);
  let closing = false;
  let finished = false;

  const current = $derived(items[index] ?? null);
  const locale = getLocale();
  const date = $derived(current ? relativeDay(current.modified, Date.now(), locale) : "");
  const image = $derived(
    current
      ? (session.previews.get(current.path) ??
          session.thumbs.get(current.path) ??
          (index === start ? thumb : null))
      : null,
  );

  const menuEntries: MenuEntry[] = $derived.by(() => [
    { kind: "item", id: "open", label: m.gallery_open() },
    { kind: "item", id: "reveal", label: m.gallery_reveal() },
    { kind: "item", id: "copy", label: copied ? m.gallery_copied() : m.gallery_copy() },
    { kind: "separator" },
    { kind: "item", id: "manage", label: m.gallery_open_settings() },
  ]);

  $effect(() => {
    const item = current;
    if (!item) return;
    let live = true;
    previewFailed = false;
    copied = false;
    // The map reads inside these calls must not become effect dependencies:
    // the preview cache is written by them, and tracking it would make the
    // effect chase its own answer.
    void untrack(() => session.preview(item)).then((data) => {
      if (live && !data) previewFailed = true;
    });
    void untrack(() => session.opener(item)).then((name) => {
      if (live) opener = name;
    });
    return () => {
      live = false;
    };
  });

  function step(delta: number) {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    index = next;
  }

  function focusable(): HTMLElement[] {
    if (!panel) return [];
    return [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.offsetParent !== null);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key !== "Tab" || !panel) return;
    const stops = focusable();
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  function openAnimation() {
    if (!panel || !backdrop) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = origin?.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    if (from && from.width > 0 && to.width > 0) {
      const scale = from.width / to.width;
      const x = from.left + from.width / 2 - (to.left + to.width / 2);
      const y = from.top + from.height / 2 - (to.top + to.height / 2);
      panel.animate(
        [
          { transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: 0.35 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
      );
    } else {
      panel.animate(
        [
          { opacity: 0, scale: 0.97 },
          { opacity: 1, scale: 1 },
        ],
        {
          duration: 200,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "both",
        },
      );
    }
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      easing: "linear",
      fill: "both",
    });
  }

  function settle() {
    if (finished) return;
    finished = true;
    onclose();
  }

  function close() {
    if (closing) return;
    closing = true;
    if (!panel || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }
    const from = origin?.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    let animation: Animation | null = null;
    if (from && from.width > 0 && to.width > 0) {
      const scale = from.width / to.width;
      const x = from.left + from.width / 2 - (to.left + to.width / 2);
      const y = from.top + from.height / 2 - (to.top + to.height / 2);
      animation = panel.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: `translate(${x}px, ${y}px) scale(${scale})`, opacity: 0.2 },
        ],
        { duration: 200, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "both" },
      );
    }
    backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 170,
      easing: "linear",
      fill: "both",
    });
    if (animation) animation.finished.then(settle, settle);
    else settle();
    // A cancelled animation still has to close the dialog.
    setTimeout(settle, 320);
  }

  onMount(() => {
    const scroller = origin?.closest("[data-gallery-scroll]");
    const previousOverflow = scroller instanceof HTMLElement ? scroller.style.overflow : "";
    if (scroller instanceof HTMLElement) scroller.style.overflow = "hidden";
    window.addEventListener("keydown", onKey, true);
    void tick().then(() => {
      panel?.querySelector<HTMLButtonElement>(".moves button")?.focus();
      openAnimation();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (scroller instanceof HTMLElement) scroller.style.overflow = previousOverflow;
    };
  });

  async function choose(id: string) {
    if (!current) return;
    if (id === "manage") {
      onmanage();
      return;
    }
    if (id === "copy") copied = (await session.act("copy", current)) || copied;
    else await session.act(id as "open" | "reveal", current);
  }
</script>

<div class="viewer" role="dialog" aria-modal="true" aria-label={current?.name ?? m.gallery_title()}>
  <div class="scrim" bind:this={backdrop} onclick={close} role="presentation"></div>
  <section class="panel" bind:this={panel}>
    <header class="bar">
      <div class="moves">
        <IconButton icon={Cancel01Icon} label={m.gallery_close()} onclick={close} />
        <span class="rule" aria-hidden="true"></span>
        <IconButton
          icon={ArrowLeft02Icon}
          label={m.gallery_previous()}
          disabled={index <= 0}
          onclick={() => step(-1)}
        />
        <IconButton
          icon={ArrowRight02Icon}
          label={m.gallery_next()}
          disabled={index >= items.length - 1}
          onclick={() => step(1)}
        />
      </div>
      {#if current}
        <div class="identity">
          <h2 title={current.name}>{current.name}</h2>
          <span>{date}</span>
        </div>
      {/if}
      <div class="actions">
        <Menu label={m.gallery_more()} entries={menuEntries} onselect={(id) => void choose(id)}>
          {#snippet trigger()}<Icon icon={MoreHorizontalIcon} size={17} />{/snippet}
        </Menu>
        <button type="button" class="open" onclick={() => void choose("open")}>
          {current ? openLabel(opener) : m.gallery_open()}
        </button>
      </div>
    </header>
    <div class="stage">
      {#if image}
        {#key current?.path}
          <img class="picture" src={image} alt={current?.name ?? ""} decoding="async" />
        {/key}
      {:else if current}
        <div class="waiting" role="status">
          <span class="glyph"><Icon icon={Image02Icon} size={28} /></span>
          <span>{previewFailed ? m.gallery_open() : m.gallery_loading()}</span>
        </div>
      {/if}
    </div>
    {#if current && !image && previewFailed}
      <footer class="fallback">
        <span>{m.gallery_preview_unavailable()}</span>
        <button type="button" onclick={() => void session.act("reveal", current)}>
          <Icon icon={FolderOpenIcon} size={14} />{m.gallery_reveal()}
        </button>
      </footer>
    {/if}
  </section>
</div>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 40px;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: var(--overlay-scrim);
  }

  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    inline-size: fit-content;
    min-inline-size: min(720px, calc(100vw - 48px));
    max-inline-size: min(1280px, calc(100vw - 48px));
    max-block-size: calc(100vh - 72px);
    overflow: hidden;
    border-radius: var(--overlay-radius);
    background: var(--overlay-ground);
    box-shadow: var(--overlay-shadow);
    transform-origin: 50% 50%;
  }

  .bar {
    display: flex;
    align-items: center;
    flex: none;
    gap: 8px;
    min-block-size: 52px;
    padding: 0 10px 0 8px;
    border-block-end: 1px solid var(--color-border);
  }

  .moves {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }

  .rule {
    inline-size: 1px;
    block-size: 16px;
    margin: 0 3px;
    background: var(--color-border);
  }

  .identity {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-inline-size: 0;
    margin-inline: 4px auto;
  }

  .identity h2 {
    margin: 0;
    overflow: hidden;
    max-inline-size: 46vw;
    color: var(--color-text);
    font-size: var(--text-page-title);
    font-weight: 550;
    line-height: 1.3;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .identity span {
    flex: none;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .open {
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-field);
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-label);
    font-weight: 550;
    white-space: nowrap;
    cursor: default;
    transition: background-color var(--motion-instant) var(--ease-smooth);
  }

  .open:hover {
    background: var(--row-hover);
  }

  .open:focus-visible {
    outline: none;
    box-shadow: var(--shadow-field-focus);
  }

  .stage {
    display: grid;
    place-items: center;
    min-block-size: 220px;
    max-block-size: calc(100vh - 124px);
    overflow: hidden;
    background: var(--color-page);
  }

  .picture {
    display: block;
    max-inline-size: 100%;
    max-block-size: calc(100vh - 124px);
    object-fit: contain;
    animation: picture-in var(--motion-base) var(--ease-out) both;
  }

  @keyframes picture-in {
    from {
      opacity: 0;
    }
  }

  .waiting {
    display: flex;
    align-items: center;
    flex-direction: column;
    gap: 12px;
    padding: 64px 80px;
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .glyph {
    display: grid;
    place-items: center;
    inline-size: 52px;
    block-size: 52px;
    border-radius: 50%;
    background: var(--color-field);
  }

  .fallback {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    border-block-start: 1px solid var(--color-border);
    color: var(--color-faint);
    font-size: var(--text-label);
  }

  .fallback button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border: 0;
    border-radius: var(--radius-field);
    background: var(--color-field);
    color: var(--color-text);
    font: inherit;
    cursor: default;
  }

  @media (width < 700px) {
    .viewer {
      padding: 16px;
    }

    .panel {
      min-inline-size: calc(100vw - 24px);
      max-inline-size: calc(100vw - 24px);
      max-block-size: calc(100vh - 24px);
    }

    .identity h2 {
      max-inline-size: 30vw;
    }

    .identity span {
      display: none;
    }

    .stage,
    .picture {
      max-block-size: calc(100vh - 84px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .picture {
      animation: none;
    }
  }
</style>
