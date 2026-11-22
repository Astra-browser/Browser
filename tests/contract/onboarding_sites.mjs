#!/usr/bin/env node
// Onboarding Essentials contract.
//
// What this catches: the host's keep list drifting from the app's catalog (the
// app draws the marks, native owns the addresses, and "kept" is decided by the
// exact address), a keep that does not pin a tab, a release that does not
// unpin, and an unknown site that is accepted instead of refused.
//
// Usage: node tests/contract/onboarding_sites.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT, HOST, check, passed, failed } from "./lib/harness.mjs";

const { Tabs, ONBOARDING_SITES, __itemsSnapshot, __resetTabsForTests } = await import(
  pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href
);

const isFavorite = (snapshot, id) =>
  snapshot.nodes.some(
    (node) =>
      node.section === "favorites" && node.kind?.type === "tab" && node.kind.tab_id === id,
  );

// --- the two catalogs, compared ---------------------------------------------
const catalog = await readFile(
  path.join(ROOT, "ui", "app", "src", "features", "onboarding", "lib", "catalog.ts"),
  "utf8",
);
const start = catalog.indexOf("export const SITE_URLS");
const block = catalog.slice(start, catalog.indexOf("};", start));
const appUrls = Object.fromEntries(
  [...block.matchAll(/^\s*"?([a-z-]+)"?:\s*"(https:\/\/[^"]+)"/gmu)].map((match) => [
    match[1],
    match[2],
  ]),
);
check(
  `the app catalog was parsed (${Object.keys(appUrls).length} sites)`,
  Object.keys(appUrls).length > 0,
);
check(
  "both catalogs name the same sites",
  Object.keys(appUrls).sort().join(",") === Object.keys(ONBOARDING_SITES).sort().join(","),
);
for (const [site, url] of Object.entries(appUrls)) {
  check(`${site} keeps the same address`, ONBOARDING_SITES[site] === url);
}

// --- keep and release -------------------------------------------------------
__resetTabsForTests();
await Tabs.bootstrap({ request_id: "boot" });

const unknown = await Tabs.keepSite({ request_id: "u", site: "does-not-exist" });
check("an unknown site is refused", unknown?.error?.code === "unknown_site");

const first = await Tabs.keepSite({ request_id: "k1", site: "gmail" });
check("keep admits", first?.accepted === true);
check("keep names the catalog address", first?.url === ONBOARDING_SITES.gmail);
check(
  "keep names the tab it kept",
  typeof first?.astra_tab_id === "string" && first.astra_tab_id !== "",
);
check(
  "the kept tab is in the favorites run",
  isFavorite(__itemsSnapshot(), first.astra_tab_id),
);

const again = await Tabs.keepSite({ request_id: "k2", site: "gmail" });
check("keeping the same site again reuses its tab", again?.astra_tab_id === first.astra_tab_id);

const released = await Tabs.releaseSite({ request_id: "r1", site: "gmail" });
check("release admits", released?.accepted === true);
check("release reports the tab it let go", released?.released === true);
check(
  "the released tab is no longer a favourite",
  !isFavorite(__itemsSnapshot(), first.astra_tab_id),
);

const releasedAgain = await Tabs.releaseSite({ request_id: "r2", site: "gmail" });
check(
  "releasing a site that is not kept is a no-op, not an error",
  releasedAgain?.released === false,
);

// A kept site survives a second keep of a different site, and the first tab
// is the one released (the exact address is the identity).
const slack = await Tabs.keepSite({ request_id: "k3", site: "slack" });
check("a second site keeps its own address", slack?.url === ONBOARDING_SITES.slack);
check(
  "both sites are in the favorites run",
  isFavorite(__itemsSnapshot(), slack.astra_tab_id) &&
    (await Tabs.keepSite({ request_id: "k4", site: "gmail" }))?.accepted === true,
);

console.log(`\nonboarding sites: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
