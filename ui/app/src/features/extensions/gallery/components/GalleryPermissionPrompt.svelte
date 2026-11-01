<script lang="ts">
  // Permission prompt UI (P4-T04). Renders a Host API Dialogs
  // `permission.requested` event for the user to answer. Read-only usage of
  // the Dialogs module: answering only calls `onanswer` with the grant/deny
  // choice, and the caller forwards it through `Dialogs.decidePermission`.
  // This component never resolves a dialog itself.

  let {
    dialogId,
    extensionName,
    permission,
    url,
    onanswer,
  }: {
    dialogId: string;
    extensionName: string;
    permission: string;
    url: string;
    onanswer: (dialogId: string, grant: boolean) => void;
  } = $props();
</script>

<section class="prompt" role="alert" aria-label={`${extensionName} requests ${permission}`}>
  <p class="title">{extensionName} is asking for permission</p>
  <p class="facts">
    <span class="permission">{permission}</span>
    <span class="url">{url}</span>
  </p>
  <div class="actions">
    <button type="button" class="deny" onclick={() => onanswer(dialogId, false)}>Deny</button>
    <button type="button" class="grant" onclick={() => onanswer(dialogId, true)}>Allow</button>
  </div>
</section>

<style>
  .prompt {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-panel);
    background: var(--color-raised);
  }

  .title {
    margin: 0;
    font-size: var(--text-body);
    color: var(--color-text);
  }

  .facts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    font-size: var(--text-label);
    color: var(--color-muted);
  }

  .url {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  .deny,
  .grant {
    height: 28px;
    padding-inline: 12px;
    border: 0;
    border-radius: var(--radius-control-compact);
    font: inherit;
    font-size: var(--text-label);
    cursor: pointer;
  }

  .deny {
    background: none;
    color: var(--color-muted);
  }

  .grant {
    background: var(--row-active);
    color: var(--color-text);
  }
</style>
