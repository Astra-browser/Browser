# Interface fonts

Astra's interface uses two open-source typefaces as the closest legal
equivalents of the faces Arc ships:

| Role               | Astra face           | Arc face it stands in for  |
| ------------------ | -------------------- | -------------------------- |
| Body / UI          | **Inter** (variable) | ABC Oracle / InterVariable |
| Headings / display | **Instrument Serif** | Exposure / GT Alpina       |

ABC Oracle, Exposure, Marlin Soft SQ and GT Alpina are commercial typefaces.
They are not redistributed in this repository; do not add them without a
licence that permits bundling.

## Files

- `InterVariable-latin.woff2`, `InterVariable-latin-ext.woff2`
  — Inter v20, fetched from Google Fonts. SIL Open Font License 1.1.
- `InstrumentSerif-latin.woff2`, `InstrumentSerif-italic-latin.woff2`
  — Instrument Serif v5, fetched from Google Fonts. SIL Open Font License 1.1.

Both are loaded by `../fonts.css`, which is imported first in `global.css`.
