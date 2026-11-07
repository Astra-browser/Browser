# Spaces inside profiles (D-44)

A **profile** is the durable identity. A **space** is a browsing environment
inside exactly one profile. This document is the contract for that hierarchy.

```
Profile "Dev"
├── Space "Dev home"      (owner: dev profile)
├── Space "Reading"       (owner: dev profile)
└── Space "Client work"   (owner: dev profile)

Profile "Personal"
└── Space "Personal home" (owner: personal profile)
```

## Rules

1. **A profile owns many spaces.** Creating a profile mints its first (home)
   space. The Spaces settings page can add any number of further spaces, and
   the space switcher lists them.
2. **A space belongs to exactly one profile.** Ownership is stored as
   `SpaceView.profile_id` and persisted in the session snapshot
   (`SpaceSnapshot.profile_id`). There is no public command that moves a space
   to another profile.
3. **A space is never shared.** The space switcher, reorder, tab move and
   bookmark import all operate inside the profile in front. A space from
   another profile is not listed, cannot be renamed or deleted from it, and is
   not confirmed to exist by import or clear-data calls.
4. **Switching follows the space.** Selecting a space selects the profile that
   owns it, so the profile in front and the space in front can never disagree.
   Other profiles keep their tabs and containers loaded; switching back
   restores them.
5. **Deleting a profile deletes every space it owns.** The spaces' containers
   are removed through `space.deleted`, which drops their site data.

## What is isolated per space

| Data | Mechanism | Isolated? |
|---|---|---|
| Cookies, localStorage, IndexedDB, Cache API, HTTP cache | Firefox container (`originAttributes.userContextId`), one per space | Yes |
| Signed-in web sessions | Same container cookies/storage | Yes |
| Bookmarks | A per-space folder tree in Places (`Astra · space-N`); space 1 owns the unfiled root | Yes |
| Open tabs and tab history | `TabView.space_id`; tabs cannot cross a profile boundary | Yes |
| Space identity (name, icon, colour, theme) | Host model, persisted in the session snapshot | Yes |
| Preferences and extensions | The one running profile directory | No — shared by the profile |
| Places history, downloads list, favicons | Firefox's global stores | No — shared by the profile |
| Firefox login manager, form history, address/credit-card autofill | Firefox's global credential stores | **Off** (see below) |

## Security posture

Firefox's login manager and form-history store are keyed by origin, not by
`userContextId`. A credential saved in one space would therefore be offered to
the same site in a sibling space. Until the engine can partition those stores,
`mozilla.cfg` turns the global ones off (`signon.rememberSignons`,
`signon.autofillForms`, `signon.formlessCapture.enabled`, `browser.formfill.enable`,
`extensions.formautofill.*`) and Astra relies on password-manager extensions or
the OS vault, as `PASSWORD_DECISION.md` recommends (option B). The same section
disables the Firefox Relay / breach-alert / remote-recipe callouts.

Additional properties:

- Deleting a space calls the host container `remove()`, which clears the
  `userContextId` pattern before erasing the identity. Sibling spaces are not
  touched.
- "Clear space data" uses the same pattern clear on a single space and is
  refused for a space of a profile that is not in front.
- Importing bookmarks is an explicit, bounded copy (5 000 entries) inside one
  profile. It never moves or deletes the source, and it is refused across
  profiles.
- A private window records no spaces; the private scope never writes a
  snapshot.
- A space's ownership is immutable after adoption. The only exception is the
  one-time adoption of spaces saved before ownership existed, which the running
  profile performs on the first Profiles read.

## Settings

**Settings → Spaces** lists the spaces of the profile in front:

- create, rename, delete and switch spaces;
- import bookmarks from another space in the same profile;
- clear one space's cookies, site storage and cache;
- see the other profiles and switch to them, with their space counts.

The Profiles page shows each profile's space count, and the space switcher only
ever lists the profile in front.

## Verification

| Check | Command |
|---|---|
| Ownership, cross-profile refusal, delete cascade, bookmark import, session round-trip, per-space clear | `node tests/contract/spaces_profiles_model.mjs` |
| Existing space and profile contracts | `node tests/contract/spaces_model.mjs`; `node tests/contract/profiles_model.mjs` |
| Bookmarks and container isolation | `node tests/contract/bookmarks_model.mjs`; `node tests/contract/containers_isolation.mjs` |
| UI typecheck/lint/tests | `cd ui/app && bun run typecheck && bun run lint && bun run test` |
| Core snapshot | `cargo test -p astra-core --jobs 2` |

## Known limits

- Preferences, extensions and the Places history database remain shared by the
  one running profile directory (D-41). History is not scoped per space; the
  Settings copy says so. A future engine-side visit annotation is the path to
  per-space history.
- A profile switch is an in-window space transition, not a new process or
  profile directory (D-41).
