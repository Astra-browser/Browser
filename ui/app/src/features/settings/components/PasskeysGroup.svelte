<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { passkeys, passkeyErrorMessage, passkeyStateLabel } from "$domain/passkeys";
  import type { PasskeyCall } from "$shared/ipc/bindings";
  import Button from "$shared/ui/Button";
  import Field from "$shared/ui/Field";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";
  import * as m from "$shared/i18n/messages";

  let pin = $state("");
  let oldPin = $state("");
  let newPin = $state("");
  let changing = $state(false);
  let confirmingRemoveAll = $state(false);
  let systemUnlock = $state(false);

  const status = $derived(passkeys.current());
  const credentials = $derived(passkeys.list());
  const busy = $derived(passkeys.isBusy());
  const error = $derived(passkeys.error());

  onMount(() => {
    void passkeys.refresh();
  });

  // Leaving Settings releases the vault key this surface held; WebAuthn keeps
  // its own instance and is unaffected.
  onDestroy(() => {
    if (status?.unlocked === true) void passkeys.call({ kind: "lock" });
  });

  async function run(call: PasskeyCall): Promise<void> {
    const response = await passkeys.call(call);
    if (response?.ok === true) {
      pin = "";
      oldPin = "";
      newPin = "";
      changing = false;
    }
  }

  function createdAt(seconds: number): string {
    if (seconds === 0) return m.passkey_never();
    return m.passkey_added({
      date: new Date(seconds * 1000).toLocaleDateString(),
    });
  }
</script>

<SettingsGroup title={m.passkey_title()} description={m.passkey_intro()}>
  {#if status !== null}
    <SettingsRow
      title={m.passkey_title()}
      description={passkeyStateLabel(status.enabled, status.exists, status.unlocked)}
    >
      <Switch
        label={m.passkey_title()}
        labelHidden
        checked={status.enabled}
        disabled={busy}
        onchange={(enabled) => void run({ kind: "set_enabled", enabled })}
      />
    </SettingsRow>

    {#if status.enabled && !status.exists}
      <div class="form">
        <Field
          label={m.passkey_pin_label()}
          hint={m.passkey_pin_help()}
          type="password"
          autocomplete="new-password"
          maxlength={63}
          bind:value={pin}
          disabled={busy}
        />
        <SettingsRow
          title={m.passkey_system_auth()}
          description={status.system_auth_available
            ? undefined
            : m.passkey_system_auth_unavailable()}
        >
          <Switch
            label={m.passkey_system_auth()}
            labelHidden
            checked={systemUnlock}
            disabled={busy}
            onchange={(checked) => (systemUnlock = checked)}
          />
        </SettingsRow>
        <div class="actions">
          <Button
            variant="primary"
            pending={busy}
            disabled={pin.length < 6}
            onclick={() => void run({ kind: "enable", pin, system_unlock: systemUnlock })}
            >{m.passkey_create()}</Button
          >
        </div>
      </div>
    {:else if status.enabled}
      {#if status.system_auth_available || status.system_unlock}
        <SettingsRow
          title={m.passkey_system_auth()}
          description={status.system_auth_available
            ? undefined
            : m.passkey_system_auth_unavailable()}
        >
          <Switch
            label={m.passkey_system_auth()}
            labelHidden
            checked={status.system_unlock}
            disabled={busy || !status.unlocked}
            onchange={(enabled) => void run({ kind: "set_system_unlock", enabled })}
          />
        </SettingsRow>
      {/if}

      {#if status.unlocked}
        <SettingsRow title={m.passkey_credentials()} description={m.passkey_intro()}>
          <Button
            size="compact"
            variant="ghost"
            disabled={busy}
            onclick={() => void run({ kind: "lock" })}>{m.passkey_lock()}</Button
          >
        </SettingsRow>
        {#if credentials.length === 0}
          <SettingsRow title={m.passkey_no_credentials()}>
            <span></span>
          </SettingsRow>
        {:else}
          {#each credentials as credential (credential.id)}
            <SettingsRow
              title={credential.rp_id}
              description={`${credential.user_name ?? ""} · ${createdAt(credential.created_at)}`}
            >
              <Button
                size="compact"
                variant="ghost"
                disabled={busy}
                onclick={() => void run({ kind: "remove", id: credential.id })}
                >{m.passkey_remove()}</Button
              >
            </SettingsRow>
          {/each}
          <div class="actions">
            {#if confirmingRemoveAll}
              <Button
                size="compact"
                variant="ghost"
                disabled={busy}
                onclick={() => (confirmingRemoveAll = false)}>{m.passkey_prompt_cancel()}</Button
              >
              <Button
                size="compact"
                variant="danger"
                disabled={busy}
                onclick={() => {
                  confirmingRemoveAll = false;
                  void run({ kind: "remove_all" });
                }}>{m.passkey_confirm_remove_all()}</Button
              >
            {:else}
              <Button
                size="compact"
                variant="ghost"
                disabled={busy}
                onclick={() => (confirmingRemoveAll = true)}>{m.passkey_remove_all()}</Button
              >
            {/if}
          </div>
        {/if}

        {#if changing}
          <div class="form">
            <Field
              label={m.passkey_old_pin()}
              type="password"
              autocomplete="current-password"
              maxlength={63}
              bind:value={oldPin}
              disabled={busy}
            />
            <Field
              label={m.passkey_new_pin()}
              type="password"
              autocomplete="new-password"
              maxlength={63}
              bind:value={newPin}
              disabled={busy}
            />
            <div class="actions">
              <Button
                size="compact"
                variant="ghost"
                disabled={busy}
                onclick={() => (changing = false)}>{m.passkey_prompt_cancel()}</Button
              >
              <Button
                size="compact"
                variant="primary"
                pending={busy}
                disabled={oldPin.length < 6 || newPin.length < 6}
                onclick={() => void run({ kind: "change_pin", old_pin: oldPin, new_pin: newPin })}
                >{m.passkey_saved()}</Button
              >
            </div>
          </div>
        {:else}
          <div class="actions">
            <Button
              size="compact"
              variant="secondary"
              disabled={busy}
              onclick={() => (changing = true)}>{m.passkey_change_pin()}</Button
            >
          </div>
        {/if}
      {:else}
        <div class="form">
          <Field
            label={m.passkey_pin_label()}
            hint={status.locked_for_secs > 0 ? m.passkey_error_locked() : m.passkey_pin_help()}
            type="password"
            autocomplete="current-password"
            maxlength={63}
            bind:value={pin}
            disabled={busy || status.locked_for_secs > 0}
          />
          <div class="actions">
            <Button
              variant="primary"
              pending={busy}
              disabled={pin.length < 6 || status.locked_for_secs > 0}
              onclick={() => void run({ kind: "unlock", pin })}>{m.passkey_unlock()}</Button
            >
          </div>
        </div>
      {/if}
    {/if}

    {#if error !== null && error !== ""}
      <p class="error" role="alert">{passkeyErrorMessage(error)}</p>
    {/if}
  {/if}
</SettingsGroup>

<style>
  .form {
    display: grid;
    gap: 12px;
    padding: 14px 18px 18px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .error {
    margin: 0;
    padding: 0 18px 16px;
    font-size: 13px;
    color: var(--danger-text);
  }
</style>
