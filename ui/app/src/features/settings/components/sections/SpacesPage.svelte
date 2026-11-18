<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Dialog } from "bits-ui";
  import { Add01Icon, ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
  import type { SpaceView } from "$shared/ipc/bindings";
  import { commands } from "$shared/ipc/bindings";
  import { loadSpaceEditor } from "$features/tabs";
  import { profiles } from "$domain/profiles";
  import { surface } from "$domain/surface";
  import { tabs } from "$domain/tabs";
  import { pendingSpaceEditor, requestSpaceEditor } from "../../lib/space-editor-request.svelte";
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

  /** The same ten avatar hues the space editor offers. */
  const SPACE_COLOR_COUNT = 10;

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
  // profile left behind must not linger on another one. Loading the first
  // profile is not a switch, so it never closes a dialog the page opened.
  let knownProfile: string | null = null;
  $effect(() => {
    const next = current?.id ?? null;
    if (next === null || next === knownProfile) return;
    const switched = knownProfile !== null;
    knownProfile = next;
    if (!switched) return;
    editorOpen = false;
    editorSpace = null;
    busy = null;
    failed = null;
  });

  // A create request can outlive this page: the new space arrives with the
  // surface rebuilt. Open the editor as soon as the space is in the list.
  $effect(() => {
    const id = pendingSpaceEditor();
    if (id === null) return;
    const found = mine.find((space) => space.id === id);
    if (!found) return;
    requestSpaceEditor(null);
    edit(found, true);
  });

  async function create() {
    if (current === null) return;
    failed = null;
    const before = new Set(mine.map((space) => space.id));
    const owner = current.id;
    const result = await tabs.createSpace("", {
      icon: null,
      color: mine.length % SPACE_COLOR_COUNT,
      theme: null,
    });
    if (result.outcome !== "applied" && result.outcome !== "no_op") {
      failed = m.spaces_settings_new_failed();
      return;
    }
    // Creating a space brings its own New Tab to the front, which parks this
    // Settings page behind it. The person asked for a space from Settings, not
    // to leave Settings, so put the page back in front before the editor opens
    // on the space that was just made.
    await tick();
    surface.selectPage();
    // The list arrives with the host's change announcement, which can land a
    // turn after the admission: wait for the new row rather than reading once.
    let created: SpaceView | null = null;
    for (let attempt = 0; attempt < 40 && created === null; attempt++) {
      created =
        tabs.spaces().find((space) => space.profile_id === owner && !before.has(space.id)) ?? null;
      if (created === null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        await tick();
      }
    }
    if (created === null) {
      failed = m.spaces_settings_new_failed();
      return;
    }
    // The switch may rebuild this surface, so leave the request where the next
    // instance reads it as well as opening it here.
    requestSpaceEditor(created.id);
    edit(created, true);
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
    <p class="eyebrow">
      {current ? m.spaces_settings_current_profile({ name: current.name }) : m.section_spaces()}
    </p>
    <p class="lede">{m.spaces_settings_isolation_note()}</p>
  </div>

  <ul class="list" aria-label={m.section_spaces()}>
    {#each mine as space, index (space.id)}
      {@const here = space.id === active?.id}
      <li class="row" data-current={here || undefined}>
        <span class="mark" data-space-hue={space.color} aria-hidden="true">
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
    <h3 id="spaces-import-title">{m.spaces_settings_import_action()}</h3>
    <div class="card">
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
            onclick={() => void runImport()}>{m.spaces_settings_import_button()}</Button
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
    </div>
  </section>

  <section class="group" aria-labelledby="spaces-data-title">
    <h3 id="spaces-data-title">{m.spaces_settings_clear()}</h3>
    <div class="card">
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
    </div>
  </section>

  <section class="group" aria-labelledby="spaces-profiles-title">
    <h3 id="spaces-profiles-title">{m.spaces_settings_other_profiles()}</h3>
    <div class="card">
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
    </div>
  </section>
</section>

<Dialog.Root bind:open={editorOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="settings-dialog-overlay" />
    <Dialog.Content class="settings-dialog spaces-settings-sheet">
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
    gap: 30px;
  }

  .intro {
    display: grid;
    gap: 4px;
  }

  .eyebrow {
    margin: 0;
    color: var(--color-label-secondary);
    font-size: var(--text-label);
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .lede {
    max-inline-size: 580px;
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-body);
    line-height: 1.6;
  }

  .group {
    display: grid;
    gap: 0;
  }

  /* The same group heading the rest of Settings uses: 15/600 over a card,
     aligned to the row label rather than the card edge. */
  .group h3 {
    margin: 0 0 10px;
    padding-inline: 16px;
    color: var(--color-text);
    font-size: 15px;
    font-weight: 600;
    line-height: 20px;
    letter-spacing: -0.012em;
  }

  .card {
    display: grid;
    gap: 12px;
    padding: 14px 16px;
    border-radius: var(--radius-card);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
  }

  .card p {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.6;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 10px;
  }

  .list {
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

  .row {
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .profiles {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .profiles li {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 10px;
    min-block-size: 40px;
    padding: 4px 0;
  }

  .profiles li + li::before {
    position: absolute;
    top: 0;
    block-size: 1px;
    background: var(--color-border);
    content: "";
    inset-inline: 0;
  }

  .profiles span {
    font-size: var(--text-body);
    font-weight: 500;
  }

  .row + .row::before,
  .row + li > .add::before {
    position: absolute;
    top: 0;
    block-size: 1px;
    background: var(--color-border);
    content: "";
    inset-inline: 70px 0;
  }

  .mark {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 34px;
    block-size: 34px;
    border-radius: var(--radius-row);
    background: var(--space-hue);
    color: var(--space-ink);
    font-size: var(--text-body);
    font-weight: 600;
  }

  /* The same hue table the editor and the switcher use, so the mark a space
     wears here is the colour it shows when edited. */
  .mark[data-space-hue] {
    --space-hue: var(--color-faint);
    --space-ink: var(--color-label-secondary);
  }

  .mark[data-space-hue="1"] {
    --space-hue: var(--avatar-1-top);
    --space-ink: var(--avatar-1-bottom);
  }

  .mark[data-space-hue="2"] {
    --space-hue: var(--avatar-2-top);
    --space-ink: var(--avatar-2-bottom);
  }

  .mark[data-space-hue="3"] {
    --space-hue: var(--avatar-3-top);
    --space-ink: var(--avatar-3-bottom);
  }

  .mark[data-space-hue="4"] {
    --space-hue: var(--avatar-4-top);
    --space-ink: var(--avatar-4-bottom);
  }

  .mark[data-space-hue="5"] {
    --space-hue: var(--avatar-5-top);
    --space-ink: var(--avatar-5-bottom);
  }

  .mark[data-space-hue="6"] {
    --space-hue: var(--avatar-6-top);
    --space-ink: var(--avatar-6-bottom);
  }

  .mark[data-space-hue="7"] {
    --space-hue: var(--avatar-7-top);
    --space-ink: var(--avatar-7-bottom);
  }

  .mark[data-space-hue="8"] {
    --space-hue: var(--avatar-8-top);
    --space-ink: var(--avatar-8-bottom);
  }

  .mark[data-space-hue="9"] {
    --space-hue: var(--avatar-9-top);
    --space-ink: var(--avatar-9-bottom);
  }

  :global(:root[data-theme="dark"]) .mark[data-space-hue]:not([data-space-hue="0"]) {
    --space-ink: var(--space-hue);
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
    font-size: var(--text-body);
    font-weight: 550;
    line-height: 19px;
    letter-spacing: -0.006em;
  }

  small {
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
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
    font-size: var(--text-body);
    font-weight: 500;
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

  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.6;
  }

  .ok {
    color: var(--color-text) !important;
  }

  .failed {
    color: var(--color-danger) !important;
  }

  /* The dialog element is rendered by bits-ui, so the page's scoped hash is
     not on it; the class is unique to this sheet. The editor manages its own
     scrolling body, so the sheet only provides the frame. */
  :global(.settings-dialog.spaces-settings-sheet) {
    display: flex;
    flex-direction: column;
    inline-size: min(420px, calc(100vw - 32px));
    max-block-size: min(760px, calc(100vh - 32px));
    overflow: hidden;
    padding: 0;
  }
</style>
