/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mirrored from crates/astra-extensions/gallery.json (P4-T04).
// Do not hand-edit: the gallery.test.ts drift test diffs this list
// against gallery.json. Regenerate from gallery.json when it changes.
import type { GalleryEntry } from "./gallery";

export const GALLERY: GalleryEntry[] = [
  {
    chromeStoreId: "hdokiejnpimakedhajhdlcegeplioahd",
    name: "LastPass",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "lastpass-password-manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/lastpass-password-manager/",
      note: "Official LastPass build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "nngceckbapebfimnlniiiahkandclblb",
    name: "Bitwarden",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "bitwarden-password-manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/bitwarden-password-manager/",
      note: "Official Bitwarden build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
    name: "1Password",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "1password-x-password-manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/1password-x-password-manager/",
      note: "Official 1Password build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "bhghoamapcdpbohphigoooaddinpkbai",
    name: "Authenticator",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "auth-helper",
      amoUrl: "https://addons.mozilla.org/firefox/addon/auth-helper/",
      note: "Functional equivalent: the Chrome original (authenticator.cc) ships no Firefox build; auth-helper ('Authenticator', ~160k users) is the established TOTP equivalent on AMO.",
    },
  },
  {
    chromeStoreId: "fdjamakpfbbddfjaooikfcpapjohcfmg",
    name: "Dashlane",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "dashlane",
      amoUrl: "https://addons.mozilla.org/firefox/addon/dashlane/",
      note: "Official Dashlane build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "bfogiafebfohielmmehodmfbbebbbpei",
    name: "Keeper",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "keeper-password-manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/keeper-password-manager/",
      note: "Official Keeper build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "eiaeiblijfjekdanodkjadfinkhbfgcd",
    name: "NordPass",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "nordpass-password-management",
      amoUrl: "https://addons.mozilla.org/firefox/addon/nordpass-password-management/",
      note: "Official NordPass build ('NordPass Password Manager & Digital Vault'), confirmed via AMO search.",
    },
  },
  {
    chromeStoreId: "pnlccmojcmeohlpggmfnbbiapkmbliob",
    name: "RoboForm",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "roboform",
      amoUrl: "https://addons.mozilla.org/firefox/addon/roboform/",
      note: "Official RoboForm build ('RoboForm Password Manager', ~54k users), confirmed via AMO search.",
    },
  },
  {
    chromeStoreId: "ghmbeldphafepmbegfdlkpapadhbakde",
    name: "Proton Pass",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "proton-pass",
      amoUrl: "https://addons.mozilla.org/firefox/addon/proton-pass/",
      note: "Official Proton build (author 'Proton'), public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "kmcfomidfpdkfieipokbalgegidffkal",
    name: "Enpass",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "enpass_password_manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/enpass_password_manager/",
      note: "Official Enpass build ('Enpass Password Manager'), public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "oboonakemofpalcgghocfoadofidjkkk",
    name: "KeePassXC-Browser",
    category: "passwords",
    firefox: {
      status: "equivalent",
      slug: "keepassxc-browser",
      amoUrl: "https://addons.mozilla.org/firefox/addon/keepassxc-browser/",
      note: "Official KeePassXC-Browser build (~151k users), confirmed via AMO search.",
    },
  },
  {
    chromeStoreId: "kbfnbcaeplbcioakkpcpgfkobkghlhen",
    name: "Grammarly",
    category: "language",
    firefox: {
      status: "equivalent",
      slug: "grammarly-1",
      amoUrl: "https://addons.mozilla.org/firefox/addon/grammarly-1/",
      note: "Official Grammarly build ('Grammarly: AI Writing and Grammar Checker App'), confirmed via AMO search.",
    },
  },
  {
    chromeStoreId: "aapbdbdomjkkjkaonfhkkikfgjllcleb",
    name: "Google Translate",
    category: "language",
    firefox: {
      status: "alternative",
      slug: "to-google-translate",
      amoUrl: "https://addons.mozilla.org/firefox/addon/to-google-translate/",
      note: "Google ships no official Translate extension for Firefox (Chrome-only). Nearest substitutes on AMO: To Google Translate, Simple Translate (simple-translate), TWP - Translate Web Pages (traduzir-paginas-web).",
    },
  },
  {
    chromeStoreId: "mgijmajocgfcbeboacabfgobmjgjcoja",
    name: "Google Dictionary",
    category: "language",
    firefox: {
      status: "alternative",
      slug: "google-dictionary-utility-v2",
      amoUrl: "https://addons.mozilla.org/firefox/addon/google-dictionary-utility-v2/",
      note: "Google's dictionary extension is Chrome-only. Nearest substitute on AMO: Google Dictionary Utility V2 (community); verify publisher before recommending.",
    },
  },
  {
    chromeStoreId: "cofdbpoegempjloogbagkncekinflcnj",
    name: "DeepL",
    category: "language",
    firefox: {
      status: "alternative",
      slug: "to-deepl",
      amoUrl: "https://addons.mozilla.org/firefox/addon/to-deepl/",
      note: "No official DeepL Firefox build found on AMO. Nearest substitute: To DeepL translation (to-deepl).",
    },
  },
  {
    chromeStoreId: "oldceeleldhonbafppcapldpdifcinji",
    name: "LanguageTool",
    category: "language",
    firefox: {
      status: "equivalent",
      slug: "languagetool",
      amoUrl: "https://addons.mozilla.org/firefox/addon/languagetool/",
      note: "Official LanguageTool build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "eimadpbcbfnmbkopoojfekhnkhdbieeh",
    name: "Dark Reader",
    category: "browsing",
    firefox: {
      status: "equivalent",
      slug: "darkreader",
      amoUrl: "https://addons.mozilla.org/firefox/addon/darkreader/",
      note: "Official Dark Reader build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "chphlpgkkbolifaimnlloiipkdnihall",
    name: "OneTab",
    category: "browsing",
    firefox: {
      status: "equivalent",
      slug: "onetab",
      amoUrl: "https://addons.mozilla.org/firefox/addon/onetab/",
      note: "Official OneTab build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "fpnmgdkabkmnadcjpehmlllkndpkmiak",
    name: "Wayback Machine",
    category: "browsing",
    firefox: {
      status: "equivalent",
      slug: "wayback-machine_new",
      amoUrl: "https://addons.mozilla.org/firefox/addon/wayback-machine_new/",
      note: "Official Internet Archive build ('Wayback Machine', ~39k users). Note the underscore in the AMO slug.",
    },
  },
  {
    chromeStoreId: "dbepggeogbaibhgnhhndojpepiihcmeb",
    name: "Vimium",
    category: "browsing",
    firefox: {
      status: "equivalent",
      slug: "vimium-ff",
      amoUrl: "https://addons.mozilla.org/firefox/addon/vimium-ff/",
      note: "Same-author Firefox port (vimium-ff), public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "edacconmaakjimmfgnblocblbcdcpbko",
    name: "Session Buddy",
    category: "browsing",
    firefox: {
      status: "alternative",
      slug: "tab-session-manager",
      amoUrl: "https://addons.mozilla.org/firefox/addon/tab-session-manager/",
      note: "Session Buddy is Chromium-only with no Firefox build. Nearest substitute: Tab Session Manager (~172k users); TabGroup Vault explicitly markets itself as a Session Buddy alternative.",
    },
  },
  {
    chromeStoreId: "clngdbkpkpeebahjckkjfobafhncgmne",
    name: "Stylus",
    category: "browsing",
    firefox: {
      status: "equivalent",
      slug: "styl-us",
      amoUrl: "https://addons.mozilla.org/firefox/addon/styl-us/",
      note: "Official Stylus build (styl-us), public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "nffaoalbilbmmfgbnbgppjihopabppdk",
    name: "Video Speed Controller",
    category: "video",
    firefox: {
      status: "equivalent",
      slug: "videospeed",
      amoUrl: "https://addons.mozilla.org/firefox/addon/videospeed/",
      note: "Firefox port of Video Speed Controller, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "gebbhagfogifgggkldgodflihgfeippi",
    name: "Return YouTube Dislike",
    category: "video",
    firefox: {
      status: "equivalent",
      slug: "return-youtube-dislikes",
      amoUrl: "https://addons.mozilla.org/firefox/addon/return-youtube-dislikes/",
      note: "Official build ('Return YouTube Dislike', ~895k users), confirmed via AMO search. Slug is plural (dislikes).",
    },
  },
  {
    chromeStoreId: "ponfpcnoihfmfllpaingbgckeeldkhle",
    name: "Enhancer for YouTube",
    category: "video",
    firefox: {
      status: "equivalent",
      slug: "enhancer-for-youtube",
      amoUrl: "https://addons.mozilla.org/firefox/addon/enhancer-for-youtube/",
      note: "Same-author Firefox build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "mnjggcdmjocbbbhaepdhchncahnbgone",
    name: "SponsorBlock",
    category: "video",
    firefox: {
      status: "equivalent",
      slug: "sponsorblock",
      amoUrl: "https://addons.mozilla.org/firefox/addon/sponsorblock/",
      note: "Official SponsorBlock build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "khncfooichmfjbepaaaebmommgaepoid",
    name: "Unhook",
    category: "video",
    firefox: {
      status: "equivalent",
      slug: "youtube-recommended-videos",
      amoUrl: "https://addons.mozilla.org/firefox/addon/youtube-recommended-videos/",
      note: "Same extension on AMO as 'Unhook: Remove YouTube Recommended Videos Comments' (~171k users), confirmed via AMO search.",
    },
  },
  {
    chromeStoreId: "pioclpoplcdbaefihamjohnefbikjilc",
    name: "Evernote Web Clipper",
    category: "saving",
    firefox: {
      status: "equivalent",
      slug: "evernote-web-clipper",
      amoUrl: "https://addons.mozilla.org/firefox/addon/evernote-web-clipper/",
      note: "Official Evernote build (author evernote-corp, ~56k users), public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "knheggckgoiihginacbkhaalnibhilkk",
    name: "Notion Web Clipper",
    category: "saving",
    firefox: {
      status: "equivalent",
      slug: "notion-web",
      amoUrl: "https://addons.mozilla.org/firefox/addon/notion-web/",
      note: "'Notion Web Clipper' on AMO with a small user base; verify the publisher is Notion Labs before recommending, and re-check at install time.",
    },
  },
  {
    chromeStoreId: "ldgfbffkinooeloadekpmfoklnobpien",
    name: "Raindrop.io",
    category: "saving",
    firefox: {
      status: "equivalent",
      slug: "raindropio",
      amoUrl: "https://addons.mozilla.org/firefox/addon/raindropio/",
      note: "Official Raindrop.io build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "ekhagklcjbdpajgpjgmbionohlpdbjgc",
    name: "Zotero Connector",
    category: "saving",
    firefox: {
      status: "equivalent",
      slug: "zotero-connector",
      amoUrl: "https://addons.mozilla.org/firefox/addon/zotero-connector/",
      note: "Official Zotero build (slug exists on AMO; also linked from zotero.org download page).",
    },
  },
  {
    chromeStoreId: "bjfhmglciegochdpefhhlphglcehbmek",
    name: "Hypothesis",
    category: "saving",
    firefox: {
      status: "alternative",
      slug: "unofficial-hypothesis",
      amoUrl: "https://addons.mozilla.org/firefox/addon/unofficial-hypothesis/",
      note: "Hypothes.is ships no official Firefox build. Nearest substitute: Unofficial Hypothesis extension (community port); verify publisher before recommending.",
    },
  },
  {
    chromeStoreId: "ghbmnnjooekpmoecnnnilnnbdlolhkhi",
    name: "Google Docs Offline",
    category: "productivity",
    firefox: {
      status: "none",
      slug: null,
      amoUrl: null,
      note: "No equivalent: Google Docs Offline is Chrome-only (it relies on Chrome's bundled Docs offline runtime). Google Docs itself works online in Firefox; there is no offline-docs extension on AMO.",
    },
  },
  {
    chromeStoreId: "liecbddmkiiihnedobmlmillhodjkdmb",
    name: "Loom",
    category: "productivity",
    firefox: {
      status: "alternative",
      slug: "screenshot-capture-annotate",
      amoUrl: "https://addons.mozilla.org/firefox/addon/screenshot-capture-annotate/",
      note: "No official Loom Firefox build on AMO (the 'loom' slug is an inactive low-user listing). Nearest substitute: Awesome Screenshot & Screen Recorder (~131k users).",
    },
  },
  {
    chromeStoreId: "jldhpllghnbhlbpcmnajkpdmadaolakh",
    name: "Todoist",
    category: "productivity",
    firefox: {
      status: "equivalent",
      slug: "todoist",
      amoUrl: "https://addons.mozilla.org/firefox/addon/todoist/",
      note: "'Todoist for Firefox' (~13k users) on AMO; confirm the Doist publisher at install time as routine hygiene.",
    },
  },
  {
    chromeStoreId: "pbmlfaiicoikhdbjagjbglnbfcbcojpj",
    name: "Simplify Gmail",
    category: "productivity",
    firefox: {
      status: "alternative",
      slug: "simplifygmail",
      amoUrl: "https://addons.mozilla.org/firefox/addon/simplifygmail/",
      note: "Simplify Gmail is Chromium-only upstream. Community port 'Simplify Gmail' (simplifygmail, small user base) exists on AMO; verify publisher before recommending.",
    },
  },
  {
    chromeStoreId: "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    name: "Tampermonkey",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "tampermonkey",
      amoUrl: "https://addons.mozilla.org/firefox/addon/tampermonkey/",
      note: "Official Tampermonkey build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "fmkadmapgofadopljbjfkapdkoienihi",
    name: "React Developer Tools",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "react-devtools",
      amoUrl: "https://addons.mozilla.org/firefox/addon/react-devtools/",
      note: "Official React Developer Tools build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "bhlhnicpbhignbdhedgjhgdocnmhomnp",
    name: "ColorZilla",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "colorzilla",
      amoUrl: "https://addons.mozilla.org/firefox/addon/colorzilla/",
      note: "Official ColorZilla build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "bcjindcccaagfpapjjmafapmmgkkhgoa",
    name: "JSON Formatter",
    category: "developers",
    firefox: {
      status: "alternative",
      slug: "json_formatter",
      amoUrl: "https://addons.mozilla.org/firefox/addon/json_formatter/",
      note: "The Chrome 'JSON Formatter' is Chrome-only. Nearest substitutes: JSON Formatter (json_formatter) or JSON Formatter (json-formatter-ff) on AMO.",
    },
  },
  {
    chromeStoreId: "gppongmhjkpfnbhagpmjfkannfbllamg",
    name: "Wappalyzer",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "wappalyzer",
      amoUrl: "https://addons.mozilla.org/firefox/addon/wappalyzer/",
      note: "Official Wappalyzer build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "nhdogjmejiglipccpnnnanhbledajbpd",
    name: "Vue.js devtools",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "vue-js-devtools",
      amoUrl: "https://addons.mozilla.org/firefox/addon/vue-js-devtools/",
      note: "Official Vue.js devtools build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "jinjaccalgkegednnccohejagnlnfdag",
    name: "Violentmonkey",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "violentmonkey",
      amoUrl: "https://addons.mozilla.org/firefox/addon/violentmonkey/",
      note: "Official Violentmonkey build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "bkhaagjahfmjljalopjnoealnfndnagc",
    name: "Octotree",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "octotree",
      amoUrl: "https://addons.mozilla.org/firefox/addon/octotree/",
      note: "Official Octotree build, public AMO listing confirmed.",
    },
  },
  {
    chromeStoreId: "hlepfoohegkhhmjieoechaddaejaokhf",
    name: "Refined GitHub",
    category: "developers",
    firefox: {
      status: "equivalent",
      slug: "refined-github-",
      amoUrl: "https://addons.mozilla.org/firefox/addon/refined-github-/",
      note: "Official Refined GitHub build ('Refined GitHub', ~10k users). Note the trailing hyphen in the AMO slug.",
    },
  },
];
