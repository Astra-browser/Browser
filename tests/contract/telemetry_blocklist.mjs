#!/usr/bin/env node
// First-party telemetry contract: every host the owner reported as still
// loading has a host-anchored, $important rule in the bundled Astra list.
//
// The default lists mostly cover these hosts only with third-party or path
// scoped rules, so a same-site request slipped through. The Astra list is
// bundled and enabled by default; $important keeps any unbreak/cookie
// exception from cancelling the block.
//
// Usage: node tests/contract/telemetry_blocklist.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, check, passed, failed } from "./lib/harness.mjs";

const LIST = path.join(ROOT, "blocker/lists/astra-telemetry.txt");

const source = fs.readFileSync(LIST, "utf8");
const rules = new Set(
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("!")),
);

const HOSTS = [
  "c.bing.com",
  "api.vungle.com",
  "liftoff.io",
  "api.fyber.com",
  "ironsource.mobi",
  "s.youtube.com",
  "redirector.googlevideo.com",
  "tagmanager.google.com",
  "fingerprintjs.com",
  "bnc.lt",
  "mineralt.io",
  "graph.facebook.com",
  "analytics.x.com",
  "widgets.pinterest.com",
  "qevents.quora.com",
  "sc-analytics.appspot.com",
  "d.reddit.com",
  "mon.tiktokv.com",
  "xp.apple.com",
  "browser.events.data.msn.com",
  "device-metrics-us.amazon.com",
  "device-metrics-us-2.amazon.com",
  "mads-eu.amazon.com",
  "cdn.cookielaw.org",
  "consent.trustarc.com",
  "cdn.privacy-mgmt.com",
  "s.skimresources.com",
  "go.skimresources.com",
  "redirector.skimresources.com",
  "cdn.viglink.com",
  "st.dynamicyield.com",
  "clientstream.launchdarkly.com",
  "static.klaviyo.com",
  "a.klaviyo.com",
  "widget.intercom.io",
  "js.driftt.com",
  "dai.google.com",
  "g.jwpsrv.com",
  "ssl.p.jwpcdn.com",
];

for (const host of HOSTS) {
  const rule = `||${host}^$important`;
  check(`${host} is blocked host-wide`, rules.has(rule));
}

check(
  "every reported host has exactly one Astra rule",
  HOSTS.every(
    (host) =>
      source.split("\n").filter((line) => line.trim() === `||${host}^$important`).length === 1,
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
