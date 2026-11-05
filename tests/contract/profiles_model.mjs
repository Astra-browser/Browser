#!/usr/bin/env node
// Profiles module contract: `profiles_get` and the `profiles_*` commands
// answer the UI's Profiles page from the native profile roster (in Node: the
// injectable native seam).
//
//   - `profiles_get` returns the `ProfilesView` shape, including the running
//     profile even when the toolkit service reports no current profile
//     (the dev build starts with `-profile`)
//   - create/rename/delete/avatar are applied and read back; duplicate or
//     invalid names, the running profile, and photo avatars are refused
//   - `profiles_changed` carries the new projection after each write
//   - switching is a relaunch-level operation: it is refused with a
//     disposition (`unsupported_command`), never silently claimed applied
//   - without a native backend nothing is claimed applied
//
// Usage: node tests/contract/profiles_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const Mod = await import(path.join(HOST, "Profiles.sys.mjs"));
const Events = await import(path.join(HOST, "Events.sys.mjs"));
const Operations = await import(path.join(HOST, "Operations.sys.mjs"));

const { Profiles, __resetProfilesForTests, __setProfilesBackend } = Mod;

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

const RUNNING = "/profiles/dev-profile";
const PERSONAL = "/profiles/personal";
const WORK = "/profiles/work";

function fakeRoster({ currentProfile = null } = {}) {
  const state = {
    // `-profile` is not necessarily a registered toolkit profile, so the
    // roster may not contain the running directory until the adapter adds it.
    profiles: [
      { id: PERSONAL, name: "Personal", avatar: "briefcase" },
      { id: WORK, name: "Work", avatar: "heart" },
    ],
    // Mirrors toolkitProfileService.currentProfile being null under -profile.
    toolkitCurrent: currentProfile,
    default: PERSONAL,
    supportsAvatar: true,
    meta: new Map(),
    calls: [],
  };
  const find = (id) => state.profiles.find((profile) => profile.id === id) ?? null;
  const backend = {
    async snapshot() {
      const profiles = state.profiles.map((profile) => ({ ...profile }));
      if (!profiles.some((profile) => profile.id === RUNNING)) {
        profiles.unshift({ id: RUNNING, name: "dev-profile", avatar: null });
      }
      const current =
        state.toolkitCurrent !== null &&
        profiles.some((profile) => profile.id === state.toolkitCurrent)
          ? state.toolkitCurrent
          : RUNNING;
      return {
        current,
        default: state.default,
        private: false,
        supportsAvatar: state.supportsAvatar,
        profiles,
      };
    },
    async readMeta(id) {
      return state.meta.get(id) ?? { color: 0, revision: 0 };
    },
    async writeMeta(id, meta) {
      state.meta.set(id, meta);
      return true;
    },
    async create(name) {
      state.calls.push(["create", name]);
      if (state.profiles.some((profile) => profile.name === name)) return null;
      const id = `/profiles/${name.toLowerCase().replace(/\s+/gu, "-")}`;
      state.profiles.push({ id, name, avatar: "default-favicon" });
      return id;
    },
    async rename(id, name) {
      state.calls.push(["rename", id, name]);
      const profile = find(id);
      if (!profile) return false;
      if (state.profiles.some((other) => other.id !== id && other.name === name)) {
        return false;
      }
      profile.name = name;
      return true;
    },
    async remove(id) {
      state.calls.push(["remove", id]);
      if (id === RUNNING || !find(id)) return false;
      state.profiles = state.profiles.filter((profile) => profile.id !== id);
      return true;
    },
    async setAvatarName(id, name) {
      state.calls.push(["avatar", id, name]);
      const profile = find(id);
      if (!profile) return false;
      profile.avatar = name;
      return true;
    },
    async pickAvatar() {
      return { kind: "unsupported" };
    },
  };
  return { backend, state };
}

function reset() {
  Events.__resetEventsForTests();
  Operations.__resetOperationsForTests();
  __resetProfilesForTests();
}

// === Packaging =============================================================
{
  const jar = await readFile(path.join(ROOT, "overlay", "astra", "jar.mn"), "utf8");
  check("jar.mn registers the Profiles host module", jar.includes("host/Profiles.sys.mjs"));
  check("jar.mn registers the Downloads host module", jar.includes("host/Downloads.sys.mjs"));
}

// === The running profile is reported under -profile =========================
{
  reset();
  const { backend } = fakeRoster({ currentProfile: null });
  __setProfilesBackend(backend);
  const view = await Profiles.get();
  check("get returns a ProfilesView", !!view && Array.isArray(view.profiles));
  check("the running -profile directory is reported as current", view.current === RUNNING);
  check(
    "the running profile is one of the rows",
    view.profiles.some((profile) => profile.id === RUNNING && profile.name === "dev-profile"),
  );
  check(
    "a registered default keeps kind default",
    view.profiles.find((profile) => profile.id === PERSONAL)?.kind === "default",
  );
  check(
    "the running unregistered profile is named rather than invented default",
    view.profiles.find((profile) => profile.id === RUNNING)?.kind === "named",
  );
  check(
    "initials render for a profile with no mapped native avatar",
    view.profiles.find((profile) => profile.id === RUNNING)?.avatar.style === "initials",
  );
  check(
    "a native standard avatar maps to an Astra symbol",
    view.profiles.find((profile) => profile.id === PERSONAL)?.avatar.symbol === 0,
  );
}

// A native custom photo cannot be served by this build; initials are honest,
// and an unrelated Astra symbol must never stand in for it.
{
  reset();
  const { backend, state } = fakeRoster();
  state.profiles[0].avatar = "6f1c0e8e-8f6a-4be1-9a4e-customphoto";
  state.meta.set(PERSONAL, { style: "symbol", color: 2, symbol: 6, revision: 4 });
  __setProfilesBackend(backend);
  const view = await Profiles.get();
  const personal = view.profiles.find((profile) => profile.id === PERSONAL);
  check("an unmapped native avatar falls back to initials", personal.avatar.style === "initials");
  check("the unrelated Astra symbol is not shown", personal.avatar.symbol === 0);
  check("the Astra colour still applies", personal.avatar.color === 2);
}

// === Create ================================================================
{
  reset();
  const { backend, state } = fakeRoster();
  __setProfilesBackend(backend);
  const seen = [];
  Events.addEventListener((event) => seen.push(event));

  const refusedSwitch = await Profiles.create({
    name: "School",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
    and_switch: true,
  });
  check("create with and_switch is admitted for classification", refusedSwitch.accepted === true);
  const disposition = await Operations.Operations.status({
    operation_id: refusedSwitch.operation_id,
  });
  check("create with and_switch is refused, not half-applied", disposition.state === "processed");
  check(
    "the refusal names the missing native path",
    disposition.disposition.outcome === "rejected" &&
      disposition.disposition.reason === "unsupported_command",
  );
  check("no profile was created for the refused switch", state.calls.length === 0);
  check(
    "no profiles-changed was announced for the refusal",
    seen.every((event) => event.type !== "profiles-changed"),
  );

  const created = await Profiles.create({
    name: "School",
    avatar: { style: "symbol", color: 4, symbol: 3, photo: null },
  });
  check("create is accepted", created.accepted === true);
  const view = await Profiles.get();
  const school = view.profiles.find((profile) => profile.name === "School");
  check("the new profile is listed", !!school);
  check("the new profile's symbol landed natively", school?.avatar.style === "symbol");
  check("the new profile's symbol index is read back", school?.avatar.symbol === 3);
  check("the new profile's colour is read back", school?.avatar.color === 4);
  check("the new profile's revision advanced", school?.avatar.revision === 1);
  check(
    "a profiles-changed event carried the projection",
    seen.some(
      (event) =>
        event.type === "profiles-changed" &&
        event.data.profiles.some((profile) => profile.name === "School"),
    ),
  );

  const duplicate = await Profiles.create({
    name: "School",
    avatar: { style: "initials", color: 0, symbol: 0, photo: null },
  });
  check("a duplicate name is refused", duplicate.accepted === false);
  check(
    "the duplicate did not add a second profile",
    state.profiles.filter((profile) => profile.name === "School").length === 1,
  );
}

// === Invalid input =========================================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  for (const name of ["", "   ", "x".repeat(81)]) {
    const result = await Profiles.create({
      name,
      avatar: { style: "initials", color: 0, symbol: 0, photo: null },
    });
    check(`invalid name ${JSON.stringify(name.slice(0, 8))} is refused`, result.accepted === false);
  }
  const badAvatar = await Profiles.create({
    name: "Garden",
    avatar: { style: "teleport", color: 0, symbol: 0, photo: null },
  });
  check("an unknown avatar style is refused", badAvatar.accepted === false);
  const badColor = await Profiles.create({
    name: "Garden",
    avatar: { style: "initials", color: 99, symbol: 0, photo: null },
  });
  check("an out-of-range colour is refused", badColor.accepted === false);
}

// === Rename ================================================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  check("rename accepts a fresh name", (await Profiles.rename({ profile: WORK, name: "Studio" })).accepted === true);
  const view = await Profiles.get();
  check("the renamed profile is read back", view.profiles.some((profile) => profile.name === "Studio"));
  check(
    "renaming to another profile's name is refused",
    (await Profiles.rename({ profile: WORK, name: "Personal" })).accepted === false,
  );
  check(
    "renaming an unknown profile is refused",
    (await Profiles.rename({ profile: "/profiles/missing", name: "Studio" })).accepted === false,
  );
}

// === Delete ================================================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  check("the running profile cannot be deleted", (await Profiles.remove({ profile: RUNNING })).accepted === false);
  check("another profile can be deleted", (await Profiles.remove({ profile: WORK })).accepted === true);
  const view = await Profiles.get();
  check("the deleted profile is gone", !view.profiles.some((profile) => profile.id === WORK));
}

// === Avatar ================================================================
{
  reset();
  const { backend, state } = fakeRoster();
  __setProfilesBackend(backend);
  const symbol = await Profiles.setAvatar({
    profile: WORK,
    avatar: { style: "symbol", color: 7, symbol: 2, photo: null },
  });
  check("a symbol avatar is accepted", symbol.accepted === true);
  let view = await Profiles.get();
  let work = view.profiles.find((profile) => profile.id === WORK);
  check("the symbol is read back", work.avatar.style === "symbol" && work.avatar.symbol === 2);
  check("the colour is read back", work.avatar.color === 7);
  check("the native avatar name was written", state.calls.some((call) => call[0] === "avatar" && call[2] === "heart"));

  const initials = await Profiles.setAvatar({
    profile: WORK,
    avatar: { style: "initials", color: 1, symbol: 0, photo: null },
  });
  check("initials are accepted", initials.accepted === true);
  view = await Profiles.get();
  work = view.profiles.find((profile) => profile.id === WORK);
  check("initials render as initials", work.avatar.style === "initials");
  check("the revision advanced for a second write", work.avatar.revision === 2);
  check(
    "initials map to the engine's neutral avatar",
    state.calls.some((call) => call[0] === "avatar" && call[2] === "default-favicon"),
  );

  const photo = await Profiles.setAvatar({
    profile: WORK,
    avatar: { style: "photo", color: 1, symbol: 0, photo: "token" },
  });
  check("a photo avatar is refused where no media route exists", photo.accepted === false);
  check(
    "the refused photo did not alter the native avatar",
    state.calls.filter((call) => call[0] === "avatar").length === 2,
  );

  const missing = await Profiles.setAvatar({
    profile: "/profiles/missing",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  check("an unknown profile refuses an avatar write", missing.accepted === false);
  check("no Astra avatar state was written for the unknown profile", !state.meta.has("/profiles/missing"));
}

// An unmanaged toolkit profile has no native avatar; Astra's own durable
// profile state still honours the choice rather than claiming a native write.
{
  reset();
  const { backend, state } = fakeRoster();
  state.supportsAvatar = false;
  for (const profile of state.profiles) profile.avatar = null;
  __setProfilesBackend(backend);
  const result = await Profiles.setAvatar({
    profile: WORK,
    avatar: { style: "symbol", color: 5, symbol: 7, photo: null },
  });
  check("a symbol lands on a roster without a native avatar", result.accepted === true);
  check("no native avatar call is attempted", !state.calls.some((call) => call[0] === "avatar"));
  const view = await Profiles.get();
  const work = view.profiles.find((profile) => profile.id === WORK);
  check("the Astra symbol is read back", work.avatar.style === "symbol" && work.avatar.symbol === 7);
  check("the Astra colour is read back", work.avatar.color === 5);
}

// === Avatar picker =========================================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  const picked = await Profiles.avatarPick();
  check("profile_avatar_pick is honest about the missing media route", picked.kind === "unsupported");
}

// === Switch ================================================================
{
  reset();
  const { backend, state } = fakeRoster();
  __setProfilesBackend(backend);
  const admission = await Profiles.switch({ profile: WORK });
  check("switch is admitted for classification", admission.accepted === true);
  const status = await Operations.Operations.status({
    operation_id: admission.operation_id,
  });
  check("switch resolves to a disposition", status.state === "processed");
  check("switch is not reported applied", status.disposition.outcome === "rejected");
  check(
    "switch names the missing relaunch path",
    status.disposition.reason === "unsupported_command",
  );
  check("switch never calls a native launch or profile mutation", state.calls.length === 0);
}

// === No native backend =====================================================
{
  reset();
  check("get answers null without a native roster", (await Profiles.get()) === null);
  const created = await Profiles.create({
    name: "School",
    avatar: { style: "initials", color: 0, symbol: 0, photo: null },
  });
  check("create is not claimed applied without a backend", created.accepted === false);
  check(
    "rename is not claimed applied without a backend",
    (await Profiles.rename({ profile: WORK, name: "Studio" })).accepted === false,
  );
  check("remove is not claimed applied without a backend", (await Profiles.remove({ profile: WORK })).accepted === false);
  check(
    "setAvatar is not claimed applied without a backend",
    (await Profiles.setAvatar({
      profile: WORK,
      avatar: { style: "initials", color: 0, symbol: 0, photo: null },
    })).accepted === false,
  );
}

// === A hostile native failure never throws =================================
{
  reset();
  __setProfilesBackend({
    async snapshot() {
      throw new Error("boom");
    },
    async readMeta() {
      return { color: 0, revision: 0 };
    },
    async writeMeta() {
      return true;
    },
  });
  let threw = false;
  try {
    const view = await Profiles.get();
    check("a broken native roster answers null", view === null);
    const result = await Profiles.create({
      name: "School",
      avatar: { style: "initials", color: 0, symbol: 0, photo: null },
    });
    check("a broken native roster refuses writes", result.accepted === false);
  } catch {
    threw = true;
  }
  check("a broken native roster never throws", threw === false);
}

__resetProfilesForTests();
console.log(`\nprofiles_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
