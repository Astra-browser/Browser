# Real extension corpus — 2026-11-08

55 packages acquired from the Chrome Web Store update service (the same CRX3
files Chrome receives) and driven through Astra’s own intake: inspect, install,
engine registration, active state, background state, content scripts, DNR,
permissions, then uninstall. Every package was uninstalled between runs and
each batch used a fresh profile. No package was blocked by the security scan.

| Package | MV | Verdict | Security | Background | Content scripts | DNR | Works |
|---|---:|---|---|---|---:|---:|---|
| __MSG_name_releasebuild__ | 3 | limited | medium | scripts (running) | 13 | 36 | yes |
| __MSG_name__ | 3 | adapted | none | scripts (running) | 5 | 53 | yes |
| __MSG_extName__ | 3 | adapted | low | scripts (running) | 0 | 0 | yes |
| axe DevTools - Web Accessibility Testing | 3 | limited | medium | scripts (running) | 1 | 0 | yes |
| Capital One Shopping: Save Now | 3 | limited | medium | scripts (running) | 5 | 0 | yes |
| ColorZilla | 3 | limited | medium | scripts (running) | 0 | 0 | yes |
| Dark Reader | 3 | limited | low | scripts (running) | 3 | 0 | yes |
| __MSG_ExtensionName__ | 3 | adapted | medium | scripts (running) | 6 | 0 | yes |
| Decentraleyes | 3 | adapted | low | scripts (running) | 0 | 5 | yes |
| __MSG_appName__ | 3 | limited | medium | scripts (running) | 1 | 1 | yes |
| Enhancer for YouTube™ | 3 | adapted | medium | scripts (running) | 8 | 0 | yes |
| Enpass Password Manager | 3 | adapted | medium | scripts (running) | 2 | 0 | yes |
| __MSG_ExtensionName__ | 3 | adapted | medium | scripts (running) | 2 | 0 | yes |
| Google Dictionary (by Google) | 3 | adapted | low | scripts (running) | 1 | 0 | yes |
| __MSG_extName__ | 3 | limited | low | scripts (running) | 0 | 0 | yes |
| __MSG_8969005060131950570__ | 3 | limited | medium | scripts (running) | 1 | 0 | yes |
| Grammarly: AI Writing Assistant and Grammar Checker App | 3 | adapted | low | scripts (running) | 11 | 0 | yes |
| __MSG_Honey_Title__ | 3 | limited | medium | scripts (running) | 1 | 0 | yes |
| Hypothesis - Web & PDF Annotation | 3 | limited | medium | scripts (running) | 0 | 0 | yes |
| JSON Formatter | 3 | full | none | none | 2 | 0 | yes |
| KeePassXC-Browser | 3 | limited | medium | scripts (running) | 2 | 0 | yes |
| __MSG_appName__ | 3 | adapted | low | scripts (running) | 7 | 0 | yes |
| LastPass: Free Password Manager | 3 | adapted | medium | scripts (running) | 4 | 0 | yes |
| Lighthouse | 3 | full | none | none | 0 | 0 | yes |
| Loom – Screen Recorder & Screen Capture | 3 | adapted | medium | scripts (running) | 5 | 0 | yes |
| Momentum | 3 | limited | low | scripts (running) | 1 | 0 | yes |
| __MSG_extName__ | 3 | limited | low | scripts (running) | 5 | 0 | yes |
| __MSG_webClipperExtension_name__ | 3 | adapted | medium | scripts (running) | 0 | 0 | yes |
| Octotree - GitHub code tree | 3 | adapted | medium | scripts (running) | 1 | 0 | yes |
| OneTab | 3 | limited | low | scripts (running) | 0 | 0 | yes |
| __MSG_name__ | 3 | adapted | low | scripts (running) | 4 | 4 | yes |
| Proton Pass: Free Password Manager | 3 | adapted | medium | scripts (running) | 2 | 0 | yes |
| Raindrop.io | 3 | adapted | medium | scripts (running) | 0 | 0 | yes |
| __MSG_extensionName__ | 3 | limited | medium | scripts (running) | 1 | 0 | yes |
| React Developer Tools | 3 | adapted | medium | scripts (running) | 1 | 0 | yes |
| Redux DevTools | 3 | adapted | low | scripts (running) | 2 | 0 | yes |
| __MSG_extensionName__ | 3 | limited | low | scripts (running) | 1 | 0 | yes |
| __MSG_BEM_FullName__ | 3 | limited | medium | scripts (running) | 2 | 0 | yes |
| Session Buddy - Tab & Bookmark Manager | 3 | adapted | medium | scripts (running) | 0 | 0 | yes |
| Simplify Gmail | 3 | limited | low | scripts (running) | 1 | 1 | yes |
| __MSG_fullName__ | 3 | adapted | low | scripts (running) | 2 | 0 | yes |
| Stylus | 3 | limited | medium | scripts (running) | 5 | 0 | yes |
| __MSG_extName__ | 3 | adapted | medium | scripts (running) | 0 | 0 | yes |
| Toby: Tab Manager & Session Saver | 3 | adapted | low | scripts (running) | 1 | 0 | yes |
| __MSG_appName__ | 3 | adapted | low | scripts (running) | 3 | 0 | yes |
| __MSG_extName__ | 3 | limited | medium | scripts (running) | 0 | 56 | yes |
| Unhook - Remove YouTube Recommended & Shorts | 3 | adapted | low | scripts (running) | 1 | 0 | yes |
| Video Speed Controller | 3 | adapted | low | scripts (running) | 2 | 0 | yes |
| Vimium | 3 | limited | medium | scripts (running) | 2 | 0 | yes |
| Vue.js devtools | 3 | adapted | low | scripts (running) | 2 | 0 | yes |
| Wappalyzer - Technology profiler | 3 | adapted | medium | scripts (running) | 1 | 0 | yes |
| Wayback Machine | 3 | adapted | medium | scripts (running) | 1 | 0 | yes |
| __MSG_extensionName__ | 3 | limited | medium | scripts (running) | 1 | 0 | yes |
| WhatFont | 3 | adapted | low | scripts (running) | 0 | 0 | yes |
| Zotero Connector | 3 | limited | medium | scripts (running) | 3 | 1 | yes |

**Result:** 55 / 55 installed, ran and were removed.

## Visible live run (real store pages, no pre-download)

The same path driven through Astra’s own `WebExtensions.prepare`/`confirm` in
a visible browser session, with screenshots in `out/live-store/`:

| Package | Version | Signature | Background | Content scripts | Extension row |
|---|---|---|---|---:|---|
| Dark Reader | 4.9.135 | verified | running | 3 | yes |
| SponsorBlock | 6.1.6 | verified | running | 2 | yes |
| Vimium | 2.4.2 | verified | running | 2 | yes |
| uBlock Origin Lite | 2026.1103.1743 | verified | running | 0 | yes |
| Stylus | 2.4.17 | verified | running | 5 | yes |

Dark Reader, Vimium and uBlock Origin Lite were removed after the check;
SponsorBlock and Stylus were kept installed for inspection. Disable → enable
was exercised on SponsorBlock through the Host API (`userDisabled` false → true
→ false, `isActive` true → false → true).
