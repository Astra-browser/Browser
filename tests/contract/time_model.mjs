#!/usr/bin/env node
// Time module contract (wiring): `time_call` and `focus_control` answer the
// UI's Time and Focus projections natively instead of failing with
// `unknown_command`.
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
//   - focus control never admits a start (or any other control): a session
//     that cannot block a site is refused, not reported as applied
//   - a malformed or unknown call answers `error: "invalid"` and never throws
//
// Usage: node tests/contract/time_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Time } = await import(path.join(HOST, "Time.sys.mjs"));

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

// === Focus control: nothing may claim a started session ====================
for (const control of [
  { kind: "start", minutes: 25, breaks: false },
  { kind: "start", minutes: 5, breaks: true },
  { kind: "start", minutes: 180, breaks: false },
  { kind: "stop" },
  { kind: "skip" },
  { kind: "allow", site: "x.com" },
]) {
  const res = await Time.focus({ control });
  check(`focus ${control.kind} is refused`, refused(res));
  check(`focus ${control.kind} claims no operation`, res.operation_id === null);
}

{
  const start = await Time.focus({ control: { kind: "start", minutes: 25, breaks: false } });
  check("a start is never accepted", start.accepted === false);
  check("a start names no session", !("session" in start) && !("focus" in start));
  check("a start has no operation to observe", start.operation_id === null);
}

// === Malformed controls are refused the same way, and never throw =========
{
  const controls = [
    { kind: "start", minutes: 0, breaks: false },
    { kind: "start", minutes: 181, breaks: false },
    { kind: "start", minutes: 25, breaks: "yes" },
    { kind: "allow", site: "" },
    { kind: "allow", site: "a".repeat(254) },
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
}

{
  const nothing = await Time.focus();
  check("focus with no arguments is refused, not a throw", refused(nothing));
  const nullInput = await Time.focus(null);
  check("focus with a null input is refused, not a throw", refused(nullInput));
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

console.log(`\ntime_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
