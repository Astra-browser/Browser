/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Element-hiding bridge routes (P4-T11). The `ContentHide` protocol
// (`schemas/content-hide.json`, `overlay/astra/host/ContentHide.sys.mjs`)
// is served through the `Content` actor; the UI reaches it over the bridge
// with these command names and event channels. This module is the single
// place that maps ContentHide methods -> bridge commands so the app wiring
// layer (`$shared/ipc/bridge.ts`) and the MOCK host stay in agreement.
//
// Command naming follows the existing `blocker_*` family (e.g.
// `blocker_site_change`): `hide_*` for page passes + rule management,
// `hide_pick_*` for the click-to-hide picking flow.

/** Bridge command for each ContentHide method (UI -> host direction). */
export const CONTENT_HIDE_ROUTES = {
  hideForPage: "hide_for_page",
  startPicking: "hide_pick_start",
  cancelPicking: "hide_pick_cancel",
  confirmPick: "hide_pick_confirm",
  addRule: "hide_rule_add",
  removeRule: "hide_rule_remove",
  listRules: "hide_rule_list",
  clearSite: "hide_site_clear",
} as const;

export type ContentHideMethod = keyof typeof CONTENT_HIDE_ROUTES;
export type ContentHideCommand =
  (typeof CONTENT_HIDE_ROUTES)[ContentHideMethod];

/** Host -> UI event channels emitted by the picking flow / rule changes. */
export const CONTENT_HIDE_EVENTS = {
  pickingStarted: "content-hide.picking-started",
  pickingCancelled: "content-hide.picking-cancelled",
  ruleAdded: "content-hide.rule-added",
  ruleRemoved: "content-hide.rule-removed",
} as const;

export type ContentHideEvent =
  (typeof CONTENT_HIDE_EVENTS)[keyof typeof CONTENT_HIDE_EVENTS];

/** Every bridge command this module routes (for coverage assertions). */
export function contentHideCommands(): ContentHideCommand[] {
  return Object.values(CONTENT_HIDE_ROUTES);
}

/** Every event channel this module delivers (for coverage assertions). */
export function contentHideEvents(): ContentHideEvent[] {
  return Object.values(CONTENT_HIDE_EVENTS);
}

export interface HideRuleArgs {
  host?: string;
  url?: string;
  selector?: string;
  element?: unknown;
  requestId?: string;
}

/**
 * Invoke one ContentHide method through a Tauri-shaped `invoke` function.
 * Returns the decoded host payload (`HideResult` envelope or error).
 */
export async function invokeContentHide<T = unknown>(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T>,
  method: ContentHideMethod,
  args: HideRuleArgs = {},
): Promise<T> {
  const cmd = CONTENT_HIDE_ROUTES[method];
  const { requestId: _drop, ...rest } = args;
  void _drop;
  return invoke(cmd, rest as Record<string, unknown>);
}

/**
 * Register in-memory MOCK responders for every ContentHide command on a
 * `MockHost`-shaped responder registry. The mock keeps per-site rule lists
 * in a `Map` (host-keyed, lower-cased like `normalizeHost`) and answers
 * `hide_for_page` with an empty selector pass; tests override per-command
 * via `respond(cmd, fn)` afterwards. Keeps `mock-host.ts` untouched: the
 * app test harness calls this once after constructing the `MockHost`.
 */
export function registerContentHideMock(respond: (
  cmd: string,
  fn: (args: Record<string, unknown>) => unknown | Promise<unknown>,
) => void): Map<string, string[]> {
  const rules = new Map<string, string[]>();
  const siteOf = (args: Record<string, unknown>): string | null => {
    const raw =
      typeof args["host"] === "string" && args["host"] !== ""
        ? args["host"]
        : typeof args["url"] === "string"
          ? args["url"]
          : "";
    if (!raw) return null;
    try {
      const host = raw.includes("://") ? new URL(raw).hostname : raw;
      const site = host.trim().replace(/\.$/, "").toLowerCase();
      return site === "" ? null : site;
    } catch {
      return null;
    }
  };
  const ok = (request_id: unknown, extra: Record<string, unknown> = {}) => ({
    request_id,
    host_api_version: 1,
    ...extra,
  });
  const fail = (request_id: unknown, code: string, message: string) => ({
    request_id,
    host_api_version: 1,
    error: { code, message },
  });

  respond(CONTENT_HIDE_ROUTES.hideForPage, (args) => {
    const request_id = args["request_id"];
    const url = typeof args["url"] === "string" ? args["url"] : "";
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return fail(request_id, "invalid_url", "hideForPage requires an http(s) page URL");
    }
    if (!host) return fail(request_id, "invalid_url", "hideForPage requires an http(s) page URL");
    return ok(request_id, { url, host, selectors: [], hidden: 0 });
  });
  respond(CONTENT_HIDE_ROUTES.startPicking, (args) =>
    ok(args["request_id"], { picking: true }),
  );
  respond(CONTENT_HIDE_ROUTES.cancelPicking, (args) =>
    ok(args["request_id"], { picking: false }),
  );
  respond(CONTENT_HIDE_ROUTES.confirmPick, (args) => {
    const request_id = args["request_id"];
    const site = siteOf(args);
    const selector =
      typeof args["selector"] === "string" ? args["selector"].trim() : "";
    if (!site) return fail(request_id, "invalid_host", "confirmPick requires a host or page URL");
    if (!selector) return fail(request_id, "invalid_selector", "confirmPick requires a valid CSS selector");
    const list = [...new Set([...(rules.get(site) ?? []), selector])].sort();
    rules.set(site, list);
    return ok(request_id, { host: site, selector, selectors: list });
  });
  respond(CONTENT_HIDE_ROUTES.addRule, (args) => {
    const request_id = args["request_id"];
    const site = siteOf(args);
    const selector =
      typeof args["selector"] === "string" ? args["selector"].trim() : "";
    if (!site) return fail(request_id, "invalid_host", "addRule requires a host or page URL");
    if (!selector) return fail(request_id, "invalid_selector", "addRule requires a valid CSS selector");
    const list = [...new Set([...(rules.get(site) ?? []), selector])].sort();
    rules.set(site, list);
    return ok(request_id, { host: site, selectors: list });
  });
  respond(CONTENT_HIDE_ROUTES.removeRule, (args) => {
    const request_id = args["request_id"];
    const site = siteOf(args);
    if (!site) return fail(request_id, "invalid_host", "removeRule requires a host or page URL");
    const selector =
      typeof args["selector"] === "string" ? args["selector"].trim() : "";
    rules.set(site, (rules.get(site) ?? []).filter((s) => s !== selector));
    return ok(request_id, { host: site, selectors: rules.get(site) ?? [] });
  });
  respond(CONTENT_HIDE_ROUTES.listRules, (args) => {
    const request_id = args["request_id"];
    const site = siteOf(args);
    if (!site) return fail(request_id, "invalid_host", "listRules requires a host or page URL");
    return ok(request_id, { host: site, selectors: rules.get(site) ?? [] });
  });
  respond(CONTENT_HIDE_ROUTES.clearSite, (args) => {
    const request_id = args["request_id"];
    const site = siteOf(args);
    if (!site) return fail(request_id, "invalid_host", "clearSite requires a host or page URL");
    rules.set(site, []);
    return ok(request_id, { host: site, selectors: [] });
  });
  return rules;
}
