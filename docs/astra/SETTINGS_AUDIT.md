# Settings audit - Windows dev build

What every Settings surface does in the running build, checked live rather than
read off the source.

**First pass:** 2026-11-15, against `windows-port` at 348b85b5.
**Second pass (fixes):** the same day, against the working tree that fixes the
five findings below.

```
engine/obj-astra-windows/dist/bin/firefox.exe
Astra 0.1.745 - Windows_NT 10.0 - x86_64
```

Method: `tools/windows/settings-probe.py <firefox.exe>` launches the build
headless with Marionette and a throwaway profile, opens Settings, walks every
navigation page, reads each row's control and disabled state, then **clicks one
representative control per page** and asserts the value changed *and* survived
leaving the page. It also cross-checks every binding the Settings feature calls
against the host route table.

```
python tools/windows/settings-probe.py engine/obj-astra-windows/dist/bin/firefox.exe
```

```
105 passed, 0 failed   (14 pages x 3 page checks + 20 rows x 3 + wiring)
```

Machine-readable output: `out/settings-probe.json` (`pages`, `representative`,
`observations`, `wiring`).

## The chart

`OK` working and exercised live - `n/a` disabled for a real state reason -
`BAD` a control in the group is broken.

| # | Page | Rows | Disabled | Live check that passed | Verdict |
|---|---|---|---|---|---|
| 1 | General | 9 | 0 | startup select -> `tabs.startup=new-tab`; downloads switch -> `browser.download.useDownloadDir=false` | OK |
| 2 | Appearance | 15 | 1 | mode -> `appearance=dark`, theme -> `ui.theme=paper`, density -> `compact` | OK |
| 3 | Tabs | 31 | 0 | `tabs.duplicates`, `split.enabled` flip and persist | OK |
| 4 | New Tab | 10 | 1 | `ntp.wordmark`, `ntp.clock` flip and persist | OK |
| 5 | Search | 4 | 0 | `search.suggestions` flips and persists | OK |
| 6 | Extensions | 2 | 0 | `extensions.per-space` flips and persists | OK (empty: none installed) |
| 7 | Privacy & security | 9 | 1 | `privacy.blocking` flips the blocker, DRM, history scope; SmartScreen reads its host answer | OK |
| 8 | Time & focus | 5 | 0 | `focus.breaks`, `time.track` flip and persist | OK |
| 9 | Performance | 4 | 0 | `performance.sleep`, `performance.memory` -> `save-memory` | OK |
| 10 | Profiles | 4 rows (custom) | - | New Profile opens Name/Photo/Colour/Create | OK |
| 11 | Spaces | 1 space (custom) | - | Edit opens the editor; New Space keeps Settings and opens "Edit Space 2" | OK |
| 12 | Features | 3 | 0 | `notes.enabled`, `tasks.enabled` flip and persist | OK |
| 13 | Keyboard & accessibility | 81 | 0 | Ctrl+Shift+Y captured on a keymap row -> Save/Cancel | BAD (launcher row) |
| 14 | About | 3 | 0 | Copy Diagnostics expands the report | OK (updates dev-gated) |

**Totals:** 14 pages, 176 setting rows, 3 disabled rows, 0 page alerts, 0
`unknown_command` console errors on any page.

The identity card is gone: it was drawn while `flags.account` is off, so a
person could click a sign-in panel that had no section behind it.

## Row-level detail

### Working end to end

| Row | Verified |
|---|---|
| `general.startup` | select -> `tabs.startup` = `new-tab`, label follows |
| `downloads.ask` | switch -> `browser.download.useDownloadDir` true -> false |
| `general.home`, `downloads.path` | real values (empty home, `C:\Users\Rem\Downloads`) |
| `appearance.theme`, `appearance.palette` | `appearance=dark`, `ui.theme=paper` |
| `appearance.density`, `appearance.motion` | `ui.density=compact`; motion flips and persists |
| 31 Tabs rows | `tabs.duplicates` -> `tabs.switch-to-open=false`; `split.enabled=false` |
| New Tab | `ntp.wordmark`, `ntp.clock` flip and persist |
| Search | suggestions switch persists |
| Extensions | per-space switch persists; honest "No extensions installed" |
| Privacy | blocking flips the live blocker, DRM, history scope -> `profile`; SmartScreen reads "not managed" |
| Time & focus | breaks + tracking switches persist |
| Performance | sleep switch, memory select -> `save-memory` |
| Profiles | 4 real profiles; New Profile dialog |
| Spaces | 1 real space; Edit and New Space both open the space editor |
| Features | notes + tasks switches, with honest "Off. Your notes are kept." |
| Keyboard | all 80 keymap rows; rebinding captures the key and offers Save/Cancel |
| About | version, platform, Copy Diagnostics expands |
| Blocker | 6/14 ads, 3/19 optional, 2/2 malware, 3/3 trackers, 0/43 regional lists |

### Disabled rows, and why

| Row | Page | Reason | Class |
|---|---|---|---|
| `appearance.zoom-levels` | Appearance | No site has been zoomed in this profile | conditional |
| `ntp.personalize` | New Tab | Depends on the greeting, which is off | conditional |
| `history.space` | Privacy | "0 visits" in this space | conditional |

## Fixed in this pass

### 1. Privacy: the Windows card could not reach its own host methods

`System.sys.mjs` implemented `windowsReputationManaged()` and
`windowsDiagnosticsSettings()`, and `bindings.ts` generated both calls, but no
route existed, so every call was refused before it reached the module. The card
now reads "Check sites and downloads for phishing and malware..." and the
diagnostics button opens the Windows page.

Routes added in `ui/packages/bridge/src/host-transport.ts`:
`windows_reputation_managed`, `windows_diagnostics_settings`,
`login_item_set`, `login_item_open_settings`, `open_software_update`,
`favicon_probe`.

The last three close the same gap for a hidden row (`login_item_*` answers
`supported: false` on Windows), the About download button, and the zoom list's
icon warm-up.

`tools/windows/system-probe.py` used to pass this defect: it called the host
module directly and looked for `[role=alert]`, while the card writes its failure
into the row description. It now reads `[data-setting="privacy.smartscreen"]`
and fails on "could not read Windows control status", so the route is what is
tested.

### 2. Identity card while Account is off

`SettingsNavigation.svelte` drew the card unconditionally. It is now gated on
`preferences.accountEnabled()`, the same flag `shownSections()` uses. The rail
starts at General and no "Sign in" text renders.

### 3. Spaces: New Space closed Settings

Creating a space switches to it, and a space switch rebuilds the Settings
surface: the page that asked for the editor was gone, and the person landed on
the new space's New Tab. `SpacesPage.create()` now puts the page back in front
and records the new space id in `lib/space-editor-request.svelte.ts`, which
survives the rebuild, so the editor opens on the space that was just made.

The profile-reset effect was also closing the editor on the first profile load;
it now only acts on a real switch.

Verified: click New Space -> Settings stays, dialog reads "Edit Space 2 ... Icon
Color Theme Done", no alert. Reproduced twice.

### 4. Windows forced the download-confirmation policy

`Downloads.sys.mjs` reported `site_downloads_require_confirmation: OS ===
"WINNT"`, which disabled "Ask where to save each file" on Windows for no engine
reason: Firefox honours `browser.download.useDownloadDir` there exactly as it
does elsewhere. The flag is now `false`, the switch is enabled, and flipping it
writes the pref.

## Still open

### F1 - Keyboard: the launcher row has no backend

```
Open the launcher | That action could not be completed. Please try again.
```

This is bigger than a missing route. The launcher is a **separate native panel
window** (`ui/app/panel.html` + `PanelApp.svelte`) that the browser port has
never shipped: the chrome bundle has no `panel.html`, `panel_intent` is
unrouted, no host module creates the window, and `Commands.run` refuses
`launcher.toggle`, which the address field and sidebar search also call.

So the five `launcher_*` commands cannot be routed to anything: there is no
surface for the shortcut to open. Wiring the Settings card alone would make it
report `registered: false`, and its only message for that state is "another app
may be using it", which would be untrue.

The row stays as it is until the launcher surface exists. Two ways to build it:

1. **In-chrome overlay** on the existing search surface (`createSearchSurface`
   + `ResultList`), toggled by `launcher.toggle`, plus a global hotkey so it
   opens from any app. This is the smaller build and reuses the launcher's
   query and run commands (`launcher_search`, `launcher_run`, already routed).
2. **Native panel window** as designed: build `panel.html` into the chrome
   bundle, add a host module that creates/positions/shows the window, route
   `panel_state`/`panel_ready`/`panel_intent`, and register the accelerator.

Either way the copy "Works from any app." only becomes true with an OS-level
hotkey (a Rust `RegisterHotKey` thread in `astra-core`, or an engine patch).

### F6 - dormant unrouted bindings

`work_clear_website_data`, `work_local_servers`, `work_screenshot_sites`,
`work_set_screenshot_site` remain unrouted. Every Work page leaves with the
`work` flag, which is off, so nothing can call them in this build. The Settings
probe fails if a *new* unrouted Settings binding appears.

## Deliberate, not bugs

- **About -> Help says "Coming soon":** `lib/links.ts` stores `url: null` on
  purpose; there is no documentation page yet.
- **About -> Updates off:** dev builds; the row explains it.
- **Extensions empty:** clean throwaway profile.
- **Profiles show `default`, `default-default`, `default-release`:** the probe's
  throwaway profile directory is read as extra profiles; a real profile shows
  one.

## Not covered by this probe

Controls whose effect leaves the app, or needs a real desktop session: the
native folder picker (`downloads.path`), "Show Log Folder", "Reset settings",
default-browser registration, `Manage extensions`, Import browser data, and the
engine-owned dialogs. Those need the headed pass.
