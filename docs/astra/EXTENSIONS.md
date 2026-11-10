# Extensions gallery (P4-T04, X-01)

This page is the **gallery mapping** for the 45 Chrome Web Store ids in the
base catalog. It is not the whole extension platform: real Chrome packages
(CRX3) and Chrome Web Store listings are now a first-class source alongside
signed Firefox XPI. The intake, manifest adaptation, compatibility verdicts,
security policy, install persistence and verification live in
[`EXTENSIONS_COMPAT.md`](EXTENSIONS_COMPAT.md).

The gallery still prefers the same vendor's AMO build because it is signed,
updates through the engine, and is the path with the fewest differences. A
Chrome-only package can be installed from the store listing (Add) or from a
`.crx`/`.zip` file; the review states the verdict and every limitation before
anything is installed.

The base snapshot's UI catalog (`ui/app/src/features/webext/lib/catalog.ts`)
lists 45 unique Chrome Web Store ids (code wins: the README's "20 verified"
claim and PARITY.md's "47" count are both stale). Every one is mapped below.

Machine-readable source: `crates/astra-extensions/gallery.json` (verified
2026-11-02 against the live addons.mozilla.org API v5). The UI mirror
(`ui/app/src/domain/extensions/gallery-data.ts`) is pinned to it by a drift
test (`gallery.test.ts`).

Status meanings: **equivalent** = same (or same-vendor / same-function)
extension on AMO; **alternative** = no same-vendor build, nearest substitute
named; **none** = no Firefox equivalent, reason given.

Coverage: 36 equivalent, 8 alternative, 1 no-equivalent (Google Docs Offline).

| Base extension | Chrome store id | Category | Firefox mapping |
|---|---|---|---|
| LastPass | `hdokiejnpimakedhajhdlcegeplioahd` | passwords | [`lastpass-password-manager`](https://addons.mozilla.org/firefox/addon/lastpass-password-manager/) (equivalent) |
| Bitwarden | `nngceckbapebfimnlniiiahkandclblb` | passwords | [`bitwarden-password-manager`](https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/) (equivalent) |
| 1Password | `aeblfdkhhhdcdjpifhhbdiojplfjncoa` | passwords | [`1password-x-password-manager`](https://addons.mozilla.org/firefox/addon/1password-x-password-manager/) (equivalent) |
| Authenticator | `bhghoamapcdpbohphigoooaddinpkbai` | passwords | [`auth-helper`](https://addons.mozilla.org/firefox/addon/auth-helper/) (equivalent) |
| Dashlane | `fdjamakpfbbddfjaooikfcpapjohcfmg` | passwords | [`dashlane`](https://addons.mozilla.org/firefox/addon/dashlane/) (equivalent) |
| Keeper | `bfogiafebfohielmmehodmfbbebbbpei` | passwords | [`keeper-password-manager`](https://addons.mozilla.org/firefox/addon/keeper-password-manager/) (equivalent) |
| NordPass | `eiaeiblijfjekdanodkjadfinkhbfgcd` | passwords | [`nordpass-password-management`](https://addons.mozilla.org/firefox/addon/nordpass-password-management/) (equivalent) |
| RoboForm | `pnlccmojcmeohlpggmfnbbiapkmbliob` | passwords | [`roboform`](https://addons.mozilla.org/firefox/addon/roboform/) (equivalent) |
| Proton Pass | `ghmbeldphafepmbegfdlkpapadhbakde` | passwords | [`proton-pass`](https://addons.mozilla.org/firefox/addon/proton-pass/) (equivalent) |
| Enpass | `kmcfomidfpdkfieipokbalgegidffkal` | passwords | [`enpass_password_manager`](https://addons.mozilla.org/firefox/addon/enpass_password_manager/) (equivalent) |
| KeePassXC-Browser | `oboonakemofpalcgghocfoadofidjkkk` | passwords | [`keepassxc-browser`](https://addons.mozilla.org/firefox/addon/keepassxc-browser/) (equivalent) |
| Grammarly | `kbfnbcaeplbcioakkpcpgfkobkghlhen` | language | [`grammarly-1`](https://addons.mozilla.org/firefox/addon/grammarly-1/) (equivalent) |
| Google Translate | `aapbdbdomjkkjkaonfhkkikfgjllcleb` | language | [`to-google-translate`](https://addons.mozilla.org/firefox/addon/to-google-translate/) (alternative) |
| Google Dictionary | `mgijmajocgfcbeboacabfgobmjgjcoja` | language | [`google-dictionary-utility-v2`](https://addons.mozilla.org/firefox/addon/google-dictionary-utility-v2/) (alternative) |
| DeepL | `cofdbpoegempjloogbagkncekinflcnj` | language | [`to-deepl`](https://addons.mozilla.org/firefox/addon/to-deepl/) (alternative) |
| LanguageTool | `oldceeleldhonbafppcapldpdifcinji` | language | [`languagetool`](https://addons.mozilla.org/firefox/addon/languagetool/) (equivalent) |
| Dark Reader | `eimadpbcbfnmbkopoojfekhnkhdbieeh` | browsing | [`darkreader`](https://addons.mozilla.org/firefox/addon/darkreader/) (equivalent) |
| OneTab | `chphlpgkkbolifaimnlloiipkdnihall` | browsing | [`onetab`](https://addons.mozilla.org/firefox/addon/onetab/) (equivalent) |
| Wayback Machine | `fpnmgdkabkmnadcjpehmlllkndpkmiak` | browsing | [`wayback-machine_new`](https://addons.mozilla.org/firefox/addon/wayback-machine_new/) (equivalent) |
| Vimium | `dbepggeogbaibhgnhhndojpepiihcmeb` | browsing | [`vimium-ff`](https://addons.mozilla.org/firefox/addon/vimium-ff/) (equivalent) |
| Session Buddy | `edacconmaakjimmfgnblocblbcdcpbko` | browsing | [`tab-session-manager`](https://addons.mozilla.org/firefox/addon/tab-session-manager/) (alternative) |
| Stylus | `clngdbkpkpeebahjckkjfobafhncgmne` | browsing | [`styl-us`](https://addons.mozilla.org/firefox/addon/styl-us/) (equivalent) |
| Video Speed Controller | `nffaoalbilbmmfgbnbgppjihopabppdk` | video | [`videospeed`](https://addons.mozilla.org/firefox/addon/videospeed/) (equivalent) |
| Return YouTube Dislike | `gebbhagfogifgggkldgodflihgfeippi` | video | [`return-youtube-dislikes`](https://addons.mozilla.org/firefox/addon/return-youtube-dislikes/) (equivalent) |
| Enhancer for YouTube | `ponfpcnoihfmfllpaingbgckeeldkhle` | video | [`enhancer-for-youtube`](https://addons.mozilla.org/firefox/addon/enhancer-for-youtube/) (equivalent) |
| SponsorBlock | `mnjggcdmjocbbbhaepdhchncahnbgone` | video | [`sponsorblock`](https://addons.mozilla.org/firefox/addon/sponsorblock/) (equivalent) |
| Unhook | `khncfooichmfjbepaaaebmommgaepoid` | video | [`youtube-recommended-videos`](https://addons.mozilla.org/firefox/addon/youtube-recommended-videos/) (equivalent) |
| Evernote Web Clipper | `pioclpoplcdbaefihamjohnefbikjilc` | saving | [`evernote-web-clipper`](https://addons.mozilla.org/firefox/addon/evernote-web-clipper/) (equivalent) |
| Notion Web Clipper | `knheggckgoiihginacbkhaalnibhilkk` | saving | [`notion-web`](https://addons.mozilla.org/firefox/addon/notion-web/) (equivalent) |
| Raindrop.io | `ldgfbffkinooeloadekpmfoklnobpien` | saving | [`raindropio`](https://addons.mozilla.org/firefox/addon/raindropio/) (equivalent) |
| Zotero Connector | `ekhagklcjbdpajgpjgmbionohlpdbjgc` | saving | [`zotero-connector`](https://addons.mozilla.org/firefox/addon/zotero-connector/) (equivalent) |
| Hypothesis | `bjfhmglciegochdpefhhlphglcehbmek` | saving | [`unofficial-hypothesis`](https://addons.mozilla.org/firefox/addon/unofficial-hypothesis/) (alternative) |
| Google Docs Offline | `ghbmnnjooekpmoecnnnilnnbdlolhkhi` | productivity | none — No equivalent: Google Docs Offline is Chrome-only (it relies on Chrome's bundled Docs offline runtime). Google Docs itself works online in Firefox; there is no offline-docs extension on AMO. |
| Loom | `liecbddmkiiihnedobmlmillhodjkdmb` | productivity | [`screenshot-capture-annotate`](https://addons.mozilla.org/firefox/addon/screenshot-capture-annotate/) (alternative) |
| Todoist | `jldhpllghnbhlbpcmnajkpdmadaolakh` | productivity | [`todoist`](https://addons.mozilla.org/firefox/addon/todoist/) (equivalent) |
| Simplify Gmail | `pbmlfaiicoikhdbjagjbglnbfcbcojpj` | productivity | [`simplifygmail`](https://addons.mozilla.org/firefox/addon/simplifygmail/) (alternative) |
| Tampermonkey | `dhdgffkkebhmkfjojejmpbldmpobfkfo` | developers | [`tampermonkey`](https://addons.mozilla.org/firefox/addon/tampermonkey/) (equivalent) |
| React Developer Tools | `fmkadmapgofadopljbjfkapdkoienihi` | developers | [`react-devtools`](https://addons.mozilla.org/firefox/addon/react-devtools/) (equivalent) |
| ColorZilla | `bhlhnicpbhignbdhedgjhgdocnmhomnp` | developers | [`colorzilla`](https://addons.mozilla.org/firefox/addon/colorzilla/) (equivalent) |
| JSON Formatter | `bcjindcccaagfpapjjmafapmmgkkhgoa` | developers | [`json_formatter`](https://addons.mozilla.org/firefox/addon/json_formatter/) (alternative) |
| Wappalyzer | `gppongmhjkpfnbhagpmjfkannfbllamg` | developers | [`wappalyzer`](https://addons.mozilla.org/firefox/addon/wappalyzer/) (equivalent) |
| Vue.js devtools | `nhdogjmejiglipccpnnnanhbledajbpd` | developers | [`vue-js-devtools`](https://addons.mozilla.org/firefox/addon/vue-js-devtools/) (equivalent) |
| Violentmonkey | `jinjaccalgkegednnccohejagnlnfdag` | developers | [`violentmonkey`](https://addons.mozilla.org/firefox/addon/violentmonkey/) (equivalent) |
| Octotree | `bkhaagjahfmjljalopjnoealnfndnagc` | developers | [`octotree`](https://addons.mozilla.org/firefox/addon/octotree/) (equivalent) |
| Refined GitHub | `hlepfoohegkhhmjieoechaddaejaokhf` | developers | [`refined-github-`](https://addons.mozilla.org/firefox/addon/refined-github-/) (equivalent) |

## Verification

Each equivalent/alternative slug was confirmed on 2026-11-02 via the AMO
API v5: direct `/addons/addon/<slug>/` returning a public listing, or
`/addons/search/` ranking the official build first (user counts quoted in
`gallery.json` notes are from the same responses). Rerun any time with the
explicitly-marked opt-in script (network; never in CI):

```
crates/astra-extensions/tests/amo_live_optin.sh
```

44/44 gallery URLs returned HTTP 200 on 2026-11-02; Google Docs Offline is
correctly excluded (status `none`).

## Manager model

`crates/astra-extensions` (`ExtensionManager`): install (disabled by
default), enable/disable, pin, site access, uninstall. Permission prompts
are queued from Host API `Dialogs` `permission.requested` event payloads
(P3-T09) and answered with a `Decision` the caller forwards through
`Dialogs.decidePermission` — read-only usage, the manager never resolves a
dialog itself. Offline smoke coverage: `tests/gallery_smoke.rs` runs the
install/enable/disable/permission flow per gallery entry.

## UI

The sidebar's utility bar carries the Extensions control: its menu offers
Manage extensions, the Chrome Web Store, Firefox Add-ons and install-from-file.
The manager page offers the two stores side by side, install-from-file, the installed list with its on/off switch,
pin, site access, extension settings and an Open control that runs the
extension's own action popup. Nothing in that path opens Firefox's add-ons
manager or settings.

When the engine raises an install permission prompt (for example from an AMO
listing), Astra replaces the engine doorhanger with its own sheet: the same
required permissions, the data-collection disclosure and the two optional
install choices, answered through `web_extension_answer_prompt`. A review that
already listed the package's permissions answers the engine prompt silently
with the choices made in the review.

- Domain: `ui/app/src/domain/extensions/gallery.ts` (types + helpers),
  `gallery-data.ts` (mirrored data), `extension-permissions.ts` (prompt
  queue fed by `permission.requested` events), each with unit tests.
- Gallery UI: `ui/app/src/features/extensions/gallery/` — `GalleryList`
  (grouped list with status badges + AMO install buttons),
  `GalleryDetail` (mapping note + install), `GalleryPermissionPrompt`
  (renders one pending prompt; Allow/Deny only calls back — the host
  forwards the decision via `Dialogs.decidePermission`).
- Enable/disable, pin, open, options and site access live on the manager's
  `ExtensionRow`; the gallery handles discovery + install.
- `WebExtensionManager` remains the install page. Its review lists the real
  package permissions and optional choices; a package whose engine prompt
  arrives without advance details is confirmed in
  `WebExtensionInstallPrompt` instead.

Gallery buttons open the AMO listing (or the Chrome listing for `none`
entries) in a tab.
