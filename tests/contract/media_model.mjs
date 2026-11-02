#!/usr/bin/env node
// Media module contract (wiring): `media_player` answers transport actions
// natively instead of failing with `unknown_command`.
//
//   - a tab with no media answers the admission `settle()` expects plus
//     `view: null` — the `MediaPlayerView | null` shape, with nothing
//     playing
//   - every transport action on that tab is refused (`accepted: false`), so
//     no reply claims playback that never happened
//   - malformed ids, actions and seeks are refused too, and nothing throws
//   - no `media-player-changed` (indeed no event at all) is emitted, because
//     no state changed
//
// Usage: node tests/contract/media_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Media } = await import(path.join(HOST, "Media.sys.mjs"));
const Events = await import(path.join(HOST, "Events.sys.mjs"));

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

const TAB = "tab-1";
const ACTIONS = [
  { kind: "play" },
  { kind: "pause" },
  { kind: "seek", seconds: 30 },
  { kind: "seek", seconds: null },
  { kind: "picture_in_picture" },
  { kind: "show" },
  { kind: "close" },
];

Events.__resetEventsForTests();
const seen = [];
const off = Events.addEventListener((event) => seen.push(event));

// === A tab with no media ====================================================
{
  const res = await Media.player({ id: TAB, action: { kind: "play" } });
  check("player answers an admission", res.operation_id === null && res.accepted === false);
  check("player has no operation to observe", res.operation_id === null);
  check("player has no view for a silent tab", res.view === null);
  check("player echoes the tab", res.tab_id === TAB);
  check("player never claims playback", JSON.stringify(res).includes('"playing":true') === false);
}

// === Every transport action is an honest no-op ==============================
for (const action of ACTIONS) {
  const label = action.kind === "seek" ? `seek(${action.seconds})` : action.kind;
  const res = await Media.player({ id: TAB, action });
  check(`${label} is refused, not applied`, res.accepted === false);
  check(`${label} claims no view`, res.view === null);
  check(`${label} echoes the tab`, res.tab_id === TAB);
  check(`${label} reports nothing playing`, res.view?.playing !== true);
}

// === Malformed actions and ids =============================================
{
  const unknown = await Media.player({ id: TAB, action: { kind: "mute" } });
  check("an unknown action is refused", unknown.accepted === false && unknown.view === null);

  const missing = await Media.player({ id: TAB });
  check("a missing action is refused", missing.accepted === false && missing.view === null);

  const nullAction = await Media.player({ id: TAB, action: null });
  check("a null action is refused", nullAction.accepted === false);

  const arrayAction = await Media.player({ id: TAB, action: [] });
  check("an array action is refused", arrayAction.accepted === false);

  const nanSeek = await Media.player({ id: TAB, action: { kind: "seek", seconds: Number.NaN } });
  check("a non-finite seek is refused", nanSeek.accepted === false && nanSeek.view === null);

  const noId = await Media.player({ action: { kind: "play" } });
  check("a missing tab id is refused", noId.accepted === false && noId.tab_id === "");

  const emptyId = await Media.player({ id: "", action: { kind: "play" } });
  check("an empty tab id is refused", emptyId.accepted === false && emptyId.view === null);

  const nothing = await Media.player();
  check("no arguments is refused, not a throw",
    nothing.accepted === false && nothing.view === null);
}

// === Nothing is emitted, because nothing changed ============================
{
  check("no media-player-changed was emitted",
    seen.every((event) => event.type !== "media-player-changed"));
  check("no event was emitted at all", Events.eventSeq() === 0 && seen.length === 0);
}

// === The sidebar projection ================================================
{
  check("view() reports no player", (await Media.view()) === null);
  check("view() takes no arguments and still reports none", (await Media.view(TAB)) === null);
}

off();
console.log(`\nmedia_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
