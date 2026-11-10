<script lang="ts">
  import { onMount } from "svelte";
  import { passkeys, passkeyPromptMessage } from "$domain/passkeys";
  import Button from "$shared/ui/Button";
  import * as m from "$shared/i18n/messages";

  const active = $derived(passkeys.prompt());
  const prompt = $derived(active?.prompt ?? null);
  const origin = $derived(active?.origin ?? "");
  const answering = $derived(passkeys.isAnswering());
  let pin = $state("");
  let input = $state<HTMLInputElement>();
  let sheet = $state<HTMLDivElement>();

  const needsPin = $derived(
    prompt?.type === "pin-required" ||
      prompt?.type === "pin-invalid" ||
      prompt?.type === "uv-invalid",
  );

  $effect(() => {
    if (needsPin) queueMicrotask(() => input?.focus());
    else queueMicrotask(() => sheet?.querySelector<HTMLElement>("button")?.focus());
  });

  function submit(): void {
    if (!needsPin || pin.length === 0 || answering) return;
    void passkeys.answer("pin", pin).then(() => (pin = ""));
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !answering) {
      event.preventDefault();
      void passkeys.answer("cancel");
    }
    if (event.key === "Enter" && needsPin) {
      event.preventDefault();
      submit();
    }
  }

  // A presence prompt is the engine's "a person asked for this" beat; the
  // verification prompt follows it. Dismissing the sheet here does not answer
  // the browser, which is still waiting for the vault unlock that comes next.
  function proceed(): void {
    passkeys.dismiss();
  }

  onMount(() => {
    pin = "";
  });
</script>

<svelte:window {onkeydown} />

{#if prompt !== null}
  <div class="scrim" role="presentation"></div>
  <div
    bind:this={sheet}
    class="sheet"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="passkey-prompt-title"
    aria-describedby="passkey-prompt-body"
  >
    <h1 id="passkey-prompt-title">{m.passkey_prompt_title()}</h1>
    <p id="passkey-prompt-body" class="origin">{origin}</p>

    {#if needsPin}
      <p class="copy">{m.passkey_prompt_pin({ origin })}</p>
      {#if prompt?.type === "pin-invalid" || prompt?.type === "uv-invalid"}
        <p class="warning">{m.passkey_prompt_pin_invalid()}</p>
      {/if}
      <label class="field">
        <span>{m.passkey_pin_label()}</span>
        <input
          bind:this={input}
          bind:value={pin}
          type="password"
          autocomplete="current-password"
          inputmode="text"
          maxlength={63}
          disabled={answering}
        />
      </label>
      <div class="actions">
        <Button variant="ghost" disabled={answering} onclick={() => void passkeys.answer("cancel")}
          >{m.passkey_prompt_cancel()}</Button
        >
        <Button variant="primary" pending={answering} disabled={pin.length === 0} onclick={submit}
          >{m.passkey_prompt_continue()}</Button
        >
      </div>
    {:else if prompt.type === "select-sign-result"}
      <p class="copy">{m.passkey_prompt_pin({ origin })}</p>
      <ul class="accounts">
        {#each prompt.entities as entity, index (index)}
          <li>
            <Button
              variant="secondary"
              disabled={answering}
              onclick={() => void passkeys.answer("select", String(index))}
              >{entity.name ?? entity.display_name ?? m.passkey_title()}</Button
            >
          </li>
        {/each}
      </ul>
      <div class="actions">
        <Button variant="ghost" disabled={answering} onclick={() => void passkeys.answer("cancel")}
          >{m.passkey_prompt_cancel()}</Button
        >
      </div>
    {:else if prompt.type === "presence"}
      <p class="copy">{m.passkey_prompt_pin({ origin })}</p>
      <div class="actions">
        <Button variant="ghost" onclick={() => void passkeys.answer("cancel")}
          >{m.passkey_prompt_cancel()}</Button
        >
        <Button variant="primary" onclick={proceed}>{m.passkey_prompt_continue()}</Button>
      </div>
    {:else}
      <p class="copy">{passkeyPromptMessage(prompt)}</p>
      <div class="actions">
        <Button variant="secondary" onclick={() => void passkeys.answer("cancel")}
          >{m.passkey_prompt_cancel()}</Button
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--overlay-scrim);
    backdrop-filter: blur(2px);
  }

  .sheet {
    position: fixed;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    z-index: 61;
    box-sizing: border-box;
    width: min(420px, calc(100vw - 32px));
    padding: var(--overlay-pad);
    border-radius: var(--overlay-radius);
    background: var(--overlay-ground);
    box-shadow: var(--overlay-shadow);
    text-align: start;
    animation: sheet-in var(--motion-slow) var(--ease-out) both;
  }

  h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .origin {
    margin: 4px 0 12px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .copy {
    margin: 0 0 12px;
    font-size: 14px;
    color: var(--text-primary);
  }

  .warning {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--danger-text);
  }

  .field {
    display: grid;
    gap: 6px;
    margin-bottom: 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .field input {
    box-sizing: border-box;
    width: 100%;
    padding: 9px 10px;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-control);
    background: var(--field-ground);
    color: var(--text-primary);
    font: inherit;
    letter-spacing: 0.12em;
  }

  .field input:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 1px;
  }

  .accounts {
    display: grid;
    gap: 8px;
    margin: 0 0 16px;
    padding: 0;
    list-style: none;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }
</style>
