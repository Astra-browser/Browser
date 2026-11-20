<script lang="ts">
  import { onMount } from "svelte";
  import type { PageDialogKind } from "$shared/ipc/bindings";
  import Button from "$shared/ui/Button";
  import { answer, busy, prompt } from "../lib/page-dialogs.svelte";

  // The engine (ASTRA-0020) hands page dialogs to this window; the app draws
  // them so Firefox's commonDialog never answers a page. The card is a sheet
  // over the page: the dialog has already stopped the page's own script.

  const HEADINGS: Record<PageDialogKind, string> = {
    alert: "Alert",
    confirm: "Confirm",
    prompt: "Enter a value",
    beforeunload: "Leave this page?",
  };

  let dialog = $state<HTMLDivElement>();
  let field = $state<HTMLInputElement>();
  let checkbox = $state<HTMLInputElement>();
  let cancelButton = $state<HTMLButtonElement>();

  let request = $derived(prompt());
  let kind = $derived(request?.kind ?? "alert");
  let heading = $derived(HEADINGS[kind]);
  let host = $derived(request?.host ?? "");
  let message = $derived(request?.text ?? "");
  let checkboxLabel = $derived(request?.checkboxLabel ?? "");
  let isPrompt = $derived(kind === "prompt");
  let isLeave = $derived(kind === "beforeunload");
  let hasCheckbox = $derived(checkboxLabel !== "");

  let typed = $state("");
  let checked = $state(false);
  let shown = $state("");

  // A new request starts from the page's own default, never the previous one.
  $effect(() => {
    const current = request;
    if (!current) return;
    if (current.request === shown) return;
    shown = current.request;
    typed = current.defaultValue;
    checked = false;
    queueMicrotask(() => {
      if (isPrompt) {
        field?.focus();
        field?.select();
      } else {
        cancelButton?.focus();
      }
    });
  });

  onMount(() => () => {
    shown = "";
  });

  function settle(confirmed: boolean) {
    if (!request || busy()) return;
    void answer({ confirmed, value: typed, checked });
  }

  function onkeydown(event: KeyboardEvent) {
    if (!request) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      settle(false);
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialog?.querySelectorAll<HTMLElement>("button") ?? []);
    const focusable = [
      ...(field ? [field] : []),
      ...(checkbox ? [checkbox] : []),
      ...buttons,
    ].filter((element) => !element.hasAttribute("disabled"));
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function oninputkeydown(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    settle(true);
  }
</script>

<svelte:window {onkeydown} />

{#if request}
  <div class="scrim" data-astra-page-dialog-scrim>
    <div
      bind:this={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="page-dialog-title"
      aria-describedby={message === "" ? undefined : "page-dialog-text"}
      class="sheet"
      data-astra-page-dialog={kind}
    >
      <header class="head">
        <h1 id="page-dialog-title" class="title">{heading}</h1>
        {#if host}
          <p class="host" title={host}>{host}</p>
        {/if}
      </header>

      {#if message}
        <p id="page-dialog-text" class="message">{message}</p>
      {:else if isPrompt}
        <p id="page-dialog-text" class="message">This page is asking for a value.</p>
      {/if}

      {#if isPrompt}
        <input
          bind:this={field}
          bind:value={typed}
          class="field"
          type="text"
          aria-labelledby="page-dialog-title"
          onkeydown={oninputkeydown}
        />
      {/if}

      {#if hasCheckbox}
        <label class="check">
          <input bind:this={checkbox} bind:checked type="checkbox" />
          <span>{checkboxLabel}</span>
        </label>
      {/if}

      <div class="actions">
        {#if isLeave}
          <Button
            bind:ref={cancelButton}
            variant="secondary"
            disabled={busy()}
            onclick={() => settle(false)}
          >
            Stay
          </Button>
          <Button variant="danger" disabled={busy()} onclick={() => settle(true)}>Leave</Button>
        {:else}
          {#if kind !== "alert"}
            <Button
              bind:ref={cancelButton}
              variant="secondary"
              disabled={busy()}
              onclick={() => settle(false)}
            >
              Cancel
            </Button>
          {/if}
          <Button variant="primary" disabled={busy()} onclick={() => settle(true)}>OK</Button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 16px;
    background: color-mix(in srgb, var(--color-canvas) 78%, transparent);
  }

  .sheet {
    display: grid;
    gap: 10px;
    inline-size: min(380px, calc(100vw - 32px));
    padding: 16px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-panel);
    background: var(--color-raised);
    color: var(--color-text);
    text-align: start;
    box-shadow: var(--shadow-overlay);
  }

  .head {
    display: grid;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
  }

  .host {
    margin: 0;
    overflow: hidden;
    color: var(--color-muted);
    font-size: 11.5px;
    line-height: 16px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message {
    max-block-size: 40vh;
    margin: 0;
    overflow: auto;
    font-size: 12.5px;
    line-height: 18px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .field {
    inline-size: 100%;
    padding: 7px 9px;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-control);
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
    font-size: 12.5px;
  }

  .field:focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: 1px;
  }

  .check {
    display: flex;
    gap: 7px;
    align-items: flex-start;
    color: var(--color-muted);
    font-size: 11.5px;
    line-height: 16px;
    overflow-wrap: anywhere;
  }

  .check input {
    margin-block-start: 2px;
  }

  .check input:focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: 1px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-block-start: 4px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .sheet {
      animation: page-dialog-in 120ms var(--ease-smooth) both;
    }
  }

  @keyframes page-dialog-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
