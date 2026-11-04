<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import Button from "$shared/ui/Button";

  /**
   * Leaving a note that has text the host has not taken yet asks first: save
   * it, delete it, or stay where you are. A sheet rather than a browser
   * confirm, so it reads as part of the note and the keyboard can stay in it.
   */
  let {
    onsave,
    ondelete,
    oncancel,
  }: { onsave: () => void; ondelete: () => void; oncancel: () => void } = $props();

  let panel = $state<HTMLElement>();

  $effect(() => {
    panel?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  });

  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    }
  }
</script>

<div class="scrim" role="presentation">
  <div
    bind:this={panel}
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="note-leave-title"
    aria-describedby="note-leave-body"
    tabindex="-1"
    onkeydown={keydown}
  >
    <h2 id="note-leave-title">{m.note_leave_title()}</h2>
    <p id="note-leave-body">{m.note_leave_body()}</p>
    <div class="actions">
      <Button variant="ghost" size="compact" onclick={oncancel}>{m.note_leave_cancel()}</Button>
      <Button variant="danger" size="compact" onclick={ondelete}>
        {m.note_leave_discard()}
      </Button>
      <Button variant="primary" size="compact" onclick={onsave}>{m.note_leave_save()}</Button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--overlay-scrim);
    backdrop-filter: blur(2px);
  }

  .sheet {
    box-sizing: border-box;
    display: grid;
    gap: 10px;
    inline-size: min(380px, 100%);
    padding: var(--overlay-pad);
    border-radius: var(--overlay-radius);
    background: var(--overlay-ground);
    box-shadow: var(--overlay-shadow);
    outline: none;
  }

  @media (width <= 520px) {
    .scrim {
      padding: 16px;
    }

    .sheet {
      padding: 16px;
    }
  }

  h2 {
    margin: 0;
    color: var(--color-text);
    font-size: var(--text-body);
    font-weight: 600;
  }

  p {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--text-label);
    line-height: 1.45;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-block-start: 4px;
  }
</style>
