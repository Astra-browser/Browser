<script lang="ts">
  import {
    ArrowUpRight01Icon,
    MoreHorizontalIcon,
    PinIcon,
    PinOffIcon,
    PuzzleIcon,
  } from "@hugeicons/core-free-icons";
  import type { ExtensionActionView, WebExtensionView } from "$shared/ipc/bindings";
  import { IS_WINDOWS } from "$shared/platform";
  import { extensions } from "$domain/extensions";
  import { webext } from "$domain/webext";
  import Button from "$shared/ui/Button";
  import Icon from "$shared/ui/Icon";
  import Menu, { type MenuEntry } from "$shared/ui/Menu";
  import Switch from "$shared/ui/Switch";
  import * as m from "$shared/i18n/messages";
  import SiteAccessEditor from "./SiteAccessEditor.svelte";
  import { holdWhilePopupOpen } from "$session/attention.svelte";

  let {
    extension,
    action = null,
    profileId = null,
    tabId = null,
  }: {
    extension: WebExtensionView;
    action?: ExtensionActionView | null;
    profileId?: string | null;
    tabId?: string | null;
  } = $props();
  let removing = $state(false);
  let editingSites = $state(false);
  let sourceLabel = $derived(
    extension.source === "chrome"
      ? m.webext_source_chrome()
      : extension.source === "firefox"
        ? m.webext_source_firefox()
        : null,
  );
  let securityNotice = $derived(
    extension.security_level === "medium" ||
      extension.security_level === "high" ||
      extension.security_level === "critical" ||
      extension.security_level === "blocked"
      ? m.webext_security_notice()
      : null,
  );

  let access = $derived(
    extension.access === "click"
      ? m.webext_access_click_short()
      : extension.access === "sites"
        ? extension.sites.length === 1
          ? m.webext_access_one_site()
          : m.webext_access_sites_short({ count: extension.sites.length })
        : m.webext_access_all_short(),
  );

  let entries = $derived<MenuEntry[]>([
    ...(action !== null
      ? [{ kind: "item" as const, id: "open", label: m.webext_open_extension() }]
      : []),
    ...(extension.has_options && extension.enabled
      ? [{ kind: "item" as const, id: "options", label: m.webext_extension_settings() }]
      : []),
    ...(action !== null
      ? [
          {
            kind: "item" as const,
            id: "pin",
            label: extension.pinned ? m.webext_unpin() : m.webext_pin(),
          },
        ]
      : []),
    ...(extension.site_scoped
      ? [
          { kind: "heading" as const, label: m.webext_site_access() },
          {
            kind: "item" as const,
            id: "all",
            label: m.webext_access_all(),
            checked: extension.access === "all",
          },
          ...(!IS_WINDOWS
            ? [
                {
                  kind: "item" as const,
                  id: "click",
                  label: m.webext_access_click(),
                  checked: extension.access === "click",
                },
              ]
            : []),
          {
            kind: "item" as const,
            id: "sites",
            label: m.webext_access_sites(),
            checked: extension.access === "sites",
          },
          { kind: "separator" as const },
        ]
      : []),
    { kind: "item", id: "remove", label: m.webext_remove(), danger: true },
  ]);

  function select(id: string) {
    if (id === "open") openExtension();
    else if (id === "pin") void webext.setPinned(extension.id, !extension.pinned);
    else if (id === "options") void webext.openOptions(extension.id);
    else if (id === "all" || id === "click") void webext.setAccess(extension.id, id);
    else if (id === "sites") editingSites = true;
    else if (id === "remove") removing = true;
  }

  function openExtension(event?: MouseEvent) {
    if (action !== null && profileId !== null && tabId !== null && action.enabled) {
      if (action.presents_popup) holdWhilePopupOpen();
      const target = event?.currentTarget;
      const anchor = target instanceof HTMLElement ? target.getBoundingClientRect() : undefined;
      void extensions.invoke(
        profileId,
        tabId,
        action,
        anchor ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0),
      );
    } else if (extension.has_options && extension.enabled) {
      void webext.openOptions(extension.id);
    }
  }
</script>

<li class="extension" data-web-extension={extension.id}>
  <div class="line" class:off={!extension.enabled}>
    <span class="icon" aria-hidden="true">
      {#if extension.icon}
        <img src={extension.icon} alt="" />
      {:else}
        <Icon icon={PuzzleIcon} size={16} />
      {/if}
    </span>
    <span class="text">
      <span class="name">{extension.name}</span>
      {#if extension.state === "failed"}
        <span class="status-line" data-tone="danger">
          <span class="status"
            >{m.webext_state_failed()}{#if extension.error}: {extension.error}{/if}</span
          >
          <button type="button" class="inline" onclick={() => void webext.retry(extension)}
            >{m.webext_retry()}</button
          >
        </span>
      {:else if extension.held_update}
        <span class="status-line" data-tone="warning">
          <span class="status">{m.webext_state_update({ version: extension.held_update })}</span>
          <button
            type="button"
            class="inline"
            onclick={() => void webext.reviewUpdate(extension.id)}>{m.webext_review()}</button
          >
        </span>
      {:else if extension.state === "starting"}
        <span class="status">{m.webext_state_starting()}</span>
      {:else if !extension.enabled}
        <span class="status">{m.webext_state_off()}</span>
      {:else}
        <span class="status"
          >{m.webext_state_version({ version: extension.version })}{#if sourceLabel}
            · {sourceLabel}{/if}{#if extension.sideloaded}
            · {m.webext_state_file()}{/if}{#if extension.limitations.length > 0}
            ·
            <span class="limits" title={extension.limitations.join("\n")}
              >{m.webext_limits_short()}</span
            >{/if}{#if securityNotice}
            ·
            <span class="limits" title={securityNotice}>{m.webext_security_mark()}</span>{/if}</span
        >
      {/if}
    </span>
    {#if extension.site_scoped && extension.enabled}
      <span class="access">{access}</span>
    {/if}
    {#if action !== null || (extension.has_options && extension.enabled)}
      <button
        type="button"
        class="row-action"
        data-row-action={action !== null ? "extension" : "settings"}
        title={action !== null ? m.webext_open_extension() : m.webext_extension_settings()}
        aria-label={action !== null ? m.webext_open_extension() : m.webext_extension_settings()}
        onclick={(event) => openExtension(event)}
      >
        <Icon icon={action !== null ? ArrowUpRight01Icon : PuzzleIcon} size={15} />
      </button>
    {/if}
    {#if action !== null}
      <button
        type="button"
        class="row-action pin-action"
        aria-pressed={extension.pinned}
        title={extension.pinned ? m.webext_unpin() : m.webext_pin()}
        aria-label={extension.pinned ? m.webext_unpin() : m.webext_pin()}
        onclick={() => void webext.setPinned(extension.id, !extension.pinned)}
      >
        <Icon icon={extension.pinned ? PinOffIcon : PinIcon} size={14} />
      </button>
    {/if}
    <Switch
      label={m.webext_turned_on({ name: extension.name })}
      labelHidden
      checked={extension.enabled}
      onchange={(on) => void webext.setEnabled(extension.id, on)}
    />
    <Menu
      label={m.webext_more({ name: extension.name })}
      {entries}
      triggerClass="more"
      align="end"
      onselect={select}
    >
      {#snippet trigger()}<Icon icon={MoreHorizontalIcon} size={16} />{/snippet}
    </Menu>
  </div>

  {#if removing}
    <div
      class="confirm"
      role="group"
      aria-label={m.webext_remove_confirm({ name: extension.name })}
    >
      <span>{m.webext_remove_confirm({ name: extension.name })}</span>
      <Button size="compact" variant="secondary" onclick={() => (removing = false)}
        >{m.webext_keep()}</Button
      >
      <Button
        size="compact"
        variant="danger"
        onclick={() => {
          removing = false;
          void webext.uninstall(extension.id);
        }}>{m.webext_remove()}</Button
      >
    </div>
  {/if}

  {#if editingSites}
    <SiteAccessEditor {extension} onclose={() => (editingSites = false)} />
  {/if}
</li>

<style>
  .extension:not(:first-child) {
    border-block-start: 1px solid var(--color-border);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 10px 14px;
  }

  .icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    overflow: hidden;
    border-radius: var(--radius-control-compact);
    background: var(--color-fill);
    color: var(--color-muted);
  }

  .icon img {
    width: 22px;
    height: 22px;
  }

  .off .icon {
    opacity: 0.55;
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    font-size: var(--text-body);
    font-weight: 500;
    line-height: 18px;
    color: var(--color-text);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .off .name {
    color: var(--color-muted);
  }

  .status {
    overflow: hidden;
    font-size: var(--text-caption);
    line-height: 15px;
    color: var(--color-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .limits {
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }

  .row-action {
    display: grid;
    flex: none;
    place-items: center;
    inline-size: 28px;
    block-size: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-inset);
    background: none;
    color: var(--color-faint);
    cursor: default;
    outline: none;
  }

  .row-action:hover,
  .row-action:focus-visible {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .pin-action[aria-pressed="true"] {
    color: var(--color-text);
  }

  /* The action stays whole beside its message, however long the message. */
  .status-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .status-line[data-tone="danger"] .status {
    color: var(--color-danger);
  }

  .status-line[data-tone="warning"] .status {
    color: var(--color-warning);
  }

  .inline {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--text-caption);
    font-weight: 500;
    color: var(--color-text);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .access {
    flex: none;
    font-size: var(--text-caption);
    color: var(--color-faint);
  }

  .line :global(.more) {
    display: grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--radius-control-compact);
    background: none;
    color: var(--color-muted);
    transition: background-color var(--motion-instant) var(--ease-smooth);
  }

  .line :global(.more:hover),
  .line :global(.more[data-state="open"]) {
    background: var(--row-active);
    color: var(--color-text);
  }

  .confirm {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding: 0 14px 12px;
    font-size: var(--text-caption);
    color: var(--color-muted);
  }

  .confirm span {
    margin-inline-end: 4px;
  }
</style>
