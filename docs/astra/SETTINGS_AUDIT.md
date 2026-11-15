# Settings audit — Windows dev build

What every Settings surface does in the running build, checked live rather than
read off the source. **Verified 2026-11-15** against

```
engine/obj-astra-windows/dist/bin/firefox.exe
Astra 0.1.745 · Windows_NT 10.0 · x86_64
```

The staged build matches `windows-port` at 348b85b5: the shell bundle, the app
bundle and `mozilla.cfg` in `dist/bin` are the current overlay outputs, and
ASTRA-0017..0019 reverse-check clean against `engine/`.

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
105 passed, 0 failed   (14 pages × 3 page checks + 20 rows × 3 + wiring)
```

Machine-readable output: `out/settings-probe.json` (`pages`, `representative`,
`observations`, `wiring`).

## The chart

`✅` working and exercised live · `◐` works, one control disabled for a real
state reason · `✗` a control in the group is broken.

| # | Page | Rows | Disabled | Live check that passed | Verdict |
|---|---|---|---|---|---|
| 1 | General | 9 | 1 | startup select → `tabs.startup=new-tab` | ✅ |
| 2 | Appearance | 15 | 1 | mode → `appearance=dark`, theme → `ui.theme=paper`, density → `ui.density=compact` | ✅ |
| 3 | Tabs | 31 | 0 | `tabs.duplicates`, `split.enabled` flip and persist | ✅ |
| 4 | New Tab | 10 | 1 | `ntp.wordmark`, `ntp.clock` flip and persist | ◐ |
| 5 | Search | 4 | 0 | `search.suggestions` flips and persists | ✅ |
| 6 | Extensions | 2 | 0 | `extensions.per-space` flips and persists | ✅ (empty: none installed) |
| 7 | Privacy & security | 9 | 2 | `privacy.blocking` flips the blocker, `privacy.drm`, `history.scope` | ✗ Windows card |
| 8 | Time & focus | 5 | 0 | `focus.breaks`, `time.track` flip and persist | ✅ |
| 9 | Performance | 4 | 0 | `performance.sleep`, `performance.memory` → `save-memory` | ✅ |
| 10 | Profiles | 4 rows (custom) | – | New Profile opens Name/Photo/Colour/Create | ✅ |
| 11 | Spaces | 1 space (custom) | – | Edit opens the space editor | ✗ New Space |
| 12 | Features | 3 | 0 | `notes.enabled`, `tasks.enabled` flip and persist | ✅ |
| 13 | Keyboard & accessibility | 81 | 0 | Ctrl+Shift+Y captured on a keymap row → Save/Cancel | ✗ launcher |
| 14 | About | 3 | 0 | Copy Diagnostics expands the report | ✅ (updates dev-gated) |
| — | Identity card | – | – | click stays on General | ✗ |

**Totals:** 14 pages, 176 setting rows, 5 disabled rows, 0 page alerts, 0
`unknown_command` console errors on any page.

## Row-level detail

### Working end to end

| Row | Verified |
|---|---|
| `general.startup` | select → `tabs.startup` = `new-tab`, label follows |
| `general.home`, `downloads.path` | real values (empty home, `C:\Users\Rem\Downloads`) |
| `general.export` | two buttons rendered |
| `appearance.theme`, `appearance.palette` | `appearance=dark`, `ui.theme=paper` written through the host |
| `appearance.contrast` | slider renders with value 50 |
| `appearance.density` | select → `ui.density=compact` |
| `appearance.motion` | switch flips, persists |
| 31 Tabs rows | `tabs.duplicates` → `tabs.switch-to-open=false`; `split.enabled=false` |
| 10 New Tab rows except `ntp.personalize` | `ntp.wordmark`, `ntp.clock` flip and persist |
| 4 Search rows | suggestions switch persists |
| Extensions | per-space switch persists; honest "No extensions installed" |
| Privacy | blocking switch flips the live blocker (`Protection is off for this profile.`), DRM, history scope → `profile` |
| Time & focus | breaks + tracking switches persist |
| Performance | sleep switch, memory select → `save-memory` |
| Profiles | 4 real profiles; New Profile dialog: Name / Choose Photo / Color / Create |
| Spaces | 1 real space; Edit → "Edit Space" (Icon / Color / Theme / Done) |
| Features | notes + tasks switches, with honest "Off. Your notes are kept." |
| Keyboard | all 80 keymap rows; rebinding captures the key and offers Save/Cancel |
| About | version, platform, Copy Diagnostics expands to "Hide | Copy Diagnostics" |
| Blocker | 6/14 ads, 3/19 optional, 2/2 malware, 3/3 trackers, 0/43 regional lists |

### Disabled rows, and why

| Row | Page | Reason | Class |
|---|---|---|---|
| `privacy.smartscreen` | Privacy | "Could not read Windows control status." — the host method works, its route does not exist | **broken** |
| `downloads.ask` | General | Host hardcodes `site_downloads_require_confirmation` = true on `WINNT` (`Downloads.sys.mjs:339`) | decision needed |
| `appearance.zoom-levels` | Appearance | No site has been zoomed in this profile | conditional |
| `ntp.personalize` | New Tab | Depends on the greeting, which is off | conditional |
| `history.space` | Privacy | "0 visits" in this space | conditional |
| `general.default` | General | "Available once Astra is installed." (status row, no control) | conditional |

## Findings

### F1 — Keyboard: the launcher row is unwired (broken)

```
Open the launcher | That action could not be completed. Please try again.
```

`launcher_trigger` is called on mount. It is in the wire baseline's **unrouted**
list, and `host-transport.ts` routes only `launcher_search` and `launcher_run`.
No host module implements it, so the row's read fails and the card renders its
failure text. `launcher_set_shortcut`, `launcher_record_shortcut`,
`launcher_set_double_tap` and `launcher_open_accessibility` are unrouted too, so
recording and resetting a shortcut would fail the same way. The other 80 rows on
the page work.

Evidence: `out/settings-probe.log`, `observations.launcher`.

### F2 — Privacy: the Windows card cannot reach its own host methods (broken)

```
Microsoft Defender SmartScreen | Could not read Windows control status. Reopen Settings to retry.
Windows diagnostic settings            →  Could not open Windows diagnostic settings
```

`System.sys.mjs` implements both `windowsReputationManaged()` (answers `false`
live) and `windowsDiagnosticsSettings()`, and `bindings.ts` generates both
calls — but neither wire name is in the route table, so every call is refused
before it reaches the module. The card's own "retry" advice cannot help.

Evidence: `observations.smartscreen`, `observations.reputation`
(`{"reputation":false}` when called directly on the host).

**Why `tools/windows/system-probe.py` still passes:** it calls
`Services.astraHost.System.windowsReputationManaged()` directly, and its lookup
for a route error is `[role=alert]`. The card writes its failure into the row's
description, so the probe never sees it. A route-level check has to click the
button or read the row text.

### F3 — Identity card renders while Account is off (broken)

`SettingsNavigation.svelte` renders `<SettingsIdentity />` unconditionally and
`flags.account` is off, so the rail shows "Sign in / Your plan and devices", but
the `account` section is filtered out of `shownSections()`. Clicking the card
does nothing (measured: heading `General` before and after). The card is a
control that cannot go anywhere.

### F4 — Spaces: New Space closes Settings (broken flow)

"Edit" on a space opens the editor properly. "New Space" creates the space
(sidebar then shows `Space 2` and it becomes active), **Settings closes**, and
the editor sheet the code opens after `create()` never lands — the user is
dropped on the new space's new tab with an empty dialog left behind. Reproduced
twice. `SpacesPage.create()` awaits `tabs.createSpace`, which switches space;
the switch tears down the Settings surface before `edit(created, true)` runs.

### F5 — Windows disables the download-confirmation choice (decision)

`Downloads.sys.mjs:339` sets `site_downloads_require_confirmation` from
`appinfo.OS === "WINNT"`, so on Windows "Ask where to save each file" is always
on and the switch is always disabled. That is a host policy, not an OS fact:
Firefox's own `browser.download.useDownloadDir` remains user-controlled on
Windows. Either the assumption is wrong or a decision should say why Windows
loses the choice.

### F6 — 15 Settings bindings have no host route

Cross-check of every `commands.*` call under `ui/app/src/features/settings`
against `host-transport.ts`:

| Binding | Wire | Visible today |
|---|---|---|
| `launcherTrigger`, `launcherSetShortcut`, `launcherRecordShortcut`, `launcherSetDoubleTap`, `launcherOpenAccessibility` | `launcher_*` | yes (F1) |
| `windowsReputationManaged`, `windowsDiagnosticsSettings` | `windows_*` | yes (F2) |
| `openSoftwareUpdate` | `open_software_update` | no — updates are off in dev builds |
| `loginItemSet`, `loginItemOpenSettings` | `login_item_*` | no — `loginItemStatus` answers `supported: false` on Windows |
| `faviconProbe` | `favicon_probe` | no — Zoom levels is empty, Sites is not in the nav |
| `workClearWebsiteData`, `workLocalServers`, `workScreenshotSites`, `workSetScreenshotSite` | `work_*` | no — Work flag is off |

The probe fails the run if a *new* unrouted Settings binding appears, so this
list cannot grow silently.

## Deliberate, not bugs

- **About → Help says "Coming soon":** `lib/links.ts` stores `url: null` on
  purpose; there is no documentation page yet. Website/GitLab/Discord/X open.
- **About → Updates off:** dev builds; the row explains it.
- **Extensions empty:** clean throwaway profile.
- **Profiles show `default`, `default-default`, `default-release`:** the probe's
  throwaway profile directory is read as extra profiles; a real profile shows
  one. Not a Settings defect.

## Not covered by this probe

Controls whose effect leaves the app, or needs a real desktop session: the
native folder picker (`downloads.path`), "Show Log Folder", "Reset settings",
default-browser registration, `Manage extensions` (opens the extensions
surface), Import browser data (no source browser on the throwaway profile), and
the engine-owned dialogs. Those need the headed pass, not this audit.

## Next

1. Route `windows_reputation_managed` and `windows_diagnostics_settings` in
   `host-transport.ts` → removes F2 and makes the card read `false` (not
   managed) instead of failing.
2. Implement the launcher trigger in the host (state + accelerator + double-tap)
   and route the four launcher commands → removes F1.
3. Gate the identity card on `flags.account` → removes F3.
4. Keep Settings open across a space create (or open the editor in the new
   space's stack) → removes F4.
5. Decide F5, then either keep the disabled row with a decision entry or expose
   the switch.
