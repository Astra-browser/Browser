<script lang="ts">
  import { onMount } from "svelte";
  import { blocker } from "$domain/blocker";
  import { preferences } from "$domain/preferences";
  import type { BlockerListEntry, BlockerListsView } from "$shared/ipc/bindings";
  import SettingsGroup from "$shared/ui/SettingsGroup";
  import SettingsRow from "$shared/ui/SettingsRow";
  import Switch from "$shared/ui/Switch";
  import Button from "$shared/ui/Button";

  let view = $state<BlockerListsView | null>(null);
  let busy = $state(false);
  let message = $state("");
  let open = $state<Record<string, boolean>>({
    ads: true,
    privacy: true,
    malware: true,
  });

  const status = $derived(blocker.status());
  const unavailable = $derived(view !== null && view.available !== true);
  const standing = $derived(
    status.protection === "pending"
      ? "Preparing protection… You can keep browsing."
      : status.protection === "active"
        ? "Protection is active."
        : status.protection === "disabled"
          ? "Protection is off for this profile."
          : status.protection === "degraded"
            ? "Protection needs attention. The last working rules stay installed."
            : "Protection is unavailable in this build.",
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
        message = "The change is still being applied.";
      } else if (
        result.state !== "processed" ||
        !["applied", "no_op"].includes(result.disposition.outcome)
      ) {
        message = "Could not confirm this change. Check the status or retry.";
      }
      await refresh();
    } finally {
      busy = false;
    }
  }

  function groupLabel(group: string): string {
    switch (group) {
      case "ads":
        return "Ads and annoyances";
      case "privacy":
        return "Trackers and privacy";
      case "malware":
        return "Malware and scams";
      case "regional":
        return "Regional lists";
      default:
        return "Optional lists";
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
      message = "Keep at least one filter list enabled.";
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

  function formatDate(value: number | null | undefined): string {
    if (!value || !Number.isFinite(value)) return "Never";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "Unknown";
    }
  }

  function formatBytes(value: number | null | undefined): string {
    if (!value) return "—";
    if (value > 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value > 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
</script>

<SettingsGroup
  title="Ad, tracker and malware protection"
  description="Astra blocks network requests with the engine's own channel hook and hides the elements its filter lists match. Filter lists update on the schedule you choose; an update never removes the last working rules."
>
  <SettingsRow
    title="Block ads, trackers and malware"
    description={standing}
    settingId="privacy.blocking"
  >
    <Switch
      label="Block ads, trackers and malware"
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
    title="Filter lists"
    description={unavailable
      ? "The list catalog could not be read in this build."
      : `${defaultCount} of ${view?.lists.length ?? 0} lists enabled · ${view?.installed_rules ?? 0} compiled rules · ${formatBytes(
          view?.lists.reduce((sum, entry) => sum + (entry.enabled ? (entry.bytes ?? 0) : 0), 0),
        )}`}
  >
    <Button
      disabled={busy || status.can_refresh_sources !== true}
      onclick={() => void run(blocker.refreshSources)}
      >{busy ? "Updating…" : "Update lists now"}</Button
    >
  </SettingsRow>

  <SettingsRow
    title="Automatic updates"
    description={view === null
      ? "Reading the schedule…"
      : view.auto_update
        ? `Checks the enabled sources ${view.update_hours === 0 ? "on demand only" : `every ${view.update_hours} hours`}. Last check: ${formatDate(view.last_update_unix)}.`
        : "Automatic checks are off. Use “Update lists now” whenever you want a refresh."}
  >
    <Switch
      label="Check for list updates"
      labelHidden
      checked={view?.auto_update === true}
      disabled={busy || view === null}
      onchange={(enabled) => setAutoUpdate(enabled)}
    />
  </SettingsRow>

  <SettingsRow
    title="Check interval"
    description="A cron-like schedule: the browser checks while it is running and catches up on the next start when a check was missed."
  >
    <select
      class="select"
      aria-label="Check interval"
      value={String(view?.update_hours ?? 24)}
      disabled={busy || view === null}
      onchange={(event) => setSchedule(Number(event.currentTarget.value))}
    >
      <option value="6">Every 6 hours</option>
      <option value="12">Every 12 hours</option>
      <option value="24">Every 24 hours</option>
      <option value="48">Every 2 days</option>
      <option value="72">Every 3 days</option>
      <option value="168">Every week</option>
      <option value="0">Never (manual only)</option>
    </select>
  </SettingsRow>

  <SettingsRow
    title="Element hiding"
    description="Inject the cosmetic rules the lists carry. This is what removes the empty boxes ads leave behind."
  >
    <Switch
      label="Hide matching page elements"
      labelHidden
      checked={view?.cosmetic === true}
      disabled={busy || view === null}
      onchange={(enabled) => setCosmetic(enabled)}
    />
  </SettingsRow>

  <SettingsRow
    title="Scriptlet rules"
    description="Run the small page-side helpers that filter lists use for cookie banners and anti-adblock scripts. Off means only network and CSS rules apply."
  >
    <Switch
      label="Run scriptlet rules"
      labelHidden
      checked={view?.scriptlets === true}
      disabled={busy || view === null}
      onchange={(enabled) => setScriptlets(enabled)}
    />
  </SettingsRow>

  <SettingsRow
    title="Blocked in this profile"
    description={view?.stats?.today == null
      ? "Counts are unavailable in this build. Private windows are blocked but never counted."
      : `${view.stats.today} today · ${view.stats.last7Days ?? 0} in the last 7 days. Private windows are blocked but never counted.`}
  >
    <Button disabled={busy || view === null} onclick={() => void run(blocker.resetStats)}
      >Reset counts</Button
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
                  {#if entry.bundled}<span class="badge">bundled</span>{/if}
                  <span>{entry.license || "upstream list"}</span>
                  {#if entry.bytes}<span>{formatBytes(entry.bytes)}</span>{/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
    {#if view === null}
      <p class="empty">Reading the filter catalog…</p>
    {:else if view.lists.length === 0}
      <p class="empty">No filter lists are available in this build.</p>
    {/if}
  </div>
  {#if message}<p class="feedback" role="status">{message}</p>{/if}
</SettingsGroup>

<SettingsGroup
  title="Fingerprinting and tracking"
  description="Firefox's fingerprinting protection randomizes the signals pages use to identify a device. Astra's filter lists already block the trackers; this is the second layer."
>
  <SettingsRow
    title="Fingerprinting protection"
    description="Randomizes canvas and audio signals, hides the GPU model, tiers hardware concurrency, and limits font/display metrics. Low-breakage: the user agent and timezone are not spoofed."
  >
    <Switch
      label="Fingerprinting protection"
      labelHidden
      checked={preferences.value("privacy.fingerprinting") === "true"}
      disabled={preferences.saving()}
      onchange={(enabled) => void preferences.set("privacy.fingerprinting", String(enabled))}
    />
  </SettingsRow>
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
    background: var(--color-surface-raised);
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
    font-size: var(--text-small);
  }

  .badge {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--color-surface-raised);
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
</style>
