// P0-T07 golden invoke router: deterministic answers for every native call
// the golden screens reach. Lives below the generated bindings (which wrap
// raw results in envelopes themselves), so handlers return raw payloads.
//
// Screens register their stateful servers (tasks/notes/time/search) through
// `installHandlers`; everything else is answered from the static fixtures
// below. Any command without a handler is reported on the console — the
// capture script fails the run when `[golden] unmocked` appears, so a
// missing fixture can never silently produce an empty screen.

export type InvokeHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

import { resourceCallHandler } from "../servers";

const handlers = new Map<string, InvokeHandler>();
const unmocked = new Set<string>();

export function installHandlers(entries: Record<string, InvokeHandler>): void {
  for (const [command, handler] of Object.entries(entries)) handlers.set(command, handler);
}

export function unmockedCommands(): string[] {
  return [...unmocked];
}

/** Settings the golden pages read. Theme/appearance is applied per screen. */
export const settings: Record<string, string> = {
  appearance: "light",
  "ui.theme": "astra",
  "ui.material": "none",
  "ui.newtab-clock-format": "12h",
  "focus.goal": "240",
};

const ok = { accepted: true, operation_id: null };

const KEYMAP: Array<{
  id: string;
  title: string;
  group: string;
  accelerator: string;
  default_accelerator: string;
  customizable: boolean;
  customized: boolean;
}> = [
  ["tool.notes", "Cmd+Shift+E"],
  ["tool.tasks", "Cmd+Shift+K"],
  ["tool.time", "Cmd+Shift+U"],
  ["tool.history", "Cmd+Y"],
  ["tool.downloads", "Cmd+Shift+J"],
  ["tool.bookmarks", "Cmd+Shift+B"],
  ["browser.settings", "Cmd+,"],
  ["space.select.1", "Ctrl+1"],
  ["space.select.2", "Ctrl+2"],
  ["space.select.3", "Ctrl+3"],
].map(([id, accelerator]) => ({
  id: id!,
  title: id!,
  group: "window",
  accelerator: accelerator!,
  default_accelerator: accelerator!,
  customizable: true,
  customized: false,
}));

installHandlers({
  setting_get: ({ key }) => settings[key as string] ?? null,
  setting_set: ({ key, value }) => {
    settings[key as string] = value as string;
    return ok;
  },
  tabs_bootstrap: () => {},
  resource_call: resourceCallHandler as InvokeHandler,
  ui_info: () => ({ material: "none" }),
  ui_ready: () => true,
  page_permission_card_host: () => {},
  sidebar_set_hidden: () => {},
  sidebar_peek: () => {},
  sidebar_set_width: () => {},
  sidebar_resize: () => false,
  sidebar_resize_guide: () => true,
  tab_drag_over: () => {},
  tab_drop: () => ok,
  spaces_create: () => ok,
  spaces_update: () => ok,
  spaces_switch: () => ok,
  spaces_step: () => ok,
  spaces_reorder: () => ok,
  spaces_move_tab: () => ok,
  spaces_delete: () => ok,
  tabs_activate: () => ok,
  tabs_close: () => ok,
  tabs_reload: () => ok,
  tabs_navigate: () => ok,
  tabs_open: () => ok,
  tabs_split: () => ok,
  tabs_unsplit: () => ok,
  tabs_back: () => ok,
  tabs_forward: () => ok,
  tab_set_muted: () => ok,
  tab_menu_popup: () => {},
  chrome_menu_popup: () => {},
  profile_rename: () => ok,
  essentials_keep: () => ok,
  essentials_release: () => ok,
  run_command: () => ok,
  browser_open_url: () => ok,
  resource_close_ready: () => true,
  swipe_region: () => true,
  download_call: () => ({
    kind: "updates",
    entries: [],
    removed: [],
    cleanup: { running: false, error: null },
  }),
  account_get: () => ({
    account: {
      version: 1,
      available: true,
      server: "https://accounts.example",
      custom_server: false,
      hosted_models: null,
      billing: null,
      signup_open: false,
      update_required: false,
      signed_in: false,
      vault_fault: false,
      pending_email: null,
      resend_in: null,
      email: null,
      name: null,
      avatar: null,
      plan: null,
      usage: null,
      subscription: null,
      offers: [],
      checkout_open: false,
      portal_open: false,
      signup_mode: null,
      billing_review: false,
      plan_change: null,
      notice: null,
      unsettled: [],
    },
    fault: null,
    retry_after: null,
  }),
  time_call: () => ({ kind: "focus_days", days: [] }),
  default_browser_status: () => ({ is_default: false, can_request: false }),
  login_item_status: () => ({ supported: false, enabled: false, needs_approval: false }),
  login_item_set: () => ({ supported: false, enabled: false, needs_approval: false }),
  panel_intent: () => true,
  panel_layout: () => {},
  newtab_search: () => true,
  newtab_cancel: () => true,
  newtab_run: () => ok,
  newtab_search_context: () => ({
    window_id: "window",
    profile_id: "profile",
    space_id: "space",
    session_id: "newtab:tab:1",
    request_id: "",
  }),
  launcher_run: () => ok,
  keymap_entries: () => KEYMAP,
  profiles_get: () => ({
    current: "01J000000000000000000000001",
    private: false,
    profiles: [
      {
        id: "01J000000000000000000000001",
        name: "Personal",
        kind: "default",
        avatar: { style: "initials", color: 0, symbol: 0, revision: 0 },
      },
    ],
  }),
  blocker_status: () => ({
    site: null,
    projection_revision: "0000000000000000000000000000000a",
    protection: "active",
    phase: "ready",
    preference: "authoritative",
    config_revision: null,
    desired_enabled: true,
    applied_enabled: true,
    desired_generation: null,
    retained_generation: null,
    failure: null,
    retryable: false,
    retries_remaining: 0,
    applied_coverage: null,
    runtime_diagnostics: null,
    source_phase: "not_configured",
    source_failure: null,
    source_package_revision: null,
    source_installed_revision: null,
    source_package_provenance: null,
    source_installed_provenance: null,
    source_identities: null,
    source_package_created_unix: null,
    source_package_stale: false,
    source_refresh_due: false,
    source_count: null,
    source_bytes: null,
    source_activation_pending: false,
    source_material_repair_pending: false,
    source_material_repair_retry_pending: false,
    source_repair_retry_pending: false,
    source_last_refresh_attempt_unix: null,
    source_refresh_operation: null,
    can_enable: true,
    can_refresh_sources: false,
  }),
  blocker_stats: () => ({ today: 128, last7Days: 1460, days: [] }),
  focus_control: () => ok,
});

export async function answer<T>(command: string, args?: unknown): Promise<T> {
  const handler = handlers.get(command);
  if (!handler) {
    if (!unmocked.has(command)) {
      unmocked.add(command);
      console.error(`[golden] unmocked invoke: ${command}`);
    }
    return null as T;
  }
  return (await handler((args ?? {}) as Record<string, unknown>)) as T;
}
