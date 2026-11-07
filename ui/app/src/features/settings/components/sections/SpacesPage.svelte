<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Dialog } from "bits-ui";
  import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
  import type { SpaceView } from "$shared/ipc/bindings";
  import { commands } from "$shared/ipc/bindings";
  import { loadSpaceEditor } from "$features/tabs";
  import { profiles } from "$domain/profiles";
  import { tabs } from "$domain/tabs";
  import * as m from "$shared/i18n/messages";
  import Button from "$shared/ui/Button";
  import Icon from "$shared/ui/Icon";
  import IconButton from "$shared/ui/IconButton";
  import Select from "$shared/ui/Select";

  onMount(() => {
    void profiles.retain();
    return () => profiles.release();
  });

  const current = $derived(profiles.current());
  const all = $derived(tabs.spaces());
  const mine = $derived(
    current === null ? [] : all.filter((space) => space.profile_id === current.id),
  );
  const others = $derived(profiles.others());
  const active = $derived(tabs.activeSpace());
  const scope = $derived(tabs.profile()?.id ?? "default");

  /** One hue per space, stable against its number. */
  const HUES = [
    "#6b7280",
    "#c2703a",
    "#3f7f6b",
    "#5b6fb0",
    "#9a5f9e",
    "#b68a2e",
    "#4f8faf",
    "#a3564f",
    "#6f8a3d",
    "#7a6bb0",
  ];
  const markColor = (color: number) => HUES[Math.abs(color) % HUES.length];

  let busy = $state<string | null>(null);
  let failed = $state<string | null>(null);

  // --- Full space settings -------------------------------------------------
  // The switcher's editor is the one place a space's name, icon, colour,
  // theme and deletion live; Settings embeds the same component rather than
  // growing a second, divergent copy.

  let editorOpen = $state(false);
  let editorFresh = $state(false);
  let editorSpace = $state<SpaceView | null>(null);

  function edit(space: SpaceView, fresh = false) {
    editorSpace = space;
    editorFresh = fresh;
    editorOpen = true;
    failed = null;
  }

  // A profile switch changes the list under the page; a dialog for the
  // profile left behind must not linger on another one.
  const shownProfile = $derived(current?.id ?? null);
  $effect(() => {
    void shownProfile;
    editorOpen = false;
    editorSpace = null;
    busy = null;
    failed = null;
  });

  async function create() {
    if (current === null) return;
    failed = null;
    const before = new Set(mine.map((space) => space.id));
    const result = await tabs.createSpace("", {
      icon: null,
      color: mine.length % HUES.length,
      theme: null,
    });
    if (result.outcome !== "applied" && result.outcome !== "no_op") {
      failed = m.spaces_settings_new_failed();
      return;
    }
    await tick();
    const created = tabs
      .spaces()
      .find((space) => space.profile_id === current.id && !before.has(space.id));
    if (created) edit(created, true);
  }

  async function switchTo(space: SpaceView) {
    if (space.id === active?.id) return;
    busy = space.id;
    await tabs.switchSpace(space.id);
    busy = null;
  }

  /** Move one row up or down; the host renumbers inside the profile. */
  async function move(space: SpaceView, step: -1 | 1) {
    const at = mine.findIndex((entry) => entry.id === space.id);
    if (at < 0) return;
    if (step < 0 && at === 0) return;
    if (step > 0 && at === mine.length - 1) return;
    // `before` is the row the space should sit in front of. Moving down one
    // means clearing the next row, so the anchor is the one after it.
    const before = step < 0 ? (mine[at - 1]?.id ?? null) : (mine[at + 2]?.id ?? null);
    busy = space.id;
    await tabs.reorderSpace(space.id, before);
    busy = null;
  }

  // --- Import bookmarks ----------------------------------------------------

  let importFrom = $state("");
  let importInto = $state("");
  let importing = $state(false);
  let importStatus = $state<"ok" | "truncated" | "failed" | null>(null);
  let importCount = $state(0);

  // The source and target always name spaces of this profile; a stale choice
  // (a deleted space) falls back to the first sensible one.
  $effect(() => {
    if (!mine.some((space) => space.id === importInto)) {
      importInto = active?.id ?? mine[0]?.id ?? "";
    }
    if (!mine.some((space) => space.id === importFrom) || importFrom === importInto) {
      importFrom = mine.find((space) => space.id !== importInto)?.id ?? "";
    }
  });

  const canImport = $derived(importFrom !== "" && importInto !== "" && importFrom !== importInto);

  async function runImport() {
    if (!canImport || importing) return;
    importing = true;
    importStatus = null;
    const response = await commands.bookmarkCall(scope, {
      kind: "import_space",
      from: importFrom,
      to: importInto,
    });
    importing = false;
    if (response.kind === "imported") {
      importCount = response.count;
      importStatus = response.truncated ? "truncated" : "ok";
    } else {
      importStatus = "failed";
    }
  }

  // --- Clear one space's site data ----------------------------------------

  let clearSpace = $state("");
  let clearing = $state(false);
  let clearStatus = $state<"ok" | "failed" | null>(null);

  $effect(() => {
    if (!mine.some((space) => space.id === clearSpace)) {
      clearSpace = active?.id ?? mine[0]?.id ?? "";
    }
  });

  async function clearData() {
    if (clearSpace === "" || clearing) return;
    clearing = true;
    clearStatus = null;
    const response = await commands.browsingDataCall(scope, {
      kind: "clear_space",
      space: clearSpace,
    });
    clearing = false;
    clearStatus = response.kind === "cleared" ? "ok" : "failed";
  }

  // --- Switch to another profile ------------------------------------------

  async function switchProfile(id: string) {
    busy = id;
    await profiles.switchTo(id);
    busy = null;
  }

  const spaceCount = (id: string) => all.filter((space) => space.profile_id === id).length;
  const clearOptions = $derived(mine.map((space) => ({ value: space.id, label: space.name })));
  const importOptions = $derived(
    mine
      .filter((space) => space.id !== importInto)
      .map((space) => ({ value: space.id, label: space.name })),
  );
</script>

<section class="spaces" aria-label={m.section_spaces()}>
  <div class="intro">
    <h2>
      {current ? m.spaces_settings_current_profile({ name: current.name }) : m.section_spaces()}
    </h2>
    <p>{m.spaces_settings_isolation_note()}</p>
  </div>

  <ul class="list">
    {#each mine as space, index (space.id)}
      {@const here = space.id === active?.id}
      <li class="row" data-current={here || undefined}>
        <span class="mark" style:background={markColor(space.color)} aria-hidden="true">
          {space.name.slice(0, 1).toUpperCase()}
        </span>
        <div class="copy">
          <strong>{space.name}</strong>
          <small>
            {space.tabs === 1
              ? m.spaces_settings_tabs_one()
              : m.spaces_settings_tabs_other({ count: space.tabs })}
            {#if here}· {m.spaces_settings_active()}{/if}
          </small>
        </div>
        <div class="actions">
          <div class="order">
            <IconButton
              icon={ArrowUp01Icon}
              label={m.spaces_settings_move_up({ name: space.name })}
              buttonSize={24}
              size={14}
              disabled={index === 0 || busy !== null}
              onclick={() => void move(space, -1)}
            />
            <IconButton
              icon={ArrowDown01Icon}
              label={m.spaces_settings_move_down({ name: space.name })}
              buttonSize={24}
              size={14}
              disabled={index === mine.length - 1 || busy !== null}
              onclick={() => void move(space, 1)}
            />
          </div>
          {#if !here}<Button
              size="compact"
              pending={busy === space.id}
              disabled={!!busy}
              aria-label={m.spaces_settings_switch_label({ name: space.name })}
              onclick={() => void switchTo(space)}>{m.spaces_settings_switch()}</Button
            >{/if}
          <Button
            size="compact"
            variant="ghost"
            disabled={!!busy}
            aria-label={m.spaces_settings_edit_label({ name: space.name })}
            onclick={() => edit(space)}>{m.spaces_settings_edit()}</Button
          >
        </div>
      </li>
    {/each}
    <li>
      <button type="button" class="add" onclick={() => void create()}>
        <span class="add-mark"><Icon icon={Add01Icon} size={16} strokeWidth={1.8} /></span>
        <span>{m.spaces_settings_new()}</span>
      </button>
    </li>
  </ul>

  <p class="note">{m.spaces_settings_manage_hint()}</p>
  {#if failed}<p class="failed" role="alert">{failed}</p>{/if}

  <section class="group" aria-labelledby="spaces-import-title">
    <h3 id="spaces-import-title">{m.spaces_settings_import()}</h3>
    <p>{m.spaces_settings_import_body()}</p>
    {#if mine.length < 2}
      <p class="note">{m.spaces_settings_import_none()}</p>
    {:else}
      <div class="controls">
        <Select
          label={m.spaces_settings_import_from()}
          options={importOptions}
          bind:value={importFrom}
        />
        <Select
          label={m.spaces_settings_import_into()}
          options={clearOptions}
          bind:value={importInto}
        />
        <Button
          variant="primary"
          pending={importing}
          disabled={!canImport || importing}
          onclick={() => void runImport()}>{m.spaces_settings_import_action()}</Button
        >
      </div>
      {#if importStatus === "ok"}<p class="ok" role="status">
          {m.spaces_settings_imported({ count: importCount })}
        </p>{:else if importStatus === "truncated"}<p class="ok" role="status">
          {m.spaces_settings_import_truncated({ count: importCount })}
        </p>{:else if importStatus === "failed"}<p class="failed" role="alert">
          {m.spaces_settings_import_failed()}
        </p>{/if}
    {/if}
  </section>

  <section class="group" aria-labelledby="spaces-data-title">
    <h3 id="spaces-data-title">{m.spaces_settings_clear()}</h3>
    <p>{m.spaces_settings_clear_body()}</p>
    <div class="controls">
      <Select label={m.section_spaces()} options={clearOptions} bind:value={clearSpace} />
      <Button
        variant="danger"
        pending={clearing}
        disabled={clearSpace === "" || clearing}
        onclick={() => void clearData()}>{m.spaces_settings_clear_action()}</Button
      >
    </div>
    {#if clearStatus === "ok"}<p class="ok" role="status">
        {m.spaces_settings_cleared()}
      </p>{:else if clearStatus === "failed"}<p class="failed" role="alert">
        {m.spaces_settings_clear_failed()}
      </p>{/if}
  </section>

  <section class="group" aria-labelledby="spaces-profiles-title">
    <h3 id="spaces-profiles-title">{m.spaces_settings_other_profiles()}</h3>
    <p>{m.spaces_settings_other_note()}</p>
    {#if others.length === 0}
      <p class="note">{m.spaces_settings_no_other()}</p>
    {:else}
      <ul class="profiles">
        {#each others as profile (profile.id)}
          <li>
            <span>{profile.name}</span>
            <small
              >{spaceCount(profile.id) === 1
                ? m.spaces_settings_space_count_one()
                : m.spaces_settings_space_count_other({ count: spaceCount(profile.id) })}</small
            >
            <Button
              size="compact"
              pending={busy === profile.id}
              disabled={!!busy}
              aria-label={m.profiles_switch_label({ name: profile.name })}
              onclick={() => void switchProfile(profile.id)}
              >{m.spaces_settings_switch_profile()}</Button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <p class="note">{m.spaces_settings_isolation()}</p>
</section>

<Dialog.Root bind:open={editorOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="settings-dialog-overlay" />
    <Dialog.Content class="settings-dialog-content space-sheet">
      <Dialog.Title class="sr-only"
        >{m.space_edit_label({ name: editorSpace?.name ?? "" })}</Dialog.Title
      >
      <Dialog.Description class="sr-only">{m.spaces_settings_isolation_note()}</Dialog.Description>
      {#if editorOpen && editorSpace}
        {#await loadSpaceEditor() then { default: SpaceEditor }}
          <SpaceEditor
            space={editorSpace}
            fresh={editorFresh}
            deletable={mine.length > 1}
            onclose={() => (editorOpen = false)}
          />
        {/await}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  .spaces {
    display: grid;
    gap: 28px;
  }

  .intro h2 {
    color: var(--color-text);
    font-size: var(--text-page-title);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .intro p,
  .group p,
  .note {
    margin-block-start: 6px;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.6;
  }

  .group {
    display: grid;
    gap: 10px;
  }

  .group h3 {
    color: var(--color-text);
    font-size: var(--text-page-title);
    font-weight: 500;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 10px;
  }

  .list,
  .profiles {
    overflow: hidden;
    margin: 0;
    padding: 0;
    border-radius: var(--radius-card);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    list-style: none;
  }

  .row,
  .add {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    box-sizing: border-box;
    min-block-size: 64px;
    padding: 10px 14px 10px 16px;
  }

  .profiles li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 10px;
    min-block-size: 52px;
    padding: 8px 14px 8px 16px;
  }

  li + li::before,
  .row + .row::before,
  .row + li > .add::before {
    position: absolute;
    top: 0;
    block-size: 1px;
    background: var(--color-border);
    content: "";
    inset-inline: 70px 0;
  }

  .profiles li + li::before {
    inset-inline: 16px 0;
  }

  .mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 34px;
    block-size: 34px;
    border-radius: var(--radius-row);
    color: white;
    font-size: 14px;
    font-weight: 600;
  }

  .copy {
    display: grid;
    flex: 1;
    gap: 2px;
    min-inline-size: 0;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    color: var(--color-text);
    font-size: var(--text-page-title);
    font-weight: 500;
    line-height: 19px;
    letter-spacing: -0.008em;
  }

  small {
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
  }

  .order {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-inline-end: 2px;
  }

  .add {
    inline-size: 100%;
    min-block-size: 56px;
    border: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: var(--text-page-title);
    text-align: start;
    transition: background-color var(--motion-fast) var(--ease-out);
  }

  .add:hover {
    background: var(--row-hover);
  }

  .add:focus-visible {
    outline-offset: -2px;
  }

  .add-mark {
    display: grid;
    flex: none;
    inline-size: 34px;
    block-size: 28px;
    color: var(--color-label-secondary);
  }

  .ok {
    color: var(--color-text) !important;
  }

  .failed {
    color: var(--color-danger) !important;
  }

  /* The dialog element is rendered by bits-ui, so the page's scoped hash is
     not on it; the class is unique to this sheet. */
  :global(.space-sheet) {
    inline-size: min(420px, calc(100vw - 32px));
    max-block-size: min(720px, calc(100vh - 48px));
    overflow: hidden;
    padding: 0;
    border-radius: var(--radius-card);
    background: var(--color-surface);
  }
</style>
