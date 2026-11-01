/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Dialogs module (P3-T09). Browser dialogs surface as Host API
// request events; the Astra UI resolves them with explicit commands.
// Pure logic, no Firefox internals: the live shell wires each request to
// the engine listener noted below and each resolve to the matching engine
// call, with no change to this model's method names or event shapes.
//
// Covered dialogs:
// - Permissions      requestPermission / decidePermission
//                    (permission.requested / permission.resolved)
// - Downloads UI     requestDownload / decideDownload
//                    (download.started / download.resolved)
// - HTTP auth        requestAuth / respondAuth
//                    (auth.required / auth.resolved)
// - Certificate errors requestCertError / decideCert
//                    (cert.error / cert.resolved)
// - Find-in-page bar  openFind / closeFind (match counting stays in
//                    Navigation.findInPage; find.opened / find.closed)
// - Print preview    openPrintPreview / resolvePrint
//                    (print.preview-opened / print.resolved)
// - Page context menus requestContextMenu / resolveContextMenu
//                    (contextmenu.requested / contextmenu.resolved)
//
// Engine grounding (verified against the pinned ESR source, read-only):
// - Permissions: `Services.perms` (`UNKNOWN/ALLOW/DENY/PROMPT_ACTION`) is
//   the store; `browser/modules/SitePermissions.sys.mjs` maps engine
//   states to UI and dispatches `PermissionStateChange` on the browser
//   element. Live, requestPermission is called from that chrome-side
//   observer, never from page script.
// - Downloads: `browser/components/downloads/DownloadsViewUI.sys.mjs`
//   (+ `DownloadsCommon.sys.mjs`) owns the panel/progress UI the shell
//   mirrors; allow/deny gates the target file write.
// - HTTP auth: `toolkit/components/passwordmgr/LoginManagerAuthPrompter.sys.mjs`
//   implements `nsIAuthPrompt2`; respondAuth forwards credentials (or
//   cancellation) to the channel's pending prompt. The resolved event
//   carries only `provided: true/false`, never the secrets.
// - Certificate errors: the engine renders `about:certerror` in the
//   content area on TLS failure; only a chrome decision may override it
//   for one load (`proceed-once`). No permanent exception is offered here.
// - Find: `toolkit/modules/Finder.sys.mjs` + `FinderParent.sys.mjs`
//   drive match counting behind `browser.finder`; this module tracks only
//   the find-bar session lifecycle (Navigation owns query/counts).
// - Context menus: the chrome `nsContextMenu` handler builds the menu
//   from browser-element data (link/image/selection at screen x/y), which
//   is what requestContextMenu carries.
//
// SECURITY — trust boundary (plan §P3-T09 security review):
// - Web content is an untrusted principal. It must never be able to grant
//   itself a permission, dismiss a certificate error, supply auth
//   credentials, or auto-allow a download by forging a resolution.
// - Therefore every resolve path requires `actor: "chrome"`. Any other
//   value (including `"content"` or a missing actor) is rejected with
//   `untrusted_actor` and changes nothing.
// - The content actor's only entry point is `reportFromContent`, which
//   records an unverified claim as a `dialog.content-report` event tagged
//   `untrusted: true`. It never creates, alters, or resolves a pending
//   dialog. Chrome must independently verify (engine listener, visible
//   browser state) before opening a real dialog for the claim.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";

export { HOST_API_VERSION };

const CHROME_ACTOR = "chrome";

const PERMISSIONS = new Set([
  "geolocation",
  "camera",
  "microphone",
  "notifications",
  "persistent-storage",
  "midi",
  "pointer-lock",
  "fullscreen",
]);

const AUTH_SCHEMES = new Set(["basic", "digest", "ntlm", "negotiate"]);

const _pending = new Map(); // dialog_id -> record
let _nextDialog = 1;

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

// Trust gate: only chrome-privileged callers may resolve. Returns an error
// response when the actor is not chrome, else null.
function requireChrome(request_id, actor) {
  if (actor !== CHROME_ACTOR) {
    return err(request_id, "untrusted_actor", "only chrome-privileged code may resolve dialogs");
  }
  return null;
}

function mint(kind, extra = {}) {
  const dialog_id = `dlg-${_nextDialog++}`;
  const record = { dialog_id, kind, status: "pending", ...extra };
  _pending.set(dialog_id, record);
  return record;
}

function take(request_id, dialog_id, kind) {
  const record = _pending.get(dialog_id);
  if (!record || record.kind !== kind) {
    return { error: err(request_id, "no_such_dialog", `unknown dialog ${dialog_id ?? ""}`) };
  }
  if (record.status !== "pending") {
    return { error: err(request_id, "already_resolved", `dialog ${dialog_id} already resolved`) };
  }
  return { record };
}

function snapshot(record) {
  return { ...record };
}

export const Dialogs = {
  // --- Permissions ---

  async requestPermission({ request_id = "", astra_tab_id = "", url = "", permission = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (typeof url !== "string" || url === "") {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    if (!PERMISSIONS.has(permission)) {
      return err(request_id, "invalid_permission", `unknown permission ${permission}`);
    }
    const record = mint("permission", { astra_tab_id, url, permission });
    emit("permission.requested", {
      dialog_id: record.dialog_id,
      astra_tab_id,
      url,
      permission,
    });
    return ok(request_id, { dialog: snapshot(record) });
  },

  async decidePermission({ request_id = "", dialog_id = "", decision = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (decision !== "grant" && decision !== "deny") {
      return err(request_id, "invalid_decision", "decision must be grant or deny");
    }
    const { record, error } = take(request_id, dialog_id, "permission");
    if (error) {
      return error;
    }
    // Live: Services.perms.addFromPrincipal(uri, permission, ALLOW/DENY_ACTION).
    record.status = "resolved";
    record.decision = decision;
    emit("permission.resolved", { dialog_id, decision });
    return ok(request_id, { dialog_id, decision });
  },

  // --- Downloads UI ---

  async requestDownload({ request_id = "", astra_tab_id = "", url = "", filename = "", mime = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (typeof url !== "string" || url === "") {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    if (typeof filename !== "string" || filename === "") {
      return err(request_id, "invalid_filename", "filename must be a non-empty string");
    }
    const record = mint("download", { astra_tab_id, url, filename, mime });
    emit("download.started", { dialog_id: record.dialog_id, astra_tab_id, url, filename, mime });
    return ok(request_id, { dialog: snapshot(record) });
  },

  async decideDownload({ request_id = "", dialog_id = "", decision = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (decision !== "allow" && decision !== "deny") {
      return err(request_id, "invalid_decision", "decision must be allow or deny");
    }
    const { record, error } = take(request_id, dialog_id, "download");
    if (error) {
      return error;
    }
    record.status = "resolved";
    record.decision = decision;
    emit("download.resolved", { dialog_id, decision });
    return ok(request_id, { dialog_id, decision });
  },

  // --- HTTP auth ---

  async requestAuth({ request_id = "", astra_tab_id = "", host = "", realm = "", scheme = "basic", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (typeof host !== "string" || host === "") {
      return err(request_id, "invalid_host", "host must be a non-empty string");
    }
    if (scheme !== undefined && scheme !== "" && !AUTH_SCHEMES.has(scheme)) {
      return err(request_id, "invalid_scheme", `unknown auth scheme ${scheme}`);
    }
    const record = mint("auth", { astra_tab_id, host, realm, scheme });
    emit("auth.required", { dialog_id: record.dialog_id, astra_tab_id, host, realm, scheme });
    return ok(request_id, { dialog: snapshot(record) });
  },

  // Credentials are forwarded to the engine prompt and never echoed back:
  // the resolved event carries only `provided`.
  async respondAuth({ request_id = "", dialog_id = "", username = "", password = "", cancel = false, actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    const { record, error } = take(request_id, dialog_id, "auth");
    if (error) {
      return error;
    }
    if (cancel === true) {
      record.status = "resolved";
      record.provided = false;
      emit("auth.resolved", { dialog_id, provided: false });
      return ok(request_id, { dialog_id, provided: false });
    }
    if (typeof username !== "string" || username === "") {
      return err(request_id, "invalid_credentials", "username must be a non-empty string unless cancel is true");
    }
    // Live: prompt.SetAuthInfo(username, password) via nsIAuthPrompt2.
    record.status = "resolved";
    record.provided = true;
    void password;
    emit("auth.resolved", { dialog_id, provided: true });
    return ok(request_id, { dialog_id, provided: true });
  },

  // --- Certificate errors ---

  async requestCertError({ request_id = "", astra_tab_id = "", url = "", code = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (typeof url !== "string" || url === "") {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    if (typeof code !== "string" || code === "") {
      return err(request_id, "invalid_code", "code must be a non-empty string");
    }
    const record = mint("cert", { astra_tab_id, url, code });
    emit("cert.error", { dialog_id: record.dialog_id, astra_tab_id, url, code });
    return ok(request_id, { dialog: snapshot(record) });
  },

  // Only one-load bypass exists here; permanent exceptions are out of
  // scope by design (the user re-decides every visit).
  async decideCert({ request_id = "", dialog_id = "", decision = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (decision !== "proceed-once" && decision !== "cancel") {
      return err(request_id, "invalid_decision", "decision must be proceed-once or cancel");
    }
    const { record, error } = take(request_id, dialog_id, "cert");
    if (error) {
      return error;
    }
    record.status = "resolved";
    record.decision = decision;
    emit("cert.resolved", { dialog_id, decision });
    return ok(request_id, { dialog_id, decision });
  },

  // --- Find-in-page bar session ---

  async openFind({ request_id = "", astra_tab_id = "", query = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    const record = mint("find", { astra_tab_id, query: String(query ?? "") });
    emit("find.opened", { dialog_id: record.dialog_id, astra_tab_id, query: record.query });
    return ok(request_id, { dialog: snapshot(record) });
  },

  async closeFind({ request_id = "", dialog_id = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    const { record, error } = take(request_id, dialog_id, "find");
    if (error) {
      return error;
    }
    record.status = "resolved";
    emit("find.closed", { dialog_id, astra_tab_id: record.astra_tab_id });
    return ok(request_id, { dialog_id, closed: true });
  },

  // --- Print preview ---

  async openPrintPreview({ request_id = "", astra_tab_id = "", url = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    const record = mint("print", { astra_tab_id, url: String(url ?? "") });
    emit("print.preview-opened", { dialog_id: record.dialog_id, astra_tab_id, url: record.url });
    return ok(request_id, { dialog: snapshot(record) });
  },

  async resolvePrint({ request_id = "", dialog_id = "", decision = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (decision !== "print" && decision !== "cancel") {
      return err(request_id, "invalid_decision", "decision must be print or cancel");
    }
    const { record, error } = take(request_id, dialog_id, "print");
    if (error) {
      return error;
    }
    record.status = "resolved";
    record.decision = decision;
    emit("print.resolved", { dialog_id, decision });
    return ok(request_id, { dialog_id, decision });
  },

  // --- Page context menus ---

  async requestContextMenu({
    request_id = "",
    astra_tab_id = "",
    x = 0,
    y = 0,
    link_url = "",
    image_url = "",
    selection = "",
    actor = "",
  } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      return err(request_id, "invalid_point", "x and y must be finite numbers");
    }
    const record = mint("contextmenu", { astra_tab_id, x, y, link_url, image_url, selection });
    emit("contextmenu.requested", {
      dialog_id: record.dialog_id,
      astra_tab_id,
      x,
      y,
      link_url: String(link_url ?? ""),
      image_url: String(image_url ?? ""),
      selection: String(selection ?? ""),
    });
    return ok(request_id, { dialog: snapshot(record) });
  },

  async resolveContextMenu({ request_id = "", dialog_id = "", action = "", actor = "" } = {}) {
    const gate = requireChrome(request_id, actor);
    if (gate) {
      return gate;
    }
    if (typeof action !== "string" || action === "") {
      return err(request_id, "invalid_action", "action must be a non-empty string");
    }
    const { record, error } = take(request_id, dialog_id, "contextmenu");
    if (error) {
      return error;
    }
    record.status = "resolved";
    record.action = action;
    emit("contextmenu.resolved", { dialog_id, action });
    return ok(request_id, { dialog_id, action });
  },

  // --- Content-actor ingress (untrusted) ---
  //
  // The ONLY entry point the content actor (page script / content process)
  // may call. It records the claim as a `dialog.content-report` event
  // tagged `untrusted: true` and returns without touching any pending
  // dialog. A report is never evidence: chrome opens a real dialog only
  // after its own engine listener confirms the underlying condition.

  async reportFromContent({ request_id = "", kind = "", astra_tab_id = "", facts = {} } = {}) {
    if (typeof kind !== "string" || kind === "") {
      return err(request_id, "invalid_kind", "kind must be a non-empty string");
    }
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    emit("dialog.content-report", {
      kind,
      astra_tab_id,
      facts: typeof facts === "object" && facts !== null ? facts : {},
      untrusted: true,
    });
    return ok(request_id, { recorded: true, untrusted: true });
  },

  // --- Introspection ---

  async get({ request_id = "", dialog_id = "" } = {}) {
    const record = _pending.get(dialog_id);
    if (!record) {
      return err(request_id, "no_such_dialog", `unknown dialog ${dialog_id}`);
    }
    return ok(request_id, { dialog: snapshot(record) });
  },

  async list({ request_id = "", status = "" } = {}) {
    const dialogs = [..._pending.values()].map(snapshot).filter((d) => status === "" || d.status === status);
    return ok(request_id, { dialogs });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetDialogsForTests() {
  _pending.clear();
  _nextDialog = 1;
}
