<script lang="ts">
  import * as attention from "$session/attention.svelte";
  import * as m from "$shared/i18n/messages";
  import {
    Alert02Icon,
    ArrowDown01Icon,
    ArrowUp01Icon,
    Cancel01Icon,
    Search01Icon,
  } from "@hugeicons/core-free-icons";
  import { settle } from "$domain/operations";
  import { extensions } from "$domain/extensions";
  import { webext } from "$domain/webext";
  import { tabs } from "$domain/tabs";
  import { surface } from "$domain/surface";
  import { uiCommands as ui } from "$domain/ui-commands";
  import { commands, type SearchResult } from "$shared/ipc/bindings";
  import { events } from "$shared/ipc/native-events";
  import Icon from "$shared/ui/Icon";
  import Button from "$shared/ui/Button";
  import IconButton from "$shared/ui/IconButton";
  import CaptureControl from "$shared/ui/CaptureControl";
  import { preferences } from "$domain/preferences";
  import * as find from "../lib/find.svelte";
  import { flushSync, onMount, untrack, type Snippet } from "svelte";
  import { duration, easing, reducedMotion } from "$shared/lib/motion";
  import {
    addressSecurity,
    editingAddress,
    restingAddress,
    type SitePage,
  } from "../lib/address-model";

  let {
    compact = false,
    trailing,
  }: {
    compact?: boolean;
    /** Controls that act on the page, at the far end of the field. Told which
     *  page it is, or null where there is no site to describe. */
    trailing?: Snippet<[SitePage | null]>;
  } = $props();

  let input: HTMLInputElement;
  let findInput: HTMLInputElement | undefined = $state();
  /** An IME owns the find field's text until it commits it; searching what it
   *  is still composing highlights and scrolls the page for half a word. */
  let findComposing = false;
  let finding = $derived(find.isOpen());
  let findCount = $derived.by(() => {
    const matches = find.count();
    if (matches === null) return "";
    if (matches === 0) return m.find_none();
    const at = find.position();
    return at === null ? String(matches) : m.find_position({ at, of: matches });
  });

  // Whichever field is mounted takes focus when find asks for it, including
  // the one that appears when a compact sidebar opens for the search.
  $effect(() => {
    if (find.focusRequested() === 0 || !finding || !findInput) return;
    untrack(() => {
      findInput?.focus();
      findInput?.select();
    });
  });
  let form: HTMLFormElement;
  let editing = $state(false);
  let pending = $state(false);
  let failed = $state(false);
  // What hangs from the field (its tray) is as wide as the field.
  let fieldWidth = $state(0);
  let composing = false;
  let draft = $state("");
  let activeUrl = $derived(tabs.activeTab()?.url ?? "");
  let activeContent = $derived(tabs.activeTab()?.content ?? "web");
  // The page in front using the camera or microphone says so where its
  // address is, as well as on its tab.
  let activeCapture = $derived(tabs.activeTab()?.capture ?? null);
  // Only a store page actually in front, never one behind Settings or another
  // browser page, offers to install.
  let listedId = $derived(
    webext.isAvailable() && surface.currentPage() === null
      ? extensions.chromeStoreListingId(activeUrl)
      : null,
  );
  let listedInstalled = $derived(listedId === null ? null : webext.named(listedId));
  let removing = $state(false);
  $effect(() => {
    void listedId;
    removing = false;
  });
  $effect(() => {
    if (compact || listedInstalled === null || !webext.isRemovalAsked(listedInstalled.id)) return;
    removing = true;
    webext.settleRemovalAsk();
  });
  // Asked from the store's own page, the question waits in the field; a
  // hidden column comes out with it.
  $effect(() => {
    if (removing) return attention.hold();
  });
  $effect(() => {
    if (webext.error() !== null && webext.review() === null) attention.pulse(4000);
  });
  let placeholder = $derived(
    activeContent === "extension_owned"
      ? "Extension page — enter an address to open a new tab"
      : m.ui_enter_an_address(),
  );
  let zoom = $derived(tabs.activeTab()?.zoom ?? null);
  let standardZoom = $derived(Number(preferences.value("zoom.default")));
  let authoritativeValue = $derived(restingAddress(activeUrl));
  let value = $derived(editing ? draft : authoritativeValue);
  // A refusal describes the page that was asked for, so the ring goes when a
  // different page is in front; left alone it would mark a page that loaded
  // fine, or the next tab the user switched to, as the one that failed.
  $effect(() => {
    void activeUrl;
    failed = false;
  });
  let security = $derived(
    addressSecurity(activeUrl, tabs.activeTab()?.certificate_exception === true),
  );
  // A web page in front has a site to describe. A new tab, an internal page
  // and a page behind Settings have none.
  let sitePage = $derived<SitePage | null>(
    activeContent === "web" && security !== "none" && surface.currentPage() === null
      ? {
          url: activeUrl,
          security,
          warning:
            security === "untrusted"
              ? m.address_certificate_exception()
              : security === "insecure"
                ? m.address_insecure()
                : null,
          capture: activeCapture,
          privateWindow: tabs.profile()?.kind === "incognito",
          zoom,
          standardZoom,
        }
      : null,
  );

  /** ⌘L edits a page's address in the launcher, which has room for what a
   *  sidebar-wide field cannot show; a click edits it here. False where
   *  there is no page to edit and the field takes the typing. */
  function editInLauncher(): boolean {
    const tab = tabs.activeTab();
    if (!tab?.url || (tab.content ?? "web") !== "web") return false;
    // Work has no page in front, so there the launcher opens empty. A hand-off
    // the host refuses is not the field's to report: it stays where it is.
    if (surface.currentPage() === "work")
      void commands.runCommand("launcher.toggle").catch(() => {});
    else void commands.launcherEdit(tab.id, tab.url).catch(() => {});
    return true;
  }

  $effect(() => {
    const command = ui.uiCommand();
    if (command.seq === 0 || command.id !== "url.focus" || input === undefined) return;
    if (untrack(editInLauncher)) return;
    input.focus();
    input.select();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (composing || pending || !value.trim()) return;
    closeSuggestions();
    const id = tabs.activeId();
    const profile = tabs.profile()?.id;
    const opensNewTab = activeContent !== "web";
    const submitted = value;
    pending = true;
    failed = false;
    try {
      const result = await settle(
        id === null
          ? commands.browserOpenUrl(submitted, false)
          : commands.tabsNavigate(id, submitted),
      );
      if (tabs.profile()?.id !== profile) return;
      if (id !== null && tabs.activeId() !== id) {
        if (opensNewTab && result.outcome !== "failed" && result.outcome !== "rejected")
          input.blur();
        return;
      }
      if (result.outcome === "failed" || result.outcome === "rejected") failed = true;
      else if (value === submitted) input.blur();
    } catch {
      if (tabs.activeId() === id) failed = true;
    } finally {
      pending = false;
    }
  }

  function handleInput(event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    failed = false;
    draft = target.value;
    scheduleSuggestions(target.value);
  }

  // Online suggestions in the address field. The launcher's search is the one
  // host path that returns provider suggestions plus the action for the typed
  // words, so every search box in the product sends the same query to the
  // same engine. The setting (`search.suggestions`) is read by the host, so a
  // person who turns it off gets no request from here either.
  let suggestRows = $state.raw<SearchResult[]>([]);
  let suggestOpen = $state(false);
  let suggestIndex = $state(-1);
  let suggestToken = 0;
  let suggestQuery = "";
  let suggestTimer: ReturnType<typeof setTimeout> | undefined;
  const SUGGEST_LIMIT = 6;
  const SUGGEST_DEBOUNCE_MS = 80;

  function looksLikeAddress(text: string): boolean {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return true;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(\/|$)/i.test(text)) return true;
    return /^[^\s/]+\.[^\s/]+/.test(text) && !text.includes(" ");
  }

  function closeSuggestions() {
    if (suggestTimer !== undefined) clearTimeout(suggestTimer);
    suggestTimer = undefined;
    suggestToken += 1;
    suggestQuery = "";
    suggestRows = [];
    suggestOpen = false;
    suggestIndex = -1;
  }

  function scheduleSuggestions(text: string) {
    if (compact) return;
    const value = text.trim();
    if (value === "" || looksLikeAddress(value)) {
      closeSuggestions();
      return;
    }
    if (suggestTimer !== undefined) clearTimeout(suggestTimer);
    const token = ++suggestToken;
    suggestTimer = setTimeout(() => {
      suggestTimer = undefined;
      if (token !== suggestToken || !editing) return;
      suggestQuery = value;
      void commands.launcherSearch(value, `address-${token}`).catch(() => {});
    }, SUGGEST_DEBOUNCE_MS);
  }

  function moveSuggestion(step: number) {
    if (suggestRows.length === 0) return;
    const next = suggestIndex + step;
    if (next < 0) suggestIndex = -1;
    else if (next >= suggestRows.length) suggestIndex = suggestRows.length - 1;
    else suggestIndex = next;
  }

  function runSuggestion(row: SearchResult) {
    const context = {
      window_id: "win-1",
      session_id: "address",
      request_id: "",
      profile_id: "default",
      space_id: "space-1",
    };
    closeSuggestions();
    input?.blur();
    void settle(commands.launcherRun(row.action, context, false));
  }

  onMount(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void events.searchChanged
      .listen(({ payload }) => {
        if (disposed || !editing || payload.context !== null) return;
        if (payload.query.trim() !== suggestQuery) return;
        // The launcher's own list may also be open in this document; the host
        // emits one answer per query, so the rows are the same either way.
        suggestRows = payload.results.slice(0, SUGGEST_LIMIT);
        suggestOpen = suggestRows.length > 0;
        suggestIndex = -1;
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else stop = unsubscribe;
      });
    return () => {
      disposed = true;
      stop?.();
      closeSuggestions();
    };
  });

  function beginEditing() {
    // Keep the resting chrome quiet while preserving the complete location
    // when the user explicitly enters edit mode.
    const from = textStart();
    closeSuggestions();
    draft = editingAddress(activeUrl) || value;
    editing = true;
    flushSync();
    input.select();
    slide(from);
  }

  function endEditing() {
    const from = textStart();
    closeSuggestions();
    editing = false;
    flushSync();
    slide(from);
  }

  let ruler: CanvasRenderingContext2D | null = null;

  /** Where the text visibly begins inside the input, in its current shape. */
  function textStart(): number {
    const style = getComputedStyle(input);
    ruler ??= document.createElement("canvas").getContext("2d");
    if (!ruler) return 0;
    ruler.font = style.font;
    const text = input.value || input.placeholder;
    const width = ruler.measureText(text).width;
    const start = Number.parseFloat(style.paddingInlineStart) || 0;
    const end = Number.parseFloat(style.paddingInlineEnd) || 0;
    const room = input.clientWidth - start - end;
    return style.textAlign === "center" ? start + Math.max(0, (room - width) / 2) : start;
  }

  // Entering and leaving the field is one line of text moving between its
  // resting place, centred, and its working place at the start. The text is
  // swapped at the same moment — the host for the whole address — so it
  // travels half-lit and brightens as it lands. Transform only; the clip
  // around the input keeps it inside the field while it moves.
  function slide(from: number) {
    const offset = from - textStart();
    if (Math.abs(offset) < 1 || reducedMotion()) return;
    input.animate(
      [
        { transform: `translateX(${offset}px)`, opacity: 0.5 },
        { transform: "none", opacity: 1 },
      ],
      { duration: duration("slow"), easing: easing("emphasized") },
    );
  }

  // Editing ends wherever attention goes next: a press anywhere else in the
  // chrome, or the page itself taking focus away from the chrome entirely.
  $effect(() => {
    if (!editing) return;
    const press = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !form.contains(event.target)) input.blur();
    };
    const away = () => input.blur();
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("blur", away);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("blur", away);
    };
  });

  let pageRequest = $derived(tabs.activeTab()?.page_request ?? null);

  // What appears only on demand is fetched the first time it is wanted, not
  // at startup; a failed fetch is tried again at the next request.
  let RequestCard = $state.raw<typeof import("./PageRequestCard.svelte").default | null>(null);
  $effect(() => {
    if (pageRequest && RequestCard === null)
      void import("./PageRequestCard.svelte").then(
        (module) => (RequestCard = module.default),
        () => {},
      );
  });
</script>

<!--
  The input stays mounted in both shapes. Rust's synchronous presentation
  barrier commits and verifies the authoritative host through this exact
  element before revealing page content, so unmounting it at rail width would
  reject every presentation and leave page content permanently concealed. In
  compact mode it is present and correct but unpainted, and the launcher is the
  visible way to reach it.
-->
<form bind:this={form} class="relative shrink-0" onsubmit={submit} role="search">
  <!--
    A refused navigation rings the field, following the shared Field
    convention. The message is announced rather than drawn: a block of text
    appearing under the address bar would push the whole chrome down.
  -->
  <div
    class:sr-only={compact}
    class:flex={!compact}
    bind:clientWidth={fieldWidth}
    style:--address-width={fieldWidth ? `${fieldWidth}px` : undefined}
    class:shadow-[inset_0_0_0_1px_var(--color-danger)]={failed}
    class="address-field h-[34px] items-center gap-2 rounded-row bg-address ps-2.5 pe-1 shadow-[var(--shadow-tile)] transition-[background-color,box-shadow] duration-[var(--motion-fast)] ease-[var(--ease-out)] [--address-centering:20px] focus-within:bg-address-hover focus-within:shadow-[var(--shadow-field-focus)] hover:bg-address-hover"
  >
    {#if !compact && activeCapture && !editing}
      <CaptureControl
        site={activeUrl}
        capture={activeCapture}
        onOpen={(x, y) => {
          const id = tabs.activeId();
          if (id !== null) tabs.openMediaMenu(id, x, y);
        }}
      />
    {/if}

    <!--
      Resting, the text centres on the field rather than on the input. The
      trailing tray takes 26px and the field's own gutters differ by 6px, so
      the input's centre sits 10px left of the field's; padding twice that on
      the leading edge puts it back. Editing drops the padding and returns to
      the start, where a long URL has to begin.
    -->
    <span class="address-clip">
      <!-- Stays mounted and correct while find borrows the field: native
           verifies the page's address through it before showing the page.
           At rest a host too long to fit loses its start, not its end, so
           the site that owns it stays visible: right-to-left only clips. -->
      <input
        bind:this={input}
        class:sr-only={finding}
        tabindex={finding ? -1 : undefined}
        aria-hidden={finding || undefined}
        data-astra-address
        type="text"
        aria-label={m.ui_address_and_search()}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestOpen}
        aria-controls={suggestOpen ? "address-suggestions" : undefined}
        aria-activedescendant={suggestIndex >= 0 ? `address-suggestion-${suggestIndex}` : undefined}
        autocomplete="off"
        autocapitalize="off"
        enterkeyhint="go"
        {placeholder}
        spellcheck="false"
        {value}
        oninput={handleInput}
        oncompositionstart={() => (composing = true)}
        oncompositionend={() => (composing = false)}
        onkeydown={(event) => {
          if (event.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (suggestOpen) {
              closeSuggestions();
              return;
            }
            failed = false;
            input.blur();
            return;
          }
          if (suggestOpen && suggestRows.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveSuggestion(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              moveSuggestion(-1);
              return;
            }
            if (event.key === "Enter" && suggestIndex >= 0) {
              event.preventDefault();
              const row = suggestRows[suggestIndex];
              if (row) runSuggestion(row);
              return;
            }
          }
        }}
        aria-invalid={failed || undefined}
        aria-describedby={failed ? "address-error" : undefined}
        onfocus={beginEditing}
        onblur={endEditing}
        style:text-align={editing ? "start" : "center"}
        style:direction={editing ? null : "rtl"}
        style:padding-left={editing ? "0" : "var(--address-centering)"}
        class="min-w-0 flex-1 bg-transparent text-[13.5px] text-ellipsis text-label-secondary outline-none placeholder:text-faint focus:text-text"
      />
      {#if finding}
        <span class="find-glyph" aria-hidden="true"><Icon icon={Search01Icon} size={14} /></span>
        <input
          bind:this={findInput}
          type="search"
          class="find-input"
          aria-label={m.find_placeholder()}
          placeholder={m.find_placeholder()}
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          value={find.text()}
          oncompositionstart={() => (findComposing = true)}
          oncompositionend={(event) => {
            findComposing = false;
            find.setText(event.currentTarget.value);
          }}
          oninput={(event) => {
            if (!findComposing) find.setText(event.currentTarget.value);
          }}
          onkeydown={(event) => {
            if (event.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              find.step(!event.shiftKey, tabs.activeId());
            } else if (event.key === "Escape") {
              event.preventDefault();
              find.hide();
            }
          }}
        />
      {/if}
    </span>

    {#if finding}
      <span class="find-count" role="status" aria-live="polite">{findCount}</span>
      <IconButton
        icon={ArrowUp01Icon}
        label={m.find_previous()}
        size={14}
        buttonSize={24}
        disabled={!find.count()}
        onclick={() => find.step(false, tabs.activeId())}
      />
      <IconButton
        icon={ArrowDown01Icon}
        label={m.find_next()}
        size={14}
        buttonSize={24}
        disabled={!find.count()}
        onclick={() => find.step(true, tabs.activeId())}
      />
      <IconButton
        icon={Cancel01Icon}
        label={m.find_done()}
        size={14}
        buttonSize={24}
        onclick={() => find.hide()}
      />
    {:else if !compact}
      {#if trailing}{@render trailing(sitePage)}{/if}
    {/if}
  </div>
  {#if !compact && suggestOpen && suggestRows.length > 0}
    <div
      class="address-suggestions"
      id="address-suggestions"
      role="listbox"
      aria-label={m.ui_address_and_search()}
      data-astra-popup
    >
      {#each suggestRows as row, index (row.title)}
        <button
          type="button"
          id={`address-suggestion-${index}`}
          class="address-suggestion"
          class:is-active={index === suggestIndex}
          role="option"
          aria-selected={index === suggestIndex}
          onmousedown={(event) => event.preventDefault()}
          onpointerenter={() => (suggestIndex = index)}
          onclick={() => runSuggestion(row)}
        >
          <span class="address-suggestion-title">{row.title}</span>
          {#if row.detail}<span class="address-suggestion-detail">{row.detail}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
  {#if !compact && listedInstalled}
    {#if removing}
      <div
        class="store-remove"
        role="group"
        aria-label={m.webext_remove_confirm({ name: listedInstalled.name })}
      >
        <span>{m.webext_remove_confirm({ name: listedInstalled.name })}</span>
        <Button size="compact" variant="secondary" onclick={() => (removing = false)}
          >{m.webext_keep()}</Button
        >
        <Button
          size="compact"
          variant="danger"
          onclick={() => {
            removing = false;
            if (listedInstalled) void webext.uninstall(listedInstalled.id);
          }}>{m.webext_remove()}</Button
        >
      </div>
    {:else}
      <Button
        variant="secondary"
        size="compact"
        class="mt-2 w-full"
        onclick={() => (removing = true)}>{m.webext_store_remove()}</Button
      >
    {/if}
  {:else if !compact && listedId !== null}
    <p class="store-hint" role="note">{m.webext_store_chrome_hint()}</p>
    <Button
      variant="primary"
      size="compact"
      class="mt-2 w-full"
      pending={webext.isInstalling()}
      data-extension-store-install
      title="Install this extension in Astra"
      onclick={() => {
        // The listing is the tab whose URL produced this button. Asking the
        // selection again can be a frame behind it during a tab switch.
        const id = tabs.activeTab()?.id;
        if (id !== undefined) void webext.prepare(id);
      }}
    >
      {webext.isPreparing()
        ? "Preparing…"
        : webext.isInstalling()
          ? m.webext_store_installing()
          : m.webext_store_install()}
    </Button>
    {#if webext.error() !== null && webext.review() === null}
      <p class="mt-1 text-[11px] leading-4 text-danger" role="alert">{webext.error()}</p>
    {/if}
  {/if}
  {#if failed}<p id="address-error" role="alert" class="sr-only">{m.browser_nav_failed()}</p>{/if}
  {#if pageRequest && compact}
    <p class="popup-notice" role="status" title={m.page_request_waiting()}>
      <Icon icon={Alert02Icon} size={14} />
    </p>
  {:else if pageRequest && RequestCard}
    {#key `${tabs.activeId()}:${JSON.stringify(pageRequest)}`}
      <RequestCard tab={tabs.activeId()!} request={pageRequest} />
    {/key}
  {/if}
</form>

<style>
  .store-hint {
    margin: 8px 0 0;
    font-size: var(--text-caption);
    line-height: 1.4;
    color: var(--color-muted);
  }

  .store-remove {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-block-start: 8px;
    color: var(--color-label-secondary);
    font-size: 11px;
    line-height: 14px;
  }

  .store-remove > span {
    flex: 1;
    min-inline-size: 0;
  }

  .popup-notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 8px 0 0;
    color: var(--color-label-secondary);
    font-size: 11px;
  }

  .find-glyph {
    display: grid;
    place-items: center;
    flex: none;
    margin-inline-end: 6px;
    color: var(--color-faint);
  }

  .find-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--color-text);
    font: inherit;
    font-size: 13.5px;
    outline: none;
    user-select: text;
  }

  .find-input::placeholder {
    color: var(--color-faint);
  }

  .find-input::-webkit-search-cancel-button {
    display: none;
  }

  .find-count {
    flex: none;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--color-faint);
    white-space: nowrap;
  }

  /* The input's travel is clipped here rather than by the field, whose tray
     opens a panel below it that must not be cut off. */
  .address-clip {
    display: flex;
    flex: 1;
    min-width: 0;
    align-self: stretch;
    overflow: clip;
  }

  /* Engine suggestions hang from the address field like the site tray does.
     The shell raises the app frame while this is open (it is marked
     data-astra-popup), so it draws over the page instead of under it. */
  .address-suggestions {
    position: absolute;
    z-index: 80;
    inset-inline: 0;
    inset-block-start: calc(100% + 6px);
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-block-size: min(60vh, 420px);
    overflow-y: auto;
    padding: 4px;
    border-radius: var(--radius-row);
    background: var(--color-float);
    box-shadow: var(--shadow-menu);
  }

  .address-suggestion {
    display: flex;
    flex-direction: column;
    gap: 1px;
    inline-size: 100%;
    min-block-size: 32px;
    padding: 5px 10px;
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: var(--color-text);
    font: inherit;
    text-align: start;
    cursor: default;
  }

  .address-suggestion.is-active {
    background: var(--color-fill-hover);
  }

  .address-suggestion-title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-body);
  }

  .address-suggestion-detail {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--text-caption);
  }
</style>
