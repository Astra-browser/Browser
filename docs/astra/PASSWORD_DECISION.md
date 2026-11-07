# Password/autofill decision proposal (P4-T09, research only)

> **Implemented 2026-11-08 (D-44).** Option B is now the shipped posture:
> `overlay/astra/mozilla.cfg` disables `signon.rememberSignons`,
> `signon.autofillForms`, `signon.formlessCapture.enabled`,
> `browser.formfill.enable` and the `extensions.formautofill.*` stores because
> those stores are origin-keyed rather than container-keyed and would leak a
> credential across Astra spaces. See `docs/astra/SPACES.md`.

Owner question 6 in `OWNER_QUESTIONS.md`: keep Firefox's login-manager
surfaces, or rely on password-manager extensions as the base browser does?
This doc is the research + recommendation. No code changed.

## 1. What the base browser does today (base snapshot; origin in `PROVENANCE.md`)

Evidence from the `folder_context` base snapshot (all paths below are snapshot-relative):

- **No built-in web login manager.** There is no save-password prompt, no
  `about:logins` equivalent, no `logins.json`. The base `credentials` crate
  is an OS-vault wrapper (Windows Credential Manager / macOS login Keychain)
  is an OS-vault wrapper (Windows Credential Manager / macOS login Keychain)
  for *app* secrets (provider API keys, connection strings) — bounded,
  content-free errors, never web credentials (`lib.rs`, `macos.rs`).
- **Passwords are extension-driven.** `docs/extensions-user-guide.md` documents
  "Connecting 1Password" (desktop-app integration + independent extension
  mode); `docs/product-system.md:25` lists 1Password as a validated difficult
  extension alongside Vimium and Dark Reader; README/docs mention Bitwarden.
  On macOS the browser additionally defers to the OS AutoFill passwords panel
  (`engine/src/platform/macos/autofill.rs` in the snapshot); a password-manager
  extension toggles the browser's own filling via
  `chrome.privacy.services.passwordSavingEnabled`.
- **Import does not cover passwords.** The base `import` crate handles bookmarks,
  history and essentials only — `firefox.rs` / `chromium.rs` contain no
  login/password handling. A user migrating with saved passwords in Chrome or
  Firefox must re-enter them or go through their password-manager extension.

So "extension-only" is the base browser's current product position, not a
regression from it.

## 2. What Firefox ESR offers (pinned source `engine/`, read-only)

| Surface | Location in ESR 153 source | Notes |
|---|---|---|
| LoginManager (save/capture/fill prompts, recipes) | `toolkit/components/passwordmgr/` (~35 files: `LoginManager.sys.mjs`, `LoginManagerPrompter.sys.mjs`, `LoginRecipes.sys.mjs`, `LoginAutoComplete.sys.mjs`, …) | Master switch pref `signon.rememberSignons`; capture/autofill sub-prefs `signon.autofillForms*`, `signon.formlessCapture.enabled`, etc. |
| `about:logins` management UI | `browser/components/aboutlogins/` (`AboutLoginsParent/Child.sys.mjs`, `content/`, `jar.mn` into `browser.jar`) | Full CRUD + breach section |
| Storage: `logins.json` + `key4.db` via NSS/SDR | `storage-json.sys.mjs:104`, `crypto-SDR.sys.mjs` (`nsSecretDecoderRing`) | Primary Password = SDR master password |
| Form autofill (addresses, credit cards) | `toolkit/components/formautofill/` | Prefs `extensions.formautofill.addresses.*`, `extensions.formautofill.creditCards.*` |
| Sync engine | `services/sync/modules/engines/passwords.sys.mjs` (+ `forms.sys.mjs`) | Relevant to P7 E2EE scope |
| Extension off-switch API | `toolkit/components/extensions/schemas/privacy.json:95` (`passwordSavingEnabled`) | Bitwarden/1Password already use this to suppress built-in saving — no conflict in either option |

Mozilla-services entanglements inside these surfaces (D-15 angle):

- **Breach alerts** (`LoginBreaches.sys.mjs`, gated by
  `signon.management.page.breach-alerts.enabled`) query Firefox Monitor data.
- **Firefox Relay** integration (`signon.firefoxRelay*`, `about:logins` Relay
  UI) is a Mozilla service.
- **Login recipes** (`LoginRecipes.sys.mjs:112`) fetch remote recipes when
  `signon.recipes.remoteRecipes.enabled` — a remote Mozilla endpoint hit from
  the password path.
- None of these are load-bearing for local save/fill; each has a pref
  kill-switch. But keeping the surfaces means auditing that every such
  callout stays off, plus endpoint-audit coverage (ENDPOINTS.md) forever.

## 3. Options

### Option A — Keep LoginManager (full Firefox parity)

Ship `about:logins`, save/fill prompts, Primary Password, address + credit-card
autofill, as stock Firefox does, rebranded.

- Prefs/policies: mostly defaults; must explicitly neutralise the three
  service hooks above (Relay off, breach-alerts off, remote recipes off) and
  carry them in the endpoint audit.
- Patches: near-zero to keep it working (it is upstream code); small patches
  only to rebrand/strip Relay + Monitor UI strings if prefs leave dead UI.
- UX: full built-in manager; no extension required; password import from
  Firefox/Chrome becomes possible (P4-T05 scope grows: CSV/logins.json paths).
- Security review: NSS/SDR storage, Primary Password UX, `about:logins` as a
  privileged page, and passwords sync-engine inclusion in the P7 E2EE design —
  all in scope.
- Cost: medium. Ongoing D-15 audit burden on every ESR rebase (new service
  hooks landing inside passwordmgr/aboutlogins must be caught).

### Option B — Extension-only (base-browser parity)

Disable built-in save/fill/management; passwords come from Bitwarden,
1Password and equivalents via the curated gallery (P4-T04).

- Mechanism (no patches, all proven patterns):
  - `mozilla.cfg` **`defaultPref`** (not `lockPref`): `signon.rememberSignons`
    → `false`, `signon.autofillForms` → `false`,
    `extensions.formautofill.addresses.enabled` /
    `extensions.formautofill.creditCards.available` → `false`,
    plus service-hook prefs (Relay, breach-alerts, remote recipes) → `false`.
    `defaultPref` keeps every switch user-overridable in `about:config` —
    unlike `lockPref` (P1-T06, D-28) or locked enterprise policies
    (`PasswordManagerEnabled=false` / `OfferToSaveLogins=false` would forbid
    opt-back-in; avoid those).
  - Hide `about:logins` entry points from Astra UI (trivially absent — Astra
    renders its own UI; the page itself can stay registered but unreachable,
    so power users who flip the prefs back get a working manager).
  - Gallery (P4-T04) must include Bitwarden + 1Password as first-class entries
    with install/test evidence; extension-release-scope evidence already
    exists for 1Password.
- UX: no built-in prompts on day one; users without a password manager get a
  settings nudge toward the gallery instead of a save dialog. Matches the
  base browser's behaviour exactly, including the import gap (no password
  import — same as the base snapshot today).
- Security review: minimal — no new privileged UI, no NSS/SDR reliance, no
  passwords in P7 sync scope. OS-keychain secret storage (the `credentials`
  port) still covers provider keys.
- Cost: near-zero. No patches to carry across rebases; the disable is
  config-only and reversible by the user.

### Option C — Hybrid (storage on, prompts off by default)

Keep LoginManager fill + `about:logins`, but default `signon.rememberSignons`
to false / suppress save prompts, letting users opt in.

- Gets the worst of both: the full D-15 audit + security-review surface of
  Option A (storage, privileged page, service hooks, sync scope) plus the same
  UX gap as Option B for default users (no prompts until they dig through
  settings). Only defensible if the owner wants a built-in manager but fears
  prompt spam — a narrower pref solves that without this option's complexity.
- Cost: same as A, benefit ~none over A. Not recommended.

## 4. Recommendation

**Option B — extension-only**, for these reasons:

1. It is the base browser's shipped product position (extension-driven,
   1Password/Bitwarden validated, no password import) — keeping it is zero
   product drift.
2. It is the only option with no patches and no new privileged UI: config-only
   via `defaultPref`, user-reversible, nothing to rebase.
3. It is the cleanest D-15 story: the three Mozilla-service hooks in the
   password path (Relay, Monitor breach alerts, remote recipes) are off by
   construction, with no per-rebase audit tail.
4. It keeps P7 sync scope minimal: Astra E2EE sync never touches web
   credentials; password sync remains the extension vendor's problem (as in
   the base browser).
5. The escape hatch is free: because the disable is `defaultPref` (not policy
   lock), flipping back to Option A later is a settings/UI change, not an
   engine change.

## 5. Owner questions blocking the decision (beyond app IDs)

1. **Firefox-user expectations:** stock-Firefox converts expect a built-in
   password manager. Is shipping without one acceptable for the daily-driver
   gate, with the gallery + settings nudge as the answer? (If no → Option A.)
2. **Password import:** should P4-T05 import saved logins (CSV / Chrome /
   Firefox `logins.json`), or stay at base-snapshot parity (bookmarks/history only)?
   (Import only makes sense under Option A; under B it has nowhere to land.)
3. **Credit-card/address autofill:** disable both with passwords (base-snapshot
   parity), or keep address autofill while dropping passwords? (Splitting them
   is one pref apart, but doubles the review surface justification.)
4. **Primary Password / OS keychain:** under Option B, OS-vault storage covers
   only app secrets. Any requirement for OS-keychain-backed web credentials
   (e.g. Linux Secret Service / macOS Keychain for site logins)? (If yes →
   that is new core work, not LoginManager, and needs its own task.)
5. **Managed/enterprise environments:** any need for locked-down password
   policies (`PasswordManagerEnabled`, `DisablePasswordReveal`) in v1, or is
   user-reversible `defaultPref` sufficient until enterprise policy work lands?
