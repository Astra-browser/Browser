<script lang="ts">
  import {
    ArrowRight01Icon,
    MoreHorizontalIcon,
    PuzzleIcon,
    Upload01Icon,
  } from "@hugeicons/core-free-icons";
  import { commands, type WebExtensionView } from "$shared/ipc/bindings";
  import { surface as browserPage } from "$domain/surface";
  import { extensions } from "$domain/extensions";
  import { tabs } from "$domain/tabs";
  import { webext } from "$domain/webext";
  import * as m from "$shared/i18n/messages";
  import Button from "$shared/ui/Button";
  import Icon from "$shared/ui/Icon";
  import Menu, { type MenuEntry } from "$shared/ui/Menu";
  import Switch from "$shared/ui/Switch";
  import ExtensionActionIcon from "./ExtensionActionIcon.svelte";
  import { holdWhilePopupOpen } from "../lib/popup-hold";

  let profileId = $derived(tabs.profile()?.id ?? null);
  let tabId = $derived(tabs.activeId());
  let installed = $derived(webext.list());
  let actions = $derived(extensions.activeActions(profileId, tabId));
  let failure = $derived(webext.error());
  let removing = $state<string | null>(null);

  const actionFor = (extension: WebExtensionView) =>
    actions.find((action) => action.runtime.install_id === extension.install_id) ?? null;

  function use(event: MouseEvent, extension: WebExtensionView) {
    const action = actionFor(extension);
    const target = event.currentTarget;
    if (action === null || profileId === null || tabId === null) {
      if (extension.has_options && extension.enabled) void webext.openOptions(extension.id);
      return;
    }
    if (!action.enabled || !(target instanceof HTMLElement)) return;
    if (action.presents_popup) holdWhilePopupOpen();
    void extensions.invoke(profileId, tabId, action, target.getBoundingClientRect());
  }

  function entries(extension: WebExtensionView): MenuEntry[] {
    const action = actionFor(extension);
    const pinned = extension.pinned;
    const full = !pinned && webext.pinnedCount() >= webext.MAX_PINNED;
    return [
      ...(extension.has_options && extension.enabled
        ? [{ kind: "item" as const, id: "options", label: m.webext_options() }]
        : []),
      ...(action !== null && extension.enabled
        ? [
            {
              kind: "item" as const,
              id: "pin",
              label: pinned ? m.webext_unpin() : m.webext_pin(),
              disabled: full,
            },
          ]
        : []),
      { kind: "separator" as const },
      { kind: "item" as const, id: "remove", label: m.webext_remove(), danger: true },
    ];
  }

  function choose(id: string, extension: WebExtensionView) {
    if (id === "options") void webext.openOptions(extension.id);
    else if (id === "pin") void webext.setPinned(extension.id, !extension.pinned);
    else if (id === "remove") removing = extension.id;
  }

  function openChromeStore() {
    void commands.browserOpenUrl("https://chromewebstore.google.com/", true);
  }

  function openFirefoxStore() {
    void commands.browserOpenUrl("https://addons.mozilla.org/firefox/", true);
  }

  function status(extension: WebExtensionView): string {
    if (!extension.enabled) return m.webext_state_off();
    if (extension.state === "failed") return m.webext_state_failed();
    if (extension.state === "starting") return m.webext_state_starting();
    return actionFor(extension)?.enabled ? m.webext_ready_page() : m.webext_no_action_page();
  }
</script>

<!--
  The top bar's one extension door: every installed extension, what it can do
  on the page in front, and the controls to change that without leaving the
  window. The full page is one click away from the head, but this panel is the
  place to actually use one: a row with a live action invokes it, the switch
  turns the extension off, and the menu carries options, pinning and removal.
-->
<div class="hub" data-extension-hub>
  <header class="hub-head">
    <span class="hub-title">
      <Icon icon={PuzzleIcon} size={15} />
      <span>{m.webext_page_title()}</span>
      {#if installed.length > 0}<span class="count">{installed.length}</span>{/if}
    </span>
    <button
      type="button"
      class="manage"
      data-dismiss
      aria-label={m.webext_manage()}
      title={m.webext_manage()}
      onclick={() => void browserPage.open("extensions")}
    >
      <span>{m.webext_manage()}</span>
      <Icon icon={ArrowRight01Icon} size={13} />
    </button>
  </header>

  {#if failure !== null}
    <p class="failure" role="alert">{failure}</p>
  {/if}

  {#if installed.length === 0}
    <div class="empty">
      <span class="empty-glyph"><Icon icon={PuzzleIcon} size={22} /></span>
      <p class="empty-title">{m.webext_empty_title()}</p>
      <p class="empty-help">{m.webext_empty_help()}</p>
      <div class="empty-actions">
        <Button size="compact" variant="primary" onclick={() => void webext.chooseFile(false)}
          >{m.webext_install_file()}</Button
        >
        <Button size="compact" variant="secondary" data-dismiss onclick={() => openChromeStore()}
          >{m.webext_open_store()}</Button
        >
        <Button size="compact" variant="secondary" data-dismiss onclick={() => openFirefoxStore()}
          >{m.webext_open_firefox_store()}</Button
        >
      </div>
    </div>
  {:else}
    <ul class="list" aria-label={m.webext_installed()}>
      {#each installed as extension (extension.id)}
        {@const action = actionFor(extension)}
        {@const usable = action !== null && action.enabled}
        <li
          class="extension"
          data-web-extension={extension.id}
          data-tone={extension.enabled ? undefined : "off"}
        >
          <div class="line">
            <button
              type="button"
              class="use"
              data-dismiss={usable || (extension.has_options && extension.enabled) ? "" : undefined}
              disabled={!extension.enabled ||
                (action === null && !extension.has_options) ||
                extensions.isInvoking(extension.install_id)}
              title={usable ? extension.name : m.webext_no_action_page()}
              aria-label={usable ? extension.name : `${extension.name} — ${status(extension)}`}
              onclick={(event) => use(event, extension)}
            >
              <span class="glyph">
                {#if action}
                  <ExtensionActionIcon rgba={action.icon_rgba_base64} />
                  {#if action.badge.length > 0}
                    <span class="badge" data-unread={action.unread_badge}>{action.badge}</span>
                  {/if}
                {:else if extension.icon}
                  <img src={extension.icon} alt="" />
                {:else}
                  <Icon icon={PuzzleIcon} size={16} />
                {/if}
              </span>
              <span class="copy">
                <span class="name">{extension.name}</span>
                <span
                  class="status"
                  data-state={extension.state}
                  data-off={!extension.enabled || undefined}
                >
                  {status(extension)}
                </span>
              </span>
            </button>
            <Switch
              label={m.webext_turned_on({ name: extension.name })}
              labelHidden
              checked={extension.enabled}
              onchange={(on) => void webext.setEnabled(extension.id, on)}
            />
            <Menu
              label={m.webext_more({ name: extension.name })}
              entries={entries(extension)}
              triggerClass="more"
              align="end"
              onselect={(id) => choose(id, extension)}
            >
              {#snippet trigger()}<Icon icon={MoreHorizontalIcon} size={16} />{/snippet}
            </Menu>
          </div>
          {#if removing === extension.id}
            <div
              class="confirm"
              role="group"
              aria-label={m.webext_remove_confirm({ name: extension.name })}
            >
              <span>{m.webext_remove_confirm({ name: extension.name })}</span>
              <Button size="compact" variant="secondary" onclick={() => (removing = null)}
                >{m.webext_keep()}</Button
              >
              <Button
                size="compact"
                variant="danger"
                onclick={() => {
                  removing = null;
                  void webext.uninstall(extension.id);
                }}>{m.webext_remove()}</Button
              >
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if installed.length > 0}
    <footer class="hub-foot">
      <button
        type="button"
        class="foot-link"
        data-dismiss
        onclick={() => void webext.chooseFile(false)}
      >
        <Icon icon={Upload01Icon} size={13} />
        {m.webext_install_file()}
      </button>
      <button type="button" class="foot-link" data-dismiss onclick={() => openChromeStore()}>
        {m.webext_open_store()}
      </button>
      <button type="button" class="foot-link" data-dismiss onclick={() => openFirefoxStore()}>
        {m.webext_open_firefox_store()}
      </button>
    </footer>
  {/if}
</div>

<style>
  .hub {
    display: flex;
    flex-direction: column;
    min-inline-size: 0;
  }

  .hub-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-block-size: 30px;
    padding-inline: 8px 4px;
  }

  .hub-title {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--color-text);
    font-size: var(--text-body);
    font-weight: 500;
  }

  .count {
    display: grid;
    place-items: center;
    min-inline-size: 16px;
    block-size: 16px;
    padding-inline: 4px;
    border-radius: var(--radius-capsule);
    background: var(--color-fill);
    color: var(--color-faint);
    font-size: 10px;
    font-weight: 550;
  }

  .manage {
    display: flex;
    align-items: center;
    gap: 3px;
    min-inline-size: 0;
    padding: 4px 5px;
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: var(--color-faint);
    font: inherit;
    font-size: var(--text-label);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-instant) var(--ease-smooth),
      color var(--motion-instant) var(--ease-smooth);
  }

  .manage:hover,
  .manage:focus-visible {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .manage:focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: -2px;
  }

  .manage span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .failure {
    margin: 2px 8px 6px;
    font-size: var(--text-label);
    color: var(--color-danger);
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 2px 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
    overscroll-behavior: contain;
  }

  .extension + .extension {
    border-block-start: 1px solid var(--color-menu-separator);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-inline-size: 0;
    min-block-size: 40px;
    padding: 3px 2px 3px 4px;
  }

  .use {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 9px;
    min-inline-size: 0;
    min-block-size: 34px;
    padding: 2px 5px;
    border: 0;
    border-radius: var(--radius-inset);
    background: none;
    color: var(--color-text);
    font: inherit;
    text-align: start;
    cursor: default;
    outline: none;
    transition: background-color var(--motion-instant) var(--ease-smooth);
  }

  .use:focus-visible {
    background: var(--row-hover);
    outline: 2px solid var(--color-ring);
    outline-offset: -2px;
  }

  .use:disabled {
    cursor: default;
  }

  .use:hover:not(:disabled) {
    background: var(--row-hover);
  }

  .use:active:not(:disabled) {
    background: var(--row-pressed);
  }

  .glyph {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 22px;
    block-size: 22px;
    border-radius: var(--radius-control-compact);
    background: var(--color-fill);
    color: var(--color-muted);
  }

  .glyph img {
    inline-size: 18px;
    block-size: 18px;
    border-radius: 4px;
  }

  .glyph :global(canvas) {
    inline-size: 18px;
    block-size: 18px;
  }

  .badge {
    position: absolute;
    inset-block-start: -5px;
    inset-inline-end: -7px;
    max-inline-size: 28px;
    overflow: hidden;
    padding-inline: 3px;
    border-radius: var(--radius-capsule);
    background: var(--color-accent);
    box-shadow: 0 0 0 1.5px var(--color-menu);
    color: var(--color-on-accent);
    font-size: 9px;
    font-weight: 600;
    line-height: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }

  .badge[data-unread="true"] {
    background: var(--color-warning);
  }

  .copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    gap: 1px;
  }

  .name,
  .status {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .name {
    font-size: var(--text-body);
    font-weight: 450;
    line-height: 17px;
  }

  .status {
    color: var(--color-faint);
    font-size: 10.5px;
    line-height: 13px;
  }

  .status[data-state="failed"] {
    color: var(--color-danger);
  }

  .status[data-off] {
    color: var(--color-faint);
  }

  .extension[data-tone="off"] .name,
  .extension[data-tone="off"] .glyph {
    opacity: 0.55;
  }

  .line :global(.more) {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    border: 0;
    border-radius: var(--radius-inset);
    background: none;
    color: var(--color-faint);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-instant) var(--ease-smooth),
      color var(--motion-instant) var(--ease-smooth);
  }

  .line :global(.more:hover),
  .line :global(.more[data-state="open"]) {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .line :global(.more:focus-visible) {
    outline: 2px solid var(--color-ring);
    outline-offset: -2px;
  }

  .confirm {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding: 0 8px 8px;
    color: var(--color-muted);
    font-size: var(--text-label);
  }

  .confirm span {
    margin-inline-end: auto;
  }

  .empty {
    display: flex;
    align-items: center;
    flex-direction: column;
    gap: 7px;
    padding: 14px 18px 16px;
    text-align: center;
  }

  .empty-glyph {
    display: grid;
    place-items: center;
    inline-size: 40px;
    block-size: 40px;
    margin-block-end: 2px;
    border-radius: var(--radius-card);
    background: var(--color-fill);
    box-shadow: inset 0 0 0 1px var(--color-border);
    color: var(--color-faint);
  }

  .empty-title {
    margin: 0;
    color: var(--color-text);
    font-size: var(--text-body);
    font-weight: 550;
  }

  .empty-help {
    max-inline-size: 32ch;
    margin: 0 0 4px;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.5;
  }

  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px;
  }

  .hub-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    margin-block-start: 4px;
    padding: 4px 6px 1px;
    border-block-start: 1px solid var(--color-menu-separator);
  }

  .foot-link {
    display: flex;
    align-items: center;
    gap: 5px;
    min-inline-size: 0;
    padding: 3px 5px;
    border: 0;
    border-radius: var(--radius-inset);
    background: none;
    color: var(--color-faint);
    font: inherit;
    font-size: var(--text-label);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-instant) var(--ease-smooth),
      color var(--motion-instant) var(--ease-smooth);
  }

  .foot-link:hover,
  .foot-link:focus-visible {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .foot-link:focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: -2px;
  }
</style>
