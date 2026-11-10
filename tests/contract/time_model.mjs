#!/usr/bin/env node
// Time module contract: `time_call` and `focus_control` answer the UI's Time
// and Focus projections natively instead of failing with `unknown_command`.
//
//   - the reads the UI makes (`report`, `focus_days`) answer well-formed
//     replies with zeroed buckets and no days: the host has counted nothing,
//     and it never invents usage or a session
//   - a report keeps the requested bucket count, so an empty day still has
//     its 24 hours; `previous` is zeroed and no site is ranked
//   - `focus_days` is sparse, as the store answers it: no records means no
//     rows
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
//   - focus is a real session clock: start opens a focus phase with the
//     right ends, stop returns to idle, skip ends the running phase and
//     enters the next one (counting a skipped round), every fourth round
//     takes a long break, and `allow` lets a site through for a few minutes
//   - a phase that ended is advanced by the next status/report read, and
//     every change — plus every admitted control — emits `focus-changed`
//     with the new `FocusStatus`
//   - `shut` stays empty: the clock is real, blocking sites still needs the
//     engine's Net hook, and nothing here claims a site is blocked
//   - a malformed or unknown call answers `error: "invalid"`; a malformed
//     control is refused, changes nothing, and nothing throws
//
// Usage: node tests/contract/time_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Time, __setClockForTests, __resetTimeForTests } = await import(
  path.join(HOST, "Time.sys.mjs"),
);
const TimeMod = await import(path.join(HOST, "Time.sys.mjs"));
const TabsMod = await import(path.join(HOST, "Tabs.sys.mjs"));
const SettingsMod = await import(path.join(HOST, "Settings.sys.mjs"));
const { Tabs } = TabsMod;
const { Settings, __resetSettingsForTests } = SettingsMod;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const localHourOf = (ms) =>
  Math.floor((ms - new Date(ms).getTimezoneOffset() * MINUTE) / HOUR);
const localDayOf = (ms) =>
  Math.floor((ms - new Date(ms).getTimezoneOffset() * MINUTE) / DAY);

/** A stand-in for the profile pref store (`astra.time.state.v1`). */
function fakePrefs() {
  const values = new Map();
  return {
    values,
    getStringPref(name) {
      if (!values.has(name)) throw new Error(`missing pref ${name}`);
      return values.get(name);
    },
    setStringPref(name, value) {
      values.set(name, String(value));
    },
  };
}

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

const P = "00000000000000000000000001";
const OTHER = "00000000000000000000000002";

const zeroBucket = (bucket) =>
  !!bucket && bucket.browse === 0 && bucket.work === 0;
const zeroBuckets = (buckets) =>
  Array.isArray(buckets) && buckets.every(zeroBucket);
const refused = (answer) =>
  !!answer &&
  answer.accepted === false &&
  answer.operation_id === null &&
  !("session" in answer);

const call = (profile, call_) => Time.call({ profile, call: call_ });

// === Report: well-formed, zeroed, the requested span =======================
{
  const res = await call(P, {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 24,
    site: null,
  });
  check("a day report is a report reply", res.kind === "report");
  check("a day report echoes the profile", res.profile === P);
  check("a day report keeps 24 buckets", Array.isArray(res.buckets) && res.buckets.length === 24);
  check("a day report has no usage", zeroBuckets(res.buckets));
  check("a day report's previous is zero", zeroBucket(res.previous));
  check("a day report ranks no site", Array.isArray(res.sites) && res.sites.length === 0);
}

{
  const res = await call(P, {
    kind: "report",
    from_hour: 20 * 24,
    bucket_hours: 24,
    buckets: 7,
    site: null,
  });
  check("a week report is a report reply", res.kind === "report");
  check("a week report keeps 7 buckets", res.buckets.length === 7);
  check("a week report has no usage", zeroBuckets(res.buckets));
  check("a week report ranks no site", res.sites.length === 0);
}

{
  const res = await call(P, {
    kind: "report",
    from_hour: 100,
    bucket_hours: 1,
    buckets: 3,
    site: "x.com",
  });
  check("a site report is a report reply", res.kind === "report");
  check("a site report keeps the requested buckets", res.buckets.length === 3);
  check("a site report invents no site row", res.sites.length === 0);
  check("a site report invents no seconds", zeroBuckets(res.buckets));
}

// === Focus days: well-formed, sparse, empty ================================
{
  const res = await call(P, { kind: "focus_days", from_day: 20000, days: 1 });
  check("focus_days is a focus_days reply", res.kind === "focus_days");
  check("focus_days echoes the profile", res.profile === P);
  check("focus_days holds no days", Array.isArray(res.days) && res.days.length === 0);
}

{
  const res = await call(P, { kind: "focus_days", from_day: 19994, days: 7 });
  check("a week of focus_days is a focus_days reply", res.kind === "focus_days");
  check("a week of focus_days holds no days", res.days.length === 0);
}

// === Empty honesty: repeated reads never invent usage ======================
{
  const request = {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 24,
    site: null,
  };
  const first = await call(P, request);
  const second = await call(P, request);
  check("repeated reports stay identical",
    JSON.stringify(first) === JSON.stringify(second) && zeroBuckets(first.buckets));

  const focus = await call(P, { kind: "focus_days", from_day: 20000, days: 1 });
  check("repeated focus_days stay empty", focus.days.length === 0);
  check("no site-shaped object is returned",
    first.sites.every((site) => site === undefined || site === null));
}

// === Profile scoping ======================================================
{
  const mine = await call(P, {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 24,
    site: null,
  });
  const theirs = await call(OTHER, { kind: "focus_days", from_day: 20000, days: 7 });
  check("each reply echoes its own profile", mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits usage", zeroBuckets(mine.buckets) && theirs.days.length === 0);

  const alias = await Time.call({
    expected_profile: P,
    call: { kind: "focus_days", from_day: 20000, days: 1 },
  });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
}

// === Malformed reports: invalid, never a guessed span =====================
{
  const base = {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 24,
    site: null,
  };
  const invalid = (name, patch) => call(P, { ...base, ...patch }).then((res) => {
    check(`report ${name} is invalid`, res.kind === "error" && res.error === "invalid");
    check(`report ${name} echoes the profile`, res.profile === P);
  });

  await invalid("with bucket_hours 0", { bucket_hours: 0 });
  await invalid("with bucket_hours 2", { bucket_hours: 2 });
  await invalid("with fractional bucket_hours", { bucket_hours: 1.5 });
  await invalid("with string bucket_hours", { bucket_hours: "1" });
  await invalid("with no buckets", { buckets: 0 });
  await invalid("with too many buckets", { buckets: 32 });
  await invalid("with fractional buckets", { buckets: 1.5 });
  await invalid("with string buckets", { buckets: "24" });
  await invalid("with fractional from_hour", { from_hour: 1.5 });
  await invalid("with out-of-range from_hour", { from_hour: 2 ** 31 });
  await invalid("with string from_hour", { from_hour: "0" });
  await invalid("with an empty site", { site: "" });
  await invalid("with a non-string site", { site: 7 });
  await invalid("with an overlong site", { site: "a".repeat(254) });
  await invalid("with an overlong multi-byte site", { site: "é".repeat(127) });
}

{
  const res = await call(P, {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 1,
    site: "é".repeat(126),
  });
  check("a site within 253 bytes is accepted", res.kind === "report" && res.buckets.length === 1);
}

// === Malformed focus days: invalid ========================================
{
  const base = { kind: "focus_days", from_day: 20000, days: 7 };
  const invalid = (name, patch) => call(P, { ...base, ...patch }).then((res) => {
    check(`focus_days ${name} is invalid`, res.kind === "error" && res.error === "invalid");
    check(`focus_days ${name} echoes the profile`, res.profile === P);
  });

  await invalid("with no days", { days: 0 });
  await invalid("with too many days", { days: 32 });
  await invalid("with fractional days", { days: 1.5 });
  await invalid("with string days", { days: "7" });
  await invalid("with fractional from_day", { from_day: 20000.5 });
  await invalid("with out-of-range from_day", { from_day: -(2 ** 31) - 1 });
  await invalid("with string from_day", { from_day: "20000" });
}

// === Unknown and malformed calls: the reply's own error, no crash =========
for (const kind of ["page", "clear", "entries", "focus", "time", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, res.kind === "error" && res.error === "invalid");
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { from_hour: 0 });
  check("a call without a kind is invalid", noKind.kind === "error" && noKind.error === "invalid");

  const nullCall = await call(P, null);
  check("a null call is invalid", nullCall.kind === "error" && nullCall.error === "invalid");

  const arrayCall = await call(P, []);
  check("an array call is invalid", arrayCall.kind === "error" && arrayCall.error === "invalid");

  const stringCall = await call(P, "report");
  check("a string call is invalid", stringCall.kind === "error" && stringCall.error === "invalid");

  const noProfile = await Time.call({
    call: { kind: "focus_days", from_day: 20000, days: 1 },
  });
  check("a call without a profile is invalid",
    noProfile.kind === "error" && noProfile.error === "invalid" && noProfile.profile === "");

  const badProfile = await Time.call({
    profile: 42,
    call: { kind: "focus_days", from_day: 20000, days: 1 },
  });
  check("a non-string profile is invalid", badProfile.kind === "error" && badProfile.error === "invalid");

  const nothing = await Time.call();
  check("no arguments is invalid, not a throw",
    nothing.kind === "error" && nothing.error === "invalid");

  const nullInput = await Time.call(null);
  check("a null input is invalid, not a throw",
    nullInput.kind === "error" && nullInput.error === "invalid");
}

// === Focus control: a real session clock ==================================
//
// The clock is injected so a whole session can be walked without waiting.
// Enforcement is still deferred: `shut` stays empty and no test claims a
// site is blocked.
const Events = await import(path.join(HOST, "Events.sys.mjs"));
Events.__resetEventsForTests();

const announced = [];
const stopListening = Events.addEventListener((event) => announced.push(event));
const lastEvent = () => announced[announced.length - 1];
const lastStatus = () => lastEvent()?.data;

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
let now = T0;
function reset(at = T0) {
  __resetTimeForTests();
  now = at;
  __setClockForTests(() => now);
}
reset();

// --- start ----------------------------------------------------------------
{
  const began = now;
  const res = await Time.focus({
    control: { kind: "start", minutes: 25, breaks: true },
  });
  check("start is admitted", res.accepted === true && res.operation_id === null);
  const status = Time.status();
  check("start opens a focus phase", !!status.session && status.session.phase === "focus");
  check("the session starts at the start instant", status.session.started_at === began);
  check("the focus phase starts now", status.session.phase_started_at === began);
  check("the focus phase ends 25 minutes on",
    status.session.phase_ends_at === began + 25 * 60_000);
  check("a new session has no finished round", status.session.rounds === 0);
  check("a new session has counted no focused seconds", status.session.focused === 0);
  check("a new session lets no site through",
    Array.isArray(status.session.allowed) && status.session.allowed.length === 0);
  check("the view echoes the length and the breaks choice",
    status.session.minutes === 25 && status.session.breaks === true);
  check("the view carries the break lengths",
    status.session.break_minutes === 5 && status.session.long_break_minutes === 15);
  check("a session shuts nothing yet (enforcement deferred)",
    Array.isArray(status.shut) && status.shut.length === 0);
  check("start announces focus-changed", lastEvent()?.type === "focus-changed");
  check("the event carries a FocusStatus",
    lastStatus()?.session?.phase === "focus" && Array.isArray(lastStatus().shut));
}

// --- the clock advances the phase ----------------------------------------
{
  const endedAt = now + 25 * 60_000;
  now = endedAt;
  const before = announced.length;
  const status = Time.status();
  check("an ended focus round advances to a break", status.session.phase === "break");
  check("the break starts where the round ended",
    status.session.phase_started_at === endedAt);
  check("the short break lasts five minutes",
    status.session.phase_ends_at === endedAt + 5 * 60_000);
  check("the finished round is counted", status.session.rounds === 1);
  check("the finished round's seconds are counted", status.session.focused === 25 * 60);
  check("the advance announces focus-changed",
    announced.length === before + 1 && lastStatus().session.phase === "break");
}

// --- skip a break ---------------------------------------------------------
{
  const skippedAt = now;
  const res = await Time.focus({ control: { kind: "skip" } });
  check("skipping a break is admitted", res.accepted === true);
  const status = Time.status();
  check("skipping a break opens the next round", status.session.phase === "focus");
  check("the next round starts at the skip",
    status.session.phase_started_at === skippedAt);
  check("the next round ends a full length on",
    status.session.phase_ends_at === skippedAt + 25 * 60_000);
  check("skipping a break counts no extra round", status.session.rounds === 1);
}

// --- skip a round ---------------------------------------------------------
{
  now += 10 * 60_000;
  const skippedAt = now;
  const res = await Time.focus({ control: { kind: "skip" } });
  check("skipping a focus round is admitted", res.accepted === true);
  const status = Time.status();
  check("skipping a focus round opens a break", status.session.phase === "break");
  check("a skipped round is a finished round", status.session.rounds === 2);
  check("a skipped round keeps the seconds it ran",
    status.session.focused === 25 * 60 + 10 * 60);
  check("the break starts at the skip", status.session.phase_started_at === skippedAt);
  check("the break ends five minutes later",
    status.session.phase_ends_at === skippedAt + 5 * 60_000);
}

// --- every fourth round takes a long break -------------------------------
{
  await Time.focus({ control: { kind: "skip" } }); // break -> focus (round 3)
  now += 60_000;
  await Time.focus({ control: { kind: "skip" } }); // focus -> break (round 3 done)
  await Time.focus({ control: { kind: "skip" } }); // break -> focus (round 4)
  now += 60_000;
  await Time.focus({ control: { kind: "skip" } }); // focus -> long break (round 4 done)
  const status = Time.status();
  check("the fourth round opens a long break", status.session.phase === "long_break");
  check("four rounds are counted", status.session.rounds === 4);
  check("the long break lasts fifteen minutes",
    status.session.phase_ends_at - status.session.phase_started_at === 15 * 60_000);
}

// --- allow ----------------------------------------------------------------
{
  reset();
  await Time.focus({ control: { kind: "start", minutes: 25, breaks: true } });
  const allowed = await Time.focus({ control: { kind: "allow", site: "x.com" } });
  check("allow is admitted", allowed.accepted === true);
  check("allow names the site", Time.status().session.allowed.includes("x.com"));
  await Time.focus({ control: { kind: "allow", site: "x.com" } });
  check("a repeated allow keeps one entry",
    Time.status().session.allowed.filter((site) => site === "x.com").length === 1);
  await Time.focus({ control: { kind: "allow", site: "news.example" } });
  check("allow keeps every site", Time.status().session.allowed.length === 2);
  now += 5 * 60_000;
  check("an allowance ends after a few minutes",
    Time.status().session.allowed.length === 0);
  check("the phase outlives the allowance", Time.status().session.phase === "focus");
}

// --- stop -----------------------------------------------------------------
{
  const res = await Time.focus({ control: { kind: "stop" } });
  check("stop is admitted", res.accepted === true);
  const status = Time.status();
  check("stop returns to idle", status.session === null);
  check("idle shuts nothing", Array.isArray(status.shut) && status.shut.length === 0);
  check("stop announces the idle status",
    lastStatus()?.session === null && Array.isArray(lastStatus().shut));
}

// --- breaks off: a finished round opens the next round --------------------
{
  reset();
  await Time.focus({ control: { kind: "start", minutes: 1, breaks: false } });
  now += 60_000;
  const status = Time.status();
  check("without breaks the next phase is another round",
    status.session.phase === "focus" && status.session.rounds === 1);
  check("the next round starts where the last ended",
    status.session.phase_started_at === T0 + 60_000);
}

// --- a read advances the clock too ---------------------------------------
{
  reset();
  await Time.focus({ control: { kind: "start", minutes: 1, breaks: true } });
  now += 60_000;
  const before = announced.length;
  const report = await call(P, {
    kind: "report",
    from_hour: 0,
    bucket_hours: 1,
    buckets: 1,
    site: null,
  });
  check("a report still answers a report", report.kind === "report");
  check("a report read advances an ended phase", Time.status().session.phase === "break");
  check("the read announces the advance",
    announced.length === before + 1 && lastStatus().session.phase === "break");
}

// --- every admitted control announces, a refused one does not -------------
{
  reset();
  const before = announced.length;
  const stopped = await Time.focus({ control: { kind: "stop" } });
  check("stop while idle is admitted", stopped.accepted === true);
  check("an admitted control announces focus-changed", announced.length === before + 1);
  const quiet = announced.length;
  const refusedStart = await Time.focus({
    control: { kind: "start", minutes: 0, breaks: true },
  });
  check("a malformed start is refused", refused(refusedStart));
  check("a refused control announces nothing", announced.length === quiet);
}

// === Malformed controls are refused, change nothing, and never throw ======
{
  reset();
  await Time.focus({ control: { kind: "start", minutes: 25, breaks: true } });
  const before = JSON.stringify(Time.status());
  const controls = [
    { kind: "start", minutes: 0, breaks: true },
    { kind: "start", minutes: 181, breaks: true },
    { kind: "start", minutes: 25.5, breaks: true },
    { kind: "start", minutes: "25", breaks: true },
    { kind: "start", minutes: 25, breaks: "yes" },
    { kind: "allow", site: "" },
    { kind: "allow", site: "a".repeat(254) },
    { kind: "allow", site: 7 },
    { kind: "allow" },
    { kind: "unknown" },
    {},
    null,
    [],
    "start",
  ];
  let threw = false;
  for (const control of controls) {
    try {
      const res = await Time.focus({ control });
      if (!refused(res)) threw = true;
    } catch {
      threw = true;
    }
  }
  check("malformed controls are refused without throwing", threw === false);
  check("a refused control changes nothing", JSON.stringify(Time.status()) === before);
}

{
  const nothing = await Time.focus();
  check("focus with no arguments is refused, not a throw", refused(nothing));
  const nullInput = await Time.focus(null);
  check("focus with a null input is refused, not a throw", refused(nullInput));
}

// === Counting: a real span becomes a site row =============================
{
  __resetTimeForTests();
  __resetSettingsForTests();
  TabsMod.__resetTabsForTests();
  const prefs = fakePrefs();
  TimeMod.__setPrefsForTests(prefs);
  const t0 = Date.UTC(2026, 10, 5, 9, 0, 0);
  let now = t0;
  __setClockForTests(() => now);

  await Tabs.create({ url: "https://a.example/page" });
  // The first read starts the tracker and anchors at t0.
  await call(P, { kind: "focus_days", from_day: localDayOf(t0), days: 1 });

  now = t0 + 60_000;
  const one = await call(P, {
    kind: "report",
    from_hour: localHourOf(t0),
    bucket_hours: 1,
    buckets: 1,
    site: null,
  });
  check("a counted span is a report", one.kind === "report");
  check("60 s lands in the hour", one.buckets[0].browse === 60);
  check("the site is ranked", one.sites.length === 1 && one.sites[0].site === "a.example");
  check("the site carries its seconds", one.sites[0].seconds === 60);
  check("the site counts one open", one.sites[0].opens === 1);
  check("work time stays zero", one.buckets[0].work === 0);

  // Switching site at +60 s credits the first and opens the second.
  await Tabs.create({ url: "https://b.example/x" });
  now = t0 + 90_000;
  const two = await call(P, {
    kind: "report",
    from_hour: localHourOf(t0),
    bucket_hours: 1,
    buckets: 1,
    site: null,
  });
  const a = two.sites.find((site) => site.site === "a.example");
  const b = two.sites.find((site) => site.site === "b.example");
  check("the first site keeps the time it held", a?.seconds === 60);
  check("the new site starts counting", b?.seconds === 30);
  check("the new site counts its own open", b?.opens === 1);
  check("the hour totals both sites", two.buckets[0].browse === 90);

  const narrowed = await call(P, {
    kind: "report",
    from_hour: localHourOf(t0),
    bucket_hours: 1,
    buckets: 1,
    site: "b.example",
  });
  check("a site report keeps only that site", narrowed.sites.length === 1 && narrowed.sites[0].site === "b.example");
  check("a site report keeps the narrowed bucket", narrowed.buckets[0].browse === 30);

  // "Count time" off stops the clock; it does not delete what was counted.
  prefs.setStringPref("astra.settings.time.track", "false");
  const anchored = await call(P, {
    kind: "report",
    from_hour: localHourOf(t0),
    bucket_hours: 1,
    buckets: 1,
    site: null,
  });
  check("the read at the change anchors the stopped clock", anchored.buckets[0].browse === 90);
  now = t0 + 240_000;
  const paused = await call(P, {
    kind: "report",
    from_hour: localHourOf(t0),
    bucket_hours: 1,
    buckets: 1,
    site: null,
  });
  check("time.track=false stops new credit", paused.buckets[0].browse === 90);
}

// === Retention prunes old buckets; stored data reaches the report =========
{
  __resetTimeForTests();
  __resetSettingsForTests();
  TabsMod.__resetTabsForTests();
  const prefs = fakePrefs();
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  __setClockForTests(() => now);
  const today = localDayOf(now);
  const hour = localHourOf(now);
  const oldDay = today - 400;
  const oldHour = hour - 400 * 24;
  prefs.setStringPref("astra.settings.time.retention", "30");
  prefs.setStringPref(
    "astra.time.state.v1",
    JSON.stringify({
      v: 1,
      profiles: {
        [P]: {
          hours: {
            [String(hour)]: { "today.example": [120, 2] },
            [String(oldHour)]: { "old.example": [3600, 5] },
          },
          days: {
            [String(today)]: [600, 2, 1],
            [String(oldDay)]: [5000, 9, 8],
          },
          session: null,
        },
      },
    }),
  );
  TimeMod.__setPrefsForTests(prefs);
  TimeMod.__reloadStoreForTests();

  const report = await call(P, { kind: "report", from_hour: hour, bucket_hours: 1, buckets: 1, site: null });
  check("stored seconds reach the report", report.buckets[0].browse === 120);
  check("stored opens reach the site row", report.sites[0]?.opens === 2);
  check("an old bucket is outside the report", report.sites.every((site) => site.site !== "old.example"));

  TimeMod.__flushForTests();
  const stored = JSON.parse(prefs.getStringPref("astra.time.state.v1"));
  check("retention drops an old hour", !stored.profiles[P].hours[String(oldHour)]);
  check("retention drops an old day", !stored.profiles[P].days[String(oldDay)]);
  check("retention keeps the current hour", !!stored.profiles[P].hours[String(hour)]);
  check("retention keeps the current day", !!stored.profiles[P].days[String(today)]);
}

// === Focus history: finished rounds are real and survive a reload =========
{
  __resetTimeForTests();
  __resetSettingsForTests();
  TabsMod.__resetTabsForTests();
  const prefs = fakePrefs();
  TimeMod.__setPrefsForTests(prefs);
  const t0 = Date.UTC(2026, 10, 5, 9, 0, 0);
  let now = t0;
  __setClockForTests(() => now);

  // Naming the profile first keeps the round in this profile's history.
  await call(P, { kind: "focus_days", from_day: localDayOf(t0), days: 1 });
  const started = await Time.focus({ control: { kind: "start", minutes: 25, breaks: true } });
  check("a round starts", started.accepted === true);

  now = t0 + 25 * MINUTE;
  const status = Time.status();
  check("the round finishes into a break", status.session?.phase === "break" && status.session.rounds === 1);

  const day = localDayOf(now);
  const today = await call(P, { kind: "focus_days", from_day: day, days: 1 });
  check("the finished round is a focus day", today.days.length === 1);
  check("the day carries the focused seconds", today.days[0]?.seconds === 25 * 60);
  check("the day counts one session", today.days[0]?.sessions === 1);
  check("the day counts one completed round", today.days[0]?.completed === 1);

  TimeMod.__flushForTests();
  TimeMod.__reloadStoreForTests();
  const after = await call(P, { kind: "focus_days", from_day: day, days: 1 });
  check("the focus day survives a reload", after.days.length === 1 && after.days[0].seconds === 25 * 60);
  const restored = Time.status();
  check("the running break survives a reload", restored.session?.phase === "break" && restored.session.rounds === 1);
}

// === Focus settings and the shut list ====================================
{
  __resetTimeForTests();
  __resetSettingsForTests();
  TabsMod.__resetTabsForTests();
  const prefs = fakePrefs();
  TimeMod.__setPrefsForTests(prefs);
  const t0 = Date.UTC(2026, 10, 5, 9, 0, 0);
  let now = t0;
  __setClockForTests(() => now);
  await call(P, { kind: "focus_days", from_day: localDayOf(t0), days: 1 });

  prefs.setStringPref("astra.settings.focus.minutes", "50");
  prefs.setStringPref("astra.settings.focus.breaks", "true");
  prefs.setStringPref("astra.settings.focus.blocked", "x.com\nnews.example");

  const started = await Time.focus({ control: { kind: "start" } });
  check("a start with no length is admitted", started.accepted === true);
  const status = Time.status();
  check("start reads focus.minutes", status.session?.minutes === 50);
  check("start reads focus.breaks", status.session?.breaks === true);
  check(
    "shut lists the configured sites",
    status.shut.map((entry) => entry.site).join(",") === "x.com,news.example",
  );

  await Time.focus({ control: { kind: "allow", site: "x.com" } });
  const allowed = Time.status();
  check("an allow removes that exact shut site", allowed.shut.length === 1 && allowed.shut[0].site === "news.example");

  // The selected page on the shut list raises the app's cover; the shell
  // navigates that tab to its New Tab so the site is off the stage.
  const blockedTab = (await Tabs.create({ request_id: "focus-tab", url: "https://news.example/story" })).astra_tab_id;
  await Tabs.select({ request_id: "focus-select", astra_tab_id: blockedTab });
  Time.status();
  const covers = announced
    .filter((event) => event.type === "ui-command")
    .map((event) => String(event.data))
    .filter((command) => command.startsWith("focus.cover="));
  check(
    "a shut site raises the Focus cover",
    covers.at(-1) === "focus.cover=news.example",
    covers.at(-1),
  );

  now += 50 * MINUTE;
  check("a break shuts nothing", Time.status().shut.length === 0);
  const afterBreak = announced
    .filter((event) => event.type === "ui-command")
    .map((event) => String(event.data))
    .filter((command) => command.startsWith("focus.cover="));
  check("a break clears the Focus cover", afterBreak.at(-1) === "focus.cover=", afterBreak.at(-1));
}

// === A round started before the app named its profile still counts ========
{
  __resetTimeForTests();
  __resetSettingsForTests();
  TabsMod.__resetTabsForTests();
  const prefs = fakePrefs();
  TimeMod.__setPrefsForTests(prefs);
  const t0 = Date.UTC(2026, 10, 5, 9, 0, 0);
  let now = t0;
  __setClockForTests(() => now);

  await Time.focus({ control: { kind: "start", minutes: 1, breaks: false } });
  now += 60_000;
  Time.status();
  const day = localDayOf(now);
  const res = await call(P, { kind: "focus_days", from_day: day, days: 1 });
  check("a fallback round moves to the named profile", res.days.length === 1);
  check("its focused seconds move with it", res.days[0]?.seconds === 60);
  check("its session count moves with it", res.days[0]?.sessions === 1);
  check("its completed round moves with it", res.days[0]?.completed === 1);
}

// === The module never throws ==============================================
{
  let threw = false;
  const hostile = [
    { kind: "report", from_hour: 0, bucket_hours: 1, buckets: 24, site: {}, extra: () => {} },
    Object.create(null),
    { kind: "focus_days", from_day: {}, days: 7 },
    { kind: "report", site: { toString: () => "x.com" } },
    { get kind() { throw new Error("hostile"); } },
  ];
  for (const bad of hostile) {
    try {
      const res = await call(P, bad);
      if (!res || typeof res.kind !== "string") threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);

  let focusThrew = false;
  const hostileFocus = [
    { get control() { throw new Error("hostile"); } },
    Object.create(null),
  ];
  for (const bad of hostileFocus) {
    try {
      const res = await Time.focus(bad);
      if (!refused(res)) focusThrew = true;
    } catch {
      focusThrew = true;
    }
  }
  check("hostile focus inputs answer instead of throwing", focusThrew === false);
}

stopListening();

console.log(`\ntime_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
