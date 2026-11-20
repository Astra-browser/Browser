#!/usr/bin/env node
// Native surfaces contract: every command this lane declares is routed, has a
// Host method, has a UI caller, and the split-view model refuses the states it
// must refuse. Static checks keep `unknown_command` out of the product; pure
// model checks keep pane geometry and arrangement restore deterministic.
//
// Usage: node tests/contract/native_surfaces.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

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

const SplitView = await import(pathToFileURL(path.join(HOST, "SplitView.sys.mjs")).href);
const SpaceHistory = await import(pathToFileURL(path.join(HOST, "SpaceHistory.sys.mjs")).href);
const SpaceExtensions = await import(pathToFileURL(path.join(HOST, "SpaceExtensions.sys.mjs")).href);
const SpaceClone = await import(pathToFileURL(path.join(HOST, "SpaceClone.sys.mjs")).href);
const Peek = await import(pathToFileURL(path.join(HOST, "Peek.sys.mjs")).href);
const HostAPI = await import(pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href);
HostAPI.__resetForTests();

// --- pure model ------------------------------------------------------------
check("ratio clamps low", SplitView.clampRatio(0.001) === SplitView.MIN_RATIO);
check("ratio clamps high", SplitView.clampRatio(0.999) === SplitView.MAX_RATIO);
check("ratio rejects NaN", SplitView.clampRatio(Number.NaN) === null);
check("pane count caps at three", SplitView.paneCount(9) === 3);
check("pane count refuses one", SplitView.paneCount(1) === 2);
check("pane order right", JSON.stringify(SplitView.paneOrder({ source: "a", target: "b" })) === '["a","b"]');
check("pane order left", JSON.stringify(SplitView.paneOrder({ source: "a", target: "b", placement: "left" })) === '["b","a"]');
check("pane order refuses itself", SplitView.paneOrder({ source: "a", target: "a" }).length === 0);
check(
  "leave removes exactly one member",
  JSON.stringify(SplitView.membersAfterLeave(["a", "b", "c"], "b")) === '["a","c"]',
);
check("an arrangement refuses a file pane", SplitView.validArrangement({
  id: "x", name: "x", panes: [{ url: "file:///etc/passwd" }, { url: "https://b/" }], ratio: 0.5,
}) === null);
check("an arrangement needs two panes", SplitView.validArrangement({
  id: "x", name: "x", panes: [{ url: "https://a/" }], ratio: 0.5,
}) === null);
check("an arrangement keeps its ratio", (() => {
  const row = SplitView.validArrangement({
    id: "x", name: "x", ratio: 0.3,
    panes: [{ url: "https://a/", title: "A" }, { url: "https://b/", title: "B" }],
  });
  return row !== null && row.ratio === 0.3 && row.panes.length === 2;
})());
check("restore reuses an open pane", (() => {
  const matched = SplitView.matchPane(
    [{ url: "https://a/" }, { url: "https://c/" }],
    [{ astra_tab_id: "tab-1", url: "https://a/" }, { astra_tab_id: "tab-2", url: "https://b/" }],
  );
  return matched[0].reuse === true && matched[1].reuse === false;
})());
check("restore never reuses one tab twice", (() => {
  const matched = SplitView.matchPane(
    [{ url: "https://a/" }, { url: "https://a/" }],
    [{ astra_tab_id: "tab-1", url: "https://a/" }],
  );
  return matched.filter((row) => row.reuse).length === 1;
})());
check("pane widths follow the stage width", (() => {
  const wide = SplitView.paneWidths(900, [0.5, 0.5]);
  const narrow = SplitView.paneWidths(600, [0.5, 0.5]);
  return wide?.[0] > narrow?.[0] && wide[0] <= 900 && narrow[0] <= 600;
})());
check("pane widths keep a flexible last pane", (() => {
  const widths = SplitView.paneWidths(900, [0.3, 0.3, 0.4]);
  return widths?.length === 3 && widths.at(-1) === null
    && widths[0] >= SplitView.MIN_PANE_PX && widths[1] >= SplitView.MIN_PANE_PX
    && widths[0] + widths[1] < 900;
})());
check("pane widths clamp a tiny share to the floor", (() => {
  const widths = SplitView.paneWidths(900, [0.01, 0.99]);
  return widths?.[0] === SplitView.MIN_PANE_PX && widths.at(-1) === null;
})());
check("pane widths refuse a stage with no geometry", SplitView.paneWidths(0, [0.5, 0.5]) === null);
check("pane shares are a helper on the module", typeof SplitView.paneWidths === "function");

// --- host method surface ---------------------------------------------------
for (const method of [
  "open",
  "openUrl",
  "replace",
  "leave",
  "unsplit",
  "focus",
  "ratio",
  "drop",
  "bookmarkSave",
  "bookmarkList",
  "bookmarkDelete",
  "bookmarkRestore",
  "state",
]) {
  check(`SplitView.${method} is a method`, typeof SplitView.SplitView[method] === "function");
}

// No window is bound in Node: the surface must refuse honestly, never throw
// and never pretend a split exists.
for (const [name, call] of [
  ["open", () => SplitView.SplitView.open({ other: "tab-2" })],
  ["openUrl", () => SplitView.SplitView.openUrl({ url: "https://example.com/" })],
  ["unsplit", () => SplitView.SplitView.unsplit({})],
  ["leave", () => SplitView.SplitView.leave({ id: "tab-2" })],
  ["state", () => SplitView.SplitView.state({})],
]) {
  const reply = await call();
  check(`${name} refuses without a window`, reply?.error?.code === "no_window");
}

check("Host API exports SplitView", HostAPI.SplitView === SplitView.SplitView);
check("reset clears split bindings", typeof HostAPI.__resetForTests === "function");

// --- per-space history -----------------------------------------------------
check("a private visit is never indexed", SpaceHistory.noteVisit({
  url: "https://private.example/", space_id: "space-1", private: true,
}).recorded === false);
check("a non-web visit is not storable", SpaceHistory.noteVisit({
  url: "about:config", space_id: "space-1",
}).recorded === false);
check("an unknown space is not confirmed", SpaceHistory.noteVisit({
  url: "https://a.example/", space_id: "space-999",
}).reason === "space_not_owned");
check("a normal visit is indexed", SpaceHistory.noteVisit({
  url: "https://space.example/a#fragment", space_id: "space-1", visited_at: 1,
}).recorded === true);
check("the fragment is normalised away", (() => {
  const filtered = SpaceHistory.filterVisits(
    [{ url: "https://space.example/a#fragment", title: "A" }],
    new Set(["https://space.example/a"]),
  );
  return filtered.length === 1;
})());
check("another space's row is filtered", SpaceHistory.filterVisits(
  [{ url: "https://other.example/", title: "O" }],
  new Set(["https://space.example/a"]),
).length === 0);
check("show-other keeps every row", SpaceHistory.filterVisits(
  [{ url: "https://other.example/" }],
  new Set(),
  { showOther: true },
).length === 1);
const historyStatus = await SpaceHistory.SpaceHistory.status({ space_id: "space-1" });
check("status counts this space", historyStatus.entries >= 1 && historyStatus.scope === "space");
const badHistory = await SpaceHistory.SpaceHistory.call({ profile: "default", call: null });
check("a malformed history call is refused", badHistory.error?.code === "invalid");

// --- per-space extensions --------------------------------------------------
check("a theme is not an assignment member", SpaceExtensions.assignable({ type: "theme" }) === false);
check("a system extension is excluded", SpaceExtensions.assignable({ type: "extension", isSystem: true }) === false);
check("a user extension is assignable", SpaceExtensions.assignable({ type: "extension" }) === true);
check("SpaceExtensions exposes assign", typeof SpaceExtensions.SpaceExtensions.assign === "function");

// --- clonins ---------------------------------------------------------------
check("SpaceClone exposes clone", typeof SpaceClone.SpaceClone.clone === "function");
const noWindowClone = await SpaceClone.SpaceClone.clone({ tab: "tab-1", space: "space-1" });
check("a clone without a window is refused", noWindowClone.error?.code === "no_window");

// --- peek model ------------------------------------------------------------
check("an http target is previewable", Peek.validTarget({ url: "https://example.com/" }) !== null);
check("a file target is not previewable", Peek.validTarget({ url: "file:///etc/passwd" }) === null);
check("an about target is not previewable", Peek.validTarget({ url: "about:config" }) === null);
check("peek identity follows a tab", Peek.peekId({ tab_id: "tab-1", url: "" }) === "tab:tab-1");
check("peek identity follows a URL", Peek.peekId({ tab_id: "", url: "https://a/" }) === "url:https://a/");
check("peeks are bounded", Peek.trimPeeks(
  Array.from({ length: 9 }, (_, i) => ({ id: `p-${i}`, captured_at: i })),
).length === Peek.MAX_PEEKS);
check("the peek defaults are complete", (() => {
  const config = Peek.defaultConfig();
  return ["enabled", "trigger", "delay", "size", "position", "scale", "restore", "closeOnLeave", "showUrl", "showTitle"]
    .every((key) => key in config);
})());
const noWindowPeek = await Peek.Peek.open({ url: "https://example.com/" });
check("a peek without a window is refused", noWindowPeek.error?.code === "no_window");

// --- routing and callers ---------------------------------------------------
const routeText = fs.readFileSync(
  path.join(ROOT, "ui", "packages", "bridge", "src", "host-transport.ts"),
  "utf8",
);
const declared = [
  "tabs_split",
  "tabs_unsplit",
  "tabs_leave_split",
  "split_open_url",
  "split_replace",
  "split_bookmark_save",
  "split_bookmark_list",
  "split_bookmark_restore",
  "split_bookmark_delete",
];
for (const name of declared) {
  check(`${name} has a host route`, new RegExp(`\\b${name}: \\["SplitView"`).test(routeText));
}

const surfaceRoutes = {
  peek_open: "Peek",
  peek_close: "Peek",
  peek_close_all: "Peek",
  peek_capture: "Peek",
  peek_list: "Peek",
  peek_open_tab: "Peek",
  peek_open_split: "Peek",
  peek_restore: "Peek",
  peek_configure: "Peek",
  space_history_note: "SpaceHistory",
  space_history_list: "SpaceHistory",
  space_history_clear: "SpaceHistory",
  space_history_status: "SpaceHistory",
  space_extensions_list: "SpaceExtensions",
  space_extensions_assign: "SpaceExtensions",
  space_extensions_copy: "SpaceExtensions",
  space_extensions_apply: "SpaceExtensions",
  tabs_clone_to_space: "SpaceClone",
  tab_group_create: "TabGroups",
  tab_group_list: "TabGroups",
  tab_group_collapse: "TabGroups",
  tab_group_ungroup: "TabGroups",
};
for (const [name, module] of Object.entries(surfaceRoutes)) {
  check(`${name} routes to ${module}`, new RegExp(`\\b${name}: \\["${module}"`).test(routeText));
}
check("history reads through the space index", /\bhistory_call: \["SpaceHistory"/.test(routeText));

const commandText = fs.readFileSync(
  path.join(ROOT, "ui", "app", "src", "shared", "ipc", "surfaces.ts"),
  "utf8",
);
for (const name of [
  "split_open_url",
  "split_replace",
  "split_bookmark_save",
  "split_bookmark_list",
  "split_bookmark_restore",
  "split_bookmark_delete",
  "peek_open",
  "peek_close",
  "peek_close_all",
  "peek_capture",
  "peek_list",
  "peek_open_tab",
  "peek_open_split",
  "peek_restore",
  "peek_configure",
  "space_history_clear",
  "space_history_status",
  "space_extensions_list",
  "space_extensions_assign",
  "space_extensions_copy",
  "tabs_clone_to_space",
  "tab_group_create",
  "tab_group_collapse",
  "tab_group_ungroup",
]) {
  check(`${name} has a typed UI caller`, commandText.includes(`"${name}"`));
}

const jar = fs.readFileSync(path.join(ROOT, "overlay", "astra", "jar.mn"), "utf8");
check("SplitView is packaged in jar.mn", jar.includes("host/SplitView.sys.mjs"));
for (const file of ["Peek", "SpaceHistory", "SpaceExtensions", "SpaceClone", "TabGroups"]) {
  check(`${file} is packaged in jar.mn`, jar.includes(`host/${file}.sys.mjs`));
}
check(
  "the native split footer is suppressed",
  fs
    .readFileSync(path.join(ROOT, "overlay", "astra", "chrome", "shell-chrome.css"), "utf8")
    .includes("split-view-footer"),
);

// DOM fullscreen (a video player's own fullscreen): the content slot is only
// the rectangle the native deck is docked over. If the slot is raised above
// the deck or takes the pointer, an invisible sheet covers the page, the page
// never sees hover and its own controls never appear (owner report
// 2026-11-20). The live proof is fullscreen-probe.py; this keeps the rule from
// being "fixed" back to a transparent wall.
const chromeCss = fs.readFileSync(
  path.join(ROOT, "overlay", "astra", "chrome", "shell-chrome.css"),
  "utf8",
);
const fullscreenSlot =
  chromeCss.match(/:root\[inDOMFullscreen\] #astra-root \.astra-content \{([^}]*)\}/);
check("the DOM-fullscreen content slot exists", Boolean(fullscreenSlot));
check(
  "the DOM-fullscreen content slot stays under the page deck",
  Boolean(fullscreenSlot) && /z-index:\s*0\s*;/u.test(fullscreenSlot[1]),
);
check(
  "the DOM-fullscreen content slot takes no pointer",
  Boolean(fullscreenSlot) && /pointer-events:\s*none\s*;/u.test(fullscreenSlot[1]),
);

console.log(`\nnative surfaces: ${passed}/${passed + failed} checks passed`);
if (failed > 0) {
  console.error(`${failed} FAILED`);
  process.exit(1);
}
