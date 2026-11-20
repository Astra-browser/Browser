<script lang="ts">
  import { onMount } from "svelte";
  import * as m from "$shared/i18n/messages";
  import { blocker } from "$domain/blocker";
  import type { BlockerListEntry, BlockerListsView } from "$shared/ipc/bindings";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";
  import Button from "$shared/ui/Button";

  let view = $state<BlockerListsView | null>(null);
  let busy = $state(false);
  let message = $state("");
  let customUrl = $state("");
  let customDraft = $state<string[]>([]);
  let rulesDraft = $state("");
  let open = $state<Record<string, boolean>>({
    ads: true,
    privacy: true,
    malware: true,
  });

  const status = $derived(blocker.status());
  const unavailable = $derived(view !== null && view.available !== true);
  const standing = $derived(
    status.protection === "pending"
      ? m.protection_status_pending()
      : status.protection === "active"
        ? m.protection_status_active()
        : status.protection === "disabled"
          ? m.protection_status_off()
          : status.protection === "degraded"
            ? m.protection_status_degraded()
            : m.protection_status_unavailable(),
  );

  const groups = $derived.by(() => {
    const out: Array<{ group: string; label: string; lists: BlockerListEntry[] }> = [];
    for (const entry of view?.lists ?? []) {
      const index = out.findIndex((row) => row.group === entry.group);
      if (index === -1) {
        out.push({ group: entry.group, label: groupLabel(entry.group), lists: [entry] });
      } else {
        out[index]!.lists.push(entry);
      }
    }
    return out;
  });

  const defaultCount = $derived((view?.lists ?? []).filter((entry) => entry.enabled).length);

  onMount(() => {
    void refresh();
  });

  async function refresh() {
    try {
      view = await blocker.lists();
      customDraft = (view?.custom_lists ?? []).map((entry) => entry.url);
      rulesDraft = view?.user_rules ?? "";
    } catch {
      view = null;
    }
  }

  async function run(action: () => Promise<blocker.BlockerMutationResult>) {
    if (busy) return;
    busy = true;
    message = "";
    try {
      const result = await action();
      if (result.state === "pending") {
        message = m.protection_change_pending();
      } else if (
        result.state !== "processed" ||
        !["applied", "no_op"].includes(result.disposition.outcome)
      ) {
        message = m.protection_change_unconfirmed();
      }
      await refresh();
    } finally {
      busy = false;
    }
  }

  function groupLabel(group: string): string {
    switch (group) {
      case "ads":
        return m.protection_group_ads();
      case "privacy":
        return m.protection_group_privacy();
      case "malware":
        return m.protection_group_malware();
      case "regional":
        return m.protection_group_regional();
      default:
        return m.protection_group_optional();
    }
  }

  function toggleList(entry: BlockerListEntry, enabled: boolean) {
    if (!view) return;
    const next = view.lists.filter((row) => row.enabled).map((row) => row.id);
    if (enabled && !next.includes(entry.id)) next.push(entry.id);
    if (!enabled) {
      const index = next.indexOf(entry.id);
      if (index !== -1) next.splice(index, 1);
    }
    if (next.length === 0) {
      message = m.protection_keep_one();
      return;
    }
    void run(() =>
      blocker.configure({
        listIds: next,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
      }),
    );
  }

  function setSchedule(hours: number) {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: hours,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
      }),
    );
  }

  function setAutoUpdate(enabled: boolean) {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: enabled,
        cosmetic: null,
        scriptlets: null,
      }),
    );
  }

  function setCosmetic(enabled: boolean) {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: enabled,
        scriptlets: null,
      }),
    );
  }

  function setScriptlets(enabled: boolean) {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: enabled,
      }),
    );
  }

  function setMode(mode: "standard" | "aggressive") {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
        mode,
      }),
    );
  }

  function setFlag(
    key: "removeparam" | "bounce" | "blockScripts" | "redirects" | "cname",
    enabled: boolean,
  ) {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
        [key]: enabled,
      }),
    );
  }

  function addCustomList() {
    const url = customUrl.trim();
    if (!/^https:\/\/\S+$/iu.test(url)) {
      message = m.protection_custom_https();
      return;
    }
    if (customDraft.includes(url)) {
      message = m.protection_custom_duplicate();
      return;
    }
    const next = [...customDraft, url];
    customUrl = "";
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
        customLists: next,
      }),
    );
  }

  function removeCustomList(url: string) {
    const next = customDraft.filter((entry) => entry !== url);
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
        customLists: next,
      }),
    );
  }

  function saveRules() {
    void run(() =>
      blocker.configure({
        listIds: null,
        updateHours: null,
        autoUpdate: null,
        cosmetic: null,
        scriptlets: null,
        userRules: rulesDraft,
      }),
    );
  }

  function formatDate(value: number | null | undefined): string {
    if (!value || !Number.isFinite(value)) return m.protection_never();
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return m.protection_unknown();
    }
  }

  // Units stay symbols: "MB" and "KB" are not words in any shipped locale.
  function formatBytes(value: number | null | undefined): string {
    if (!value) return "—";
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value > 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
</script>

<SettingsGroup title={m.protection_title()} description={m.protection_description()}>
  <SettingsRow title={m.protection_blocking()} description={standing} settingId="privacy.blocking">
    <Switch
      label={m.protection_blocking()}
      labelHidden
      checked={status.desired_enabled === true}
      disabled={busy ||
        status.preference !== "authoritative" ||
        status.protection === "pending" ||
        (status.desired_enabled !== true && !status.can_enable)}
      onchange={(enabled) => void run(() => blocker.setEnabled(enabled))}
    />
  </SettingsRow>

  <SettingsRow
    title={m.protection_mode()}
    description={view?.mode === "aggressive"
      ? m.protection_mode_aggressive_help()
      : m.protection_mode_standard_help()}
  >
    <div class="segmented" role="group" aria-label={m.protection_mode()}>
      <button
        type="button"
        class:active={view?.mode !== "aggressive"}
        disabled={busy || view === null}
        onclick={() => setMode("standard")}>{m.protection_mode_standard()}</button
      >
      <button
        type="button"
        class:active={view?.mode === "aggressive"}
        disabled={busy || view === null}
        onclick={() => setMode("aggressive")}>{m.protection_mode_aggressive()}</button
      >
    </div>
  </SettingsRow>

  <SettingsRow title={m.protection_removeparam()} description={m.protection_removeparam_help()}>
    <Switch
      label={m.protection_removeparam()}
      labelHidden
      checked={view?.removeparam !== false}
      disabled={busy || view === null}
      onchange={(enabled) => setFlag("removeparam", enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_bounce()} description={m.protection_bounce_help()}>
    <Switch
      label={m.protection_bounce()}
      labelHidden
      checked={view?.bounce !== false}
      disabled={busy || view === null}
      onchange={(enabled) => setFlag("bounce", enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_cname()} description={m.protection_cname_help()}>
    <Switch
      label={m.protection_cname()}
      labelHidden
      checked={view?.cname !== false}
      disabled={busy || view === null}
      onchange={(enabled) => setFlag("cname", enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_redirects()} description={m.protection_redirects_help()}>
    <Switch
      label={m.protection_redirects_label()}
      labelHidden
      checked={view?.redirects !== false}
      disabled={busy || view === null}
      onchange={(enabled) => setFlag("redirects", enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_scripts()} description={m.protection_scripts_help()}>
    <Switch
      label={m.protection_scripts()}
      labelHidden
      checked={view?.block_scripts === true}
      disabled={busy || view === null}
      onchange={(enabled) => setFlag("blockScripts", enabled)}
    />
  </SettingsRow>

  <SettingsRow
    title={m.protection_lists()}
    description={unavailable
      ? m.protection_lists_unavailable()
      : m.protection_lists_summary({
          enabled: defaultCount,
          total: view?.lists.length ?? 0,
          rules: view?.installed_rules ?? 0,
          bytes: formatBytes(
            view?.lists.reduce((sum, entry) => sum + (entry.enabled ? (entry.bytes ?? 0) : 0), 0),
          ),
        })}
  >
    <Button
      disabled={busy || status.can_refresh_sources !== true}
      onclick={() => void run(blocker.refreshSources)}
      >{busy ? m.protection_update_busy() : m.protection_update_now()}</Button
    >
  </SettingsRow>

  <SettingsRow
    title={m.protection_updates()}
    description={view === null
      ? m.protection_updates_reading()
      : view.auto_update
        ? m.protection_updates_auto({
            schedule:
              view.update_hours === 0
                ? m.protection_updates_on_demand()
                : m.protection_updates_every_hours({ hours: view.update_hours }),
            date: formatDate(view.last_update_unix),
          })
        : m.protection_updates_off()}
  >
    <Switch
      label={m.protection_updates_label()}
      labelHidden
      checked={view?.auto_update === true}
      disabled={busy || view === null}
      onchange={(enabled) => setAutoUpdate(enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_interval()} description={m.protection_interval_help()}>
    <select
      class="select"
      aria-label={m.protection_interval()}
      value={String(view?.update_hours ?? 24)}
      disabled={busy || view === null}
      onchange={(event) => setSchedule(Number(event.currentTarget.value))}
    >
      <option value="6">{m.protection_interval_6()}</option>
      <option value="12">{m.protection_interval_12()}</option>
      <option value="24">{m.protection_interval_24()}</option>
      <option value="48">{m.protection_interval_48()}</option>
      <option value="72">{m.protection_interval_72()}</option>
      <option value="168">{m.protection_interval_week()}</option>
      <option value="0">{m.protection_interval_never()}</option>
    </select>
  </SettingsRow>

  <SettingsRow title={m.protection_cosmetic()} description={m.protection_cosmetic_help()}>
    <Switch
      label={m.protection_cosmetic_label()}
      labelHidden
      checked={view?.cosmetic === true}
      disabled={busy || view === null}
      onchange={(enabled) => setCosmetic(enabled)}
    />
  </SettingsRow>

  <SettingsRow title={m.protection_scriptlets()} description={m.protection_scriptlets_help()}>
    <Switch
      label={m.protection_scriptlets_label()}
      labelHidden
      checked={view?.scriptlets === true}
      disabled={busy || view === null}
      onchange={(enabled) => setScriptlets(enabled)}
    />
  </SettingsRow>

  {#if (view?.cloaked?.length ?? 0) > 0}
    <SettingsRow title={m.protection_cloaked()} description={view?.cloaked?.join(", ")}>
      <span></span>
    </SettingsRow>
  {/if}

  <SettingsRow
    title={m.protection_stats()}
    description={view?.stats?.today == null
      ? m.protection_stats_unavailable()
      : m.protection_stats_summary({
          today: view.stats.today,
          week: view.stats.last7Days ?? 0,
        })}
  >
    <Button disabled={busy || view === null} onclick={() => void run(blocker.resetStats)}
      >{m.protection_stats_reset()}</Button
    >
  </SettingsRow>

  <div class="catalog">
    {#each groups as group (group.group)}
      <section class="group">
        <button
          type="button"
          class="group-head"
          aria-expanded={open[group.group] === true}
          onclick={() => (open[group.group] = !open[group.group])}
        >
          <span>{group.label}</span>
          <span class="count"
            >{group.lists.filter((entry) => entry.enabled).length}/{group.lists.length}</span
          >
        </button>
        {#if open[group.group]}
          <ul class="list">
            {#each group.lists as entry (entry.id)}
              <li class="row">
                <label class="check">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    disabled={busy}
                    onchange={(event) => toggleList(entry, event.currentTarget.checked)}
                  />
                  <span class="title">{entry.title}</span>
                </label>
                <span class="meta">
                  {#if entry.bundled}<span class="badge">{m.protection_badge_bundled()}</span>{/if}
                  <span>{entry.license || m.protection_license_fallback()}</span>
                  {#if entry.bytes}<span>{formatBytes(entry.bytes)}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
    {#if view === null}
      <p class="empty">{m.protection_catalog_reading()}</p>
    {:else if view.lists.length === 0}
      <p class="empty">{m.protection_catalog_empty()}</p>
    {/if}
  </div>
  <SettingsRow title={m.protection_custom()} description={m.protection_custom_help()}>
    <div class="custom-add">
      <input
        type="url"
        class="input"
        placeholder="https://example.com/list.txt"
        aria-label={m.protection_custom_url_label()}
        bind:value={customUrl}
        disabled={busy}
      />
      <Button disabled={busy || view === null} onclick={addCustomList}
        >{m.protection_custom_add()}</Button
      >
    </div>
  </SettingsRow>

  {#if customDraft.length > 0}
    <ul class="custom-list">
      {#each customDraft as url (url)}
        <li class="row">
          <span class="title">{url}</span>
          <button type="button" class="remove" disabled={busy} onclick={() => removeCustomList(url)}
            >{m.action_remove()}</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  <SettingsRow title={m.protection_rules()} description={m.protection_rules_help()}>
    <div class="rules">
      <textarea
        class="textarea"
        rows="4"
        spellcheck="false"
        aria-label={m.protection_rules_label()}
        bind:value={rulesDraft}
        disabled={busy}></textarea>
      <Button disabled={busy || view === null} onclick={saveRules}
        >{m.protection_rules_save()}</Button
      >
    </div>
  </SettingsRow>
  {#if message}<p class="feedback" role="status">{message}</p>{/if}
</SettingsGroup>

<style>
  .select {
    min-width: 170px;
    min-height: 32px;
    padding: 0 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .catalog {
    display: grid;
    gap: 6px;
    padding: 10px 18px 16px;
  }

  .group {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    overflow: hidden;
  }

  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 36px;
    padding: 0 12px;
    border: 0;
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
    font-weight: 600;
    text-align: start;
    cursor: default;
  }

  .count {
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 6px;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
    padding: 0 6px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }

  .badge {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--color-fill);
    color: var(--color-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .empty,
  .feedback {
    margin: 4px 18px;
    color: var(--color-muted);
    font-size: var(--text-body);
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    overflow: hidden;
  }

  .segmented button {
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    cursor: default;
  }

  .segmented button + button {
    border-inline-start: 1px solid var(--color-border);
  }

  .segmented button.active {
    background: var(--color-accent);
    color: var(--color-on-accent);
  }

  .custom-add,
  .rules {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }

  .input,
  .textarea {
    min-height: 32px;
    padding: 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .input {
    width: min(320px, 42vw);
  }

  .textarea {
    width: min(360px, 46vw);
    resize: vertical;
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }

  .custom-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0 18px 8px;
    list-style: none;
  }

  .remove {
    border: 0;
    background: none;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--text-label);
    cursor: default;
  }
</style>
