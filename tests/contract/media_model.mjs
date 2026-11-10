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

// === A bound engine (P9) ====================================================
{
  const VIEW = {
    tab_id: TAB,
    title: "Tone",
    artist: "example.test",
    icon: null,
    duration: 12,
    position: 3,
    rate: 1,
    playing: true,
    waiting: false,
    can_pip: false,
    in_pip: false,
    muted: false,
    can_mute: true,
  };
  const dispatched = [];
  Media.__setEngine({
    dispatch(id, action) {
      dispatched.push(`${id}:${action.kind}`);
      return id === TAB;
    },
  });
  const play = await Media.player({ id: TAB, action: { kind: "play" } });
  check("a bound transport action is applied", play.accepted === true);
  check("a bound action reaches the engine", dispatched.at(-1) === `${TAB}:play`);
  const other = await Media.player({ id: "tab-other", action: { kind: "play" } });
  check("an unknown tab is still refused by the engine", other.accepted === false);
  check("an unknown action never reaches the engine", (await Media.player({ id: TAB, action: { kind: "mute" } })).accepted === false);
  check("a non-finite seek is refused", (await Media.player({ id: TAB, action: { kind: "seek", seconds: NaN } })).accepted === false);

  const before = seen.length;
  check("a projection is accepted", Media.__projectMedia(TAB, VIEW) === true);
  check("a projection is emitted", seen.length === before + 1 && seen.at(-1).type === "media-player-changed");
  check("the view reads back", Media.view()?.tab_id === TAB && Media.view()?.playing === true);
  check("a duplicate projection is not emitted", Media.__projectMedia(TAB, { ...VIEW }) === false);
  check("a changed field is emitted", Media.__projectMedia(TAB, { ...VIEW, playing: false }) === true && seen.length === before + 2);
  check("a mismatched tab is rejected", Media.__projectMedia("tab-other", VIEW) === false);
  check("clearing emits once", Media.__projectMedia(TAB, null) === true && Media.view() === null);

  // --- per-window engine and projection -----------------------------------
  Media.__setEngine({ dispatch: (id) => id === TAB }, "win-1");
  Media.__setEngine({ dispatch: () => false }, "win-2");
  check(
    "each window dispatches into its own engine",
    (await Media.player({ id: TAB, action: { kind: "play" }, window_id: "win-1" })).accepted === true &&
      (await Media.player({ id: TAB, action: { kind: "play" }, window_id: "win-2" })).accepted === false,
  );
  const beforeWindows = seen.length;
  check("a window projection is accepted", Media.__projectMedia(TAB, VIEW, "win-1") === true);
  check(
    "a window projection is only visible in that window",
    Media.view("win-1")?.tab_id === TAB && Media.view("win-2") === null,
  );
  check(
    "the event names its window",
    seen.length === beforeWindows + 1 && seen.at(-1).data?.window_id === "win-1",
  );
  Media.__projectMedia(TAB, null, "win-1");
  check("clearing one window leaves the other empty, not the shared view", Media.view("win-1") === null);

  Media.__resetForTests();
  check("reset clears the engine", (await Media.player({ id: TAB, action: { kind: "play" } })).accepted === false);
}

off();
console.log(`\nmedia model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
