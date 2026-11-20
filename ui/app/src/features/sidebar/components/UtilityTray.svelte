<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { Alert02Icon, Settings05Icon } from "@hugeicons/core-free-icons";
  import Icon from "$shared/ui/Icon";
  import Disclosure from "$shared/ui/Disclosure";

  let {
    label,
    warning = null,
    children,
    onopen,
    onclose,
  }: {
    label: string;
    /** What is wrong with the page in front. The glyph then stays in view as
     *  a warning instead of waiting for the pointer. */
    warning?: string | null;
    /** Told whether the panel is showing. */
    children: Snippet<[boolean]>;
    onopen?: () => void;
    onclose?: () => void;
  } = $props();

  let open = $state(false);
  let body = $state<HTMLElement>();

  /*
    The glyph is painted only while the column is in use, and a control that is
    painted away must not be a tab stop: a keyboard walk used to land on a 26px
    button at `opacity: 0` sitting over the address pill, with no ring and no
    name to announce. It is focusable and announced exactly while it is
    revealed, and the reveal is read from the same facts the stylesheet uses —
    the pointer in the column, the field's focus, the peek card, a warning, its
    own open panel — so the pointer behaviour is unchanged.
  */
  let root = $state<HTMLElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let pointerIn = $state(false);
  let peeked = $state(false);
  let fieldFocused = $state(false);
  const revealed = $derived(open || warning !== null || pointerIn || peeked || fieldFocused);

  $effect(() => {
    const disclosure = body?.closest<HTMLElement>(".ui-disclosure") ?? null;
    if (!disclosure) return;
    root = disclosure;
    trigger = disclosure.querySelector<HTMLButtonElement>(".utilities-trigger");
  });

  // The column says whether the pointer is in it (`data-pointer-in`) and
  // whether it is out as its peek card (`data-peek`); both are the app's own
  // state, read rather than copied.
  $effect(() => {
    const column = root?.closest<HTMLElement>(".browser-sidebar") ?? null;
    if (!column) return;
    const read = () => {
      pointerIn = column.dataset.pointerIn === "true";
      peeked = column.hasAttribute("data-peek");
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(column, {
      attributes: true,
      attributeFilter: ["data-pointer-in", "data-peek"],
    });
    return () => observer.disconnect();
  });

  // `.address-field:focus-within` paints it in; the same fact decides whether
  // it can be reached, so the two never disagree.
  $effect(() => {
    const field = root?.closest<HTMLElement>(".address-field") ?? null;
    if (!field) return;
    let live = true;
    const read = () => {
      if (!live) return;
      const active = document.activeElement;
      const next = active !== null && field.contains(active);
      if (next === untrack(() => fieldFocused)) return;
      // A focus event also fires while Svelte is taking a branch down (the
      // element that had focus is being removed), and state may not change in
      // that turn: the read lands on the next microtask, once it has settled.
      queueMicrotask(() => {
        if (live) fieldFocused = next;
      });
    };
    read();
    document.addEventListener("focusin", read);
    document.addEventListener("focusout", read);
    return () => {
      live = false;
      document.removeEventListener("focusin", read);
      document.removeEventListener("focusout", read);
    };
  });

  $effect(() => {
    const button = trigger;
    if (!button) return;
    if (revealed) {
      button.removeAttribute("aria-hidden");
      button.tabIndex = 0;
      return;
    }
    // Never take the name off the element the keyboard is standing on.
    if (document.activeElement === button) {
      button.removeAttribute("aria-hidden");
      button.tabIndex = 0;
      return;
    }
    button.tabIndex = -1;
    button.setAttribute("aria-hidden", "true");
  });

  // The panel takes the keyboard when it opens, so Escape closes it from
  // wherever it was opened, and after a control in it goes.
  function opened() {
    open = true;
    onopen?.();
    void tick().then(() => body?.focus({ preventScroll: true }));
  }

  function closed() {
    open = false;
    onclose?.();
  }
</script>

<!--
  Everything about the page in front and everything that acts on it, in one
  panel: who it is from, blocking, extensions, what the site may use. One glyph
  holds them, because none of them is worth a permanent seat in the chrome. Each
  section is a direct child of the body, or absent, and the body rules the
  hairline between whichever are showing, except between two that belong
  together (data-tray-tools).
-->
<Disclosure
  {label}
  triggerTitle={warning ?? undefined}
  triggerClass={warning ? "utilities-trigger utilities-warning" : "utilities-trigger"}
  panelClass="utilities-panel sidebar-softens"
  align="end"
  onopen={opened}
  onclose={closed}
>
  {#snippet trigger()}<Icon icon={warning ? Alert02Icon : Settings05Icon} size={15} />{/snippet}
  <div class="tray-body" data-tray-body tabindex="-1" bind:this={body}>
    {@render children(open)}
  </div>
</Disclosure>

<style>
  /*
    Present but unpainted until the column is in use. It acts on the page the
    field names, so it has no business drawing the eye the rest of the time;
    the pointer resting in the column brings it in after a beat, and focusing
    the field or opening its own panel brings it at once. A page that is not
    secure is the exception: that is not something to wait for the pointer to
    learn.
  */
  :global(.browser-sidebar[data-pointer-in="true"]) :global(.utilities-trigger) {
    opacity: 1;
    transition-delay: 120ms, 0ms, 0ms;
  }

  /* Over the field, with its panel or its keyboard, and on the card that
     only comes out when wanted, there is nothing to wait for. */
  :global(.utilities-trigger[data-state="open"]),
  :global(.browser-sidebar[data-pointer-in="true"] .address-field:hover)
    :global(.utilities-trigger),
  :global(.browser-sidebar[data-peek]) :global(.utilities-trigger),
  :global(.address-field:focus-within) :global(.utilities-trigger) {
    opacity: 1;
    transition-delay: 0ms;
  }

  :global(.utilities-trigger) {
    opacity: 0;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: var(--color-faint);
    cursor: default;
    outline: none;
    transition:
      opacity var(--motion-slow) var(--ease-smooth),
      background-color var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out);
  }

  :global(.utilities-trigger.utilities-warning) {
    opacity: 1;
    color: var(--color-danger);
  }

  :global(.utilities-trigger:hover),
  :global(.utilities-trigger[data-state="open"]) {
    background: var(--row-hover);
    color: var(--color-text);
  }

  :global(.utilities-trigger.utilities-warning:hover),
  :global(.utilities-trigger.utilities-warning[data-state="open"]) {
    color: var(--color-danger);
  }

  /* The keyboard is never on an invisible control: the field's focus has
     already painted it in (`.address-field:focus-within`), and this keeps the
     same promise where the tray is mounted outside a field, with the ring the
     other stops get. */
  :global(.utilities-trigger:focus-visible) {
    opacity: 1;
    box-shadow: var(--shadow-field-focus);
  }

  /* Under the field, as wide as it and from its edge: the trigger sits a
     field-padding in. The rows need the room: a name, its count and a switch
     on one line. */
  :global(.utilities-panel.ui-disclosure-panel) {
    inset-inline-end: -4px;
    inline-size: var(
      --address-width,
      min(304px, var(--sidebar-live-width, var(--sidebar-width, 320px)))
    );
    max-width: calc(var(--sidebar-live-width, var(--sidebar-width, 320px)) - 8px);
    max-block-size: calc(100vh - 120px);
    padding: var(--menu-pad);
    overflow-y: auto;

    /* It floats over the page, not over the desktop: solid, so the page's own
       text never reads through the tray's labels. */
    background: var(--color-float);
    backdrop-filter: none;
  }

  .tray-body {
    display: flex;
    flex-direction: column;
    outline: none;
  }

  .tray-body > :global(* + *) {
    margin-block-start: 4px;
    padding-block-start: 4px;
    border-block-start: 1px solid var(--color-menu-separator);
  }

  .tray-body > :global([data-tray-tools] + [data-tray-tools]) {
    margin-block-start: 0;
    padding-block-start: 0;
    border-block-start: 0;
  }
</style>
