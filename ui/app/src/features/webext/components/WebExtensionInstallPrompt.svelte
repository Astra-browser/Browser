<script lang="ts">
  import { PuzzleIcon } from "@hugeicons/core-free-icons";
  import { onMount } from "svelte";
  import type { WebExtensionPromptView } from "$shared/ipc/bindings";
  import { webext } from "$domain/webext";
  import Button from "$shared/ui/Button";
  import Checkbox from "$shared/ui/Checkbox";
  import Icon from "$shared/ui/Icon";
  import * as m from "$shared/i18n/messages";
  import PromptSheet from "./PromptSheet.svelte";

  let { prompt }: { prompt: WebExtensionPromptView } = $props();
  let privateWindows = $state(false);
  let technicalData = $state(true);
  $effect(() => {
    privateWindows = prompt.private_allowed === true;
    technicalData = prompt.technical_allowed !== false;
  });
  let cancelButton = $state<HTMLButtonElement>();
  let busy = $derived(webext.isAnsweringPrompt());

  onMount(() => queueMicrotask(() => cancelButton?.focus()));

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      event.stopPropagation();
      void webext.answerPrompt(false, privateWindows, technicalData);
    }
  }
</script>

<svelte:window {onkeydown} />

<PromptSheet labelledby="web-extension-prompt-title" describedby="web-extension-prompt-body">
  <div class="head">
    <span class="badge" aria-hidden="true">
      {#if prompt.icon}
        <img src={prompt.icon} alt="" />
      {:else}
        <Icon icon={PuzzleIcon} size={20} />
      {/if}
    </span>
    <div class="title">
      <h1 id="web-extension-prompt-title">{prompt.header}</h1>
      <p>{prompt.name}</p>
    </div>
  </div>

  <div id="web-extension-prompt-body" class="body">
    {#if prompt.unsigned}
      <p class="warning">{m.webext_prompt_unsigned()}</p>
    {/if}

    {#if prompt.messages.length > 0}
      <h2>{m.webext_prompt_required()}</h2>
      <ul>
        {#each prompt.messages as message (message)}
          <li>{message}</li>
        {/each}
      </ul>
    {/if}

    {#if prompt.data_collection}
      <h2>{m.webext_prompt_data()}</h2>
      <p>{prompt.data_collection}</p>
    {/if}

    {#if prompt.show_private || prompt.show_technical}
      <h2>{m.webext_prompt_optional()}</h2>
      <div class="choices">
        {#if prompt.show_private}
          <Checkbox
            label={m.webext_prompt_private()}
            checked={privateWindows}
            disabled={busy}
            onchange={(checked) => (privateWindows = checked)}
          />
        {/if}
        {#if prompt.show_technical}
          <Checkbox
            label={m.webext_prompt_technical()}
            checked={technicalData}
            disabled={busy}
            onchange={(checked) => (technicalData = checked)}
          />
        {/if}
      </div>
    {/if}
  </div>

  <div class="actions">
    <Button
      bind:ref={cancelButton}
      variant="secondary"
      disabled={busy}
      onclick={() => void webext.answerPrompt(false, privateWindows, technicalData)}
      >{prompt.cancel_text}</Button
    >
    <Button
      variant="primary"
      pending={busy}
      onclick={() => void webext.answerPrompt(true, privateWindows, technicalData)}
      >{prompt.accept_text}</Button
    >
  </div>
</PromptSheet>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .badge {
    display: grid;
    flex: none;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-control);
    background: var(--color-fill);
    color: var(--color-muted);
  }

  .badge img {
    width: 32px;
    height: 32px;
  }

  .title {
    min-width: 0;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
    color: var(--color-text);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title p {
    margin: 0;
    overflow: hidden;
    font-size: var(--text-label);
    color: var(--color-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .body {
    margin-block-start: 14px;
    font-size: var(--text-label);
    line-height: 1.45;
    color: var(--color-label-secondary);
  }

  h2 {
    margin: 12px 0 4px;
    font-size: var(--text-caption);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-muted);
  }

  h2:first-child {
    margin-block-start: 0;
  }

  .body p {
    margin: 0;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding-inline-start: 16px;
  }

  .warning {
    margin-block-end: 10px;
    color: var(--color-warning);
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-start: 6px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-block-start: 18px;
  }
</style>
