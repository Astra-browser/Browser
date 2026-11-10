#!/usr/bin/env node
// Floating-layer contract: a portalled menu must stack above a modal dialog.
//
// Select portals its list to <body>, so it is a sibling of an open dialog, not
// a child. When the menu layer sat at 50 and the dialog scrim/panel at 80/81,
// a Select inside a dialog (the clear-browsing-data time range) rendered behind
// the scrim and could not be clicked. Pin the ordering so it cannot regress.
//
// Usage: node tests/contract/menu_layer.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function lastZIndex(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "gu");
  let match;
  let value = null;
  while ((match = re.exec(css)) !== null) {
    const z = /z-index\s*:\s*(\d+)/u.exec(match[1]);
    if (z) value = Number(z[1]);
  }
  return value;
}

const menuCss = fs.readFileSync(
  path.join(ROOT, "ui/app/src/shared/ui/Menu/surface.css"),
  "utf8",
);
const browserCss = fs.readFileSync(
  path.join(ROOT, "ui/app/src/styles/browser.css"),
  "utf8",
);

const menu = lastZIndex(menuCss, ".ui-menu");
const overlay = lastZIndex(browserCss, ".settings-dialog-overlay");
const dialog = lastZIndex(browserCss, ".settings-dialog");

check("the portalled menu declares a z-index", Number.isInteger(menu));
check("the dialog scrim declares a z-index", Number.isInteger(overlay));
check("the dialog panel declares a z-index", Number.isInteger(dialog));
check(
  "a menu inside a dialog stacks above the scrim",
  Number.isInteger(menu) && Number.isInteger(overlay) && menu > overlay,
  `menu=${menu} scrim=${overlay}`,
);
check(
  "a menu inside a dialog stacks above the panel",
  Number.isInteger(menu) && Number.isInteger(dialog) && menu > dialog,
  `menu=${menu} panel=${dialog}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
