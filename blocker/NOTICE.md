# Blocker licences and attribution

Astra's blocker combines three kinds of material. Each keeps its own licence;
nothing is relicensed by being packaged with Astra.

## 1. Engine — `adblock-rust` (MPL-2.0)

- Upstream: <https://github.com/brave/adblock-rust>
- Copyright Brave Software, Inc. and contributors.
- Licence: Mozilla Public License 2.0.
- In this tree it is the audited `adblock 0.12.1` crate vendored at
  `engine/third_party/rust/adblock` and already used by Gecko's
  `content_classifier_engine`. Astra does not modify the crate source.

## 2. Scriptlet / redirect resources

The resources in `resources/resources.json` come from
<https://github.com/brave/adblock-resources> (`dist/resources.json`). Only
generic uBlock-Origin-derived resources are kept; Brave product resources are
excluded. Upstream licence: MPL-2.0. The scriptlet code itself is derived from
uBlock Origin (`GPL-3.0-or-later`); attribution and the upstream link are kept
in the resource name and in this notice.

## 3. Filter lists

The shipped lists are community subscriptions fetched from their publishers.
The exact source URL, licence expression and attribution for every list are in
`lists/catalog.json`. The main families are:

| Family | Licence | Attribution |
|---|---|---|
| EasyList / EasyPrivacy / EasyList regional and Fanboy lists | CC BY-SA 3.0 | The EasyList authors, <https://easylist.to/> |
| uBlock Origin filter lists | GPL-3.0-or-later | uBlock Origin contributors, <https://github.com/uBlockOrigin/uAssets> |
| URLhaus | CC BY-SA 4.0 | abuse.ch URLhaus, <https://urlhaus.abuse.ch/> |
| AdGuard lists | GPL-3.0-or-later | AdGuard Software Ltd., <https://github.com/AdguardTeam/FiltersRegistry> |
| Other regional lists | as recorded | the list author / support URL in the catalog |

The two bundled offline seed files (`seed/easylist.txt.gz`,
`seed/easyprivacy.txt.gz`) are unmodified upstream subscription texts packaged
with deterministic gzip; see `seed/NOTICE` and
`seed/LICENSE-CC-BY-SA-3.0.txt`.

## Brave branding and telemetry

No Brave product code, rewards, telemetry, P3A, analytics, sync or update
client is included. Brave-owned list sources are dropped rather than renamed,
because they contain Brave service filters and update hosts. The only use of
the Brave name is factual attribution of the upstream engine and resource
repositories, required by their licences.
