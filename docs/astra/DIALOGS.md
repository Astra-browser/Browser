# Dialogs — browser dialogs over the Host API (P3-T09)

Browser dialogs (permissions, downloads, HTTP auth, certificate errors,
find-in-page, print preview, page context menus) surface as Host API
**request events**. The Astra UI renders its own dialog chrome and answers
with explicit **resolve commands** on `Dialogs` (`overlay/astra/host/Dialogs.sys.mjs`).
Event and payload shapes are pinned in `overlay/astra/host/schemas/dialogs.json`;
contract coverage lives in `tests/contract/dialogs_events.mjs` (emission +
resolve flows) and `tests/contract/dialogs_security.mjs` (spoof-resistance).

`HostAPI.sys.mjs` does not re-export `Dialogs` yet on purpose: the
orchestrator wires the new module into the facade at merge time so this
lane never conflicts with other host lanes.

## Request → resolve pairs

| Request event | Open | Resolve | Notes |
|---|---|---|---|
| `permission.requested` | `requestPermission` | `decidePermission` (`grant` / `deny`) | Live store is `Services.perms`; UI mapping follows `SitePermissions.sys.mjs` |
| `download.started` | `requestDownload` | `decideDownload` (`allow` / `deny`) | Mirrors `DownloadsViewUI`; allow gates the file write |
| `auth.required` | `requestAuth` | `respondAuth` (`{username, password}` or `cancel`) | Forwards to `nsIAuthPrompt2`; event carries only `provided` |
| `cert.error` | `requestCertError` | `decideCert` (`proceed-once` / `cancel`) | One-load bypass only; no permanent exceptions |
| `find.opened` / `find.closed` | `openFind` / `closeFind` | — | Bar lifecycle only; query/counts stay in `Navigation.findInPage` + `browser.finder` |
| `print.preview-opened` / `print.resolved` | `openPrintPreview` | `resolvePrint` (`print` / `cancel`) | Dispatch itself stays in `Navigation.print` / `Content.printPage` |
| `contextmenu.requested` | `requestContextMenu` | `resolveContextMenu` (`action`) | Built from chrome `nsContextMenu` data (link/image/selection at x/y) |

Every dialog has a `dialog_id` (`dlg-N`), a `kind`, and a `status`
(`pending` → `resolved`). Resolving an unknown id returns `no_such_dialog`;
resolving twice returns `already_resolved`. `get` / `list` (optional
`status` filter) introspect pending dialogs, e.g. to re-render after restart.

## HTTP auth (P6c-1)

`DialogPrompts.sys.mjs` turns a real 401 into the app's existing sign-in card:

- `patches/ASTRA-0009-astra-http-auth.patch` calls the window's entry from
  `LoginManagerAuthPrompter` instead of `Services.prompt.asyncPromptAuth`, so
  the engine dialog never opens for an Astra tab. A non-Astra tab keeps the
  engine prompt.
- `Dialogs.requestAuth` mints the record; the tab projection carries
  `page_request: {kind:"http_auth", request, host, insecure, proxy, retry}`;
  the app answers with `tabs_answer_sign_in`.
- Credentials live only in the `DialogPrompts` closure. They never enter an
  event, the projection, the operation ledger or a log; the engine's `authInfo`
  is set immediately before the promise resolves.
- A response must match the exact tab and request token. A stale answer is
  refused (`invalid_scope`), and a navigation or tab close resolves the engine
  prompt false and clears the card.
- Only `basic`/`digest` are owned. NTLM/Negotiate and password-only challenges
  are cancelled rather than shown in Firefox's dialog (recorded limitation).

Live probe: `tools/perf/stress/http_auth_probe.py` — real 401, wrong password
returns retry, right password loads the page, cancel clears, and no
`commonDialog.xhtml` window ever appears.

## SECURITY — trust boundary

Web content is an **untrusted principal**. A page that could grant itself
camera access, dismiss a certificate error, or auto-allow a download would
be a full sandbox escape, so:

1. **Only chrome-privileged code may resolve.** Every resolve path
   (`decidePermission`, `decideDownload`, `respondAuth`, `decideCert`,
   `closeFind`, `resolvePrint`, `resolveContextMenu`) — and every
   `request*` opener — requires `actor: "chrome"`. Any other actor
   (including `"content"` or a missing actor) is rejected with
   `untrusted_actor` and changes nothing. There is deliberately no
   implicit default: callers must assert their privilege on each call.
2. **Content can only report.** The content actor's sole entry point is
   `reportFromContent`, which files an unverified `dialog.content-report`
   event tagged `untrusted: true`. It never creates, alters, or resolves a
   pending dialog. Chrome opens a real dialog only after its own engine
   listener (permission observer, auth prompter, TLS error page, and so on)
   independently confirms the condition.
3. **Secrets never enter the event stream.** `auth.resolved` carries only
   `provided: true/false`; usernames and passwords travel call-locally to
   the engine prompt and are never stored on the dialog record.
4. **Certificate errors fail closed.** The only bypass is `proceed-once`
   for the current load; the model offers no "always trust this host", and
   a content-originated `proceed-once` is rejected like any other spoof
   (proven by `dialogs_security.mjs`: spoof → reject → still pending →
   chrome `cancel` wins).

Live binding rule for the shell: resolve calls must originate from
chrome-document event handlers or `messageManager` frames the tree owner
marks privileged — never from a `ContentActor` receiving page messages.
If a new dialog kind is added, it must take the same `actor` gate and add
a spoof case to `dialogs_security.mjs` before it ships.

## Runtime permission prompt (P6b)

`Permissions.sys.mjs` is the live page-permission path; `Dialogs` remains the
model for the settings surfaces. A page request now becomes the app's existing
`PagePermissionPrompt`:

| Step | Owner |
|---|---|
| Engine calls `nsIContentPermissionPrompt` | `Permissions.install()` registers an `Integration.contentPermission` override for geolocation and delegates every other type to Firefox |
| Prompt published | `page-permission-prompt-changed` carries `{ projection_revision, prompt }` (schema: `schemas/permissions.json`) |
| App answers | `page_permission_respond(profileId, itemId, requestId, decision)` → host route → `Permissions.respond` |
| Settlement | the disposition arrives on the bounded `Operations` ledger (`operation_status` / `operations_reconcile` / `operation_acknowledge`, `operation-processed`) |
| Engine write | `SitePermissions.setForPrincipal` with `SCOPE_TEMPORARY` (`allow_once` / `deny_once`) or `SCOPE_PERSISTENT` (`always_allow` / `always_deny`) |

Security properties of this path:

- The prompt token plus the exact `profile_id`/`item_id` is the stale fence.
  A missing, replayed or mismatched token is refused as `invalid_scope` and
  resolves nothing.
- A decision is single-shot: the record leaves the queue before the engine is
  touched. A prompt is also fenced to the document it was raised for: a
  navigation (chrome progress listener) or tab close cancels it, and a late
  answer for a document that already changed is refused.
- The queue shows one prompt at a time. Overflow cancels the *incoming*
  request; it never evicts the prompt a person is looking at.
- Ephemeral contexts, and unsafe third-party delegates, are published with
  `rememberable: false`; chrome refuses a durable decision for them even if
  one arrives.
- `dismiss` closes the prompt and cancels only this request: it writes no site
  policy, so Escape does not silently block the site.
- A failed durable write cancels the request and reports
  `store_admission_rejected`; a durable write the engine never observed is
  rolled back and reported `store_outcome_unknown`. It never grants.
- An allow or deny updates `gBrowser.updateBrowserSharing(browser, {geo})`, so
  the toolbar indicator and "Stop sharing" keep working.
- One process-wide `Integration.contentPermission` override routes each
  request to the host instance of the window that owns the tab; an unowned
  browser (or a closed window) falls back to Firefox's own prompt instead of a
  dead event pump.

Scope today: **geolocation, camera and microphone**. Camera/microphone do not
use `nsIContentPermissionPrompt`; the WebRTC actor is the seam:

- `Permissions.install({window})` also publishes `{askForWebRTC, cancelWebRTC}`
  for that window on `Services.astraPermissionWindows`, because the actor runs
  in the shared parent module loader and cannot import the shell's per-window
  instance.
- `patches/ASTRA-0008-astra-webrtc-prompt.patch` hands a `getUserMedia` request
  to that entry after the engine's own `BLOCK` check. Astra publishes one
  prompt with both kinds; the actor still chooses the default devices, writes
  `MediaManagerVideo`, calls `activateDevicePerm`, checks the OS permission and
  sends `webrtc:Allow`/`webrtc:Deny`. Screen share, audio capture, speaker
  selection, add-on prompts, unsafe delegation, insecure/non-web URLs and the
  browser-chrome test harness keep the native prompt.
- A page that navigates or closes sends `webrtc:CancelRequest`, which cancels
  the Astra record too.
- The live probe covers allow-always, deny-always, allow-once (temporary
  scope), dismiss, auto-allow after a persistent grant, and the native
  doorhanger staying absent.

