#!/usr/bin/env node
// Spaces-in-profiles contract (D-42). A profile owns many spaces and a space
// belongs to exactly one profile:
//
//   - the running profile adopts the existing default space once;
//   - every profile mints its own home space without moving the window;
//   - a space created while a profile is in front is owned by that profile;
//   - a space can never move to another profile, and a tab cannot move into
//     another profile's space;
//   - deleting a profile deletes every space it owns;
//   - bookmarks import only inside one profile, and copies rather than moves;
//   - session restore keeps the owner, and pre-ownership snapshots restore
//     unowned for adoption;
//   - clearing one space's data addresses only that space's container.
//
// Usage: node tests/contract/spaces_profiles_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const ProfilesMod = await import(pathToFileURL(path.join(HOST, "Profiles.sys.mjs")).href);
const TabsMod = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);
const Operations = await import(pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href);
const BookmarksMod = await import(pathToFileURL(path.join(HOST, "Bookmarks.sys.mjs")).href);
const BrowsingDataMod = await import(pathToFileURL(path.join(HOST, "BrowsingData.sys.mjs")).href);
const MetadataMod = await import(pathToFileURL(path.join(HOST, "Metadata.sys.mjs")).href);

const { Profiles, __resetProfilesForTests, __setProfilesBackend } = ProfilesMod;
const {
  Tabs,
  __spacesState,
  __spaceOwner,
  __activeProfileId,
  __resetTabsForTests,
} = TabsMod;
const { Bookmarks, __resetBookmarksForTests } = BookmarksMod;
const { BrowsingData, __setBrowsingDataBackend, __resetBrowsingDataForTests } =
  BrowsingDataMod;

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

function fakeRoster() {
  const state = {
    profiles: [
      { id: PERSONAL, name: "Personal", avatar: "briefcase" },
      { id: WORK, name: "Work", avatar: "heart" },
    ],
    meta: new Map(),
    calls: [],
  };
  const backend = {
    async snapshot() {
      const profiles = state.profiles.map((profile) => ({ ...profile }));
      if (!profiles.some((profile) => profile.id === RUNNING)) {
        profiles.unshift({ id: RUNNING, name: "dev-profile", avatar: null });
      }
      return {
        current: RUNNING,
        default: PERSONAL,
        private: false,
        supportsAvatar: true,
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
      const id = `/profiles/${name.toLowerCase().replace(/\s+/gu, "-")}`;
      state.profiles.push({ id, name, avatar: "default-favicon" });
      return id;
    },
    async rename(id, name) {
      const profile = state.profiles.find((entry) => entry.id === id);
      if (!profile) return false;
      profile.name = name;
      return true;
    },
    async remove(id) {
      state.calls.push(["remove", id]);
      if (id === RUNNING) return false;
      state.profiles = state.profiles.filter((profile) => profile.id !== id);
      return true;
    },
    async setAvatarName() {
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
  __resetTabsForTests();
  __resetProfilesForTests();
  __resetBookmarksForTests();
  __resetBrowsingDataForTests();
}

const spaces = () => __spacesState().spaces;
const owned = (id) => spaces().filter((space) => space.profile_id === id);
const activeName = () => {
  const state = __spacesState();
  return state.spaces.find((space) => space.id === state.active_space_id)?.name ?? null;
};
const bookmarks = (call) =>
  Bookmarks.call({ expected_profile: "default", call });

// === Adoption and one home per profile =====================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  const view = await Profiles.get();
  check("the running profile is reported", view?.current === RUNNING);
  check(
    "the default space is adopted by the running profile",
    __spaceOwner("space-1") === RUNNING,
  );
  check("the active profile is the running one", __activeProfileId() === RUNNING);

  const seen = [];
  Events.addEventListener((event) => seen.push(event));
  const created = await Profiles.create({
    name: "Work",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  check("creating a profile is applied", created.accepted === true);
  const workSpaces = owned(WORK);
  check("a new profile owns exactly one home space", workSpaces.length === 1);
  check("the home space carries the profile name", workSpaces[0]?.name === "Work");
  check(
    "creating a profile without switching keeps the window in place",
    __activeProfileId() === RUNNING && activeName() === "Space",
  );

  // A second space in the running profile is owned by the running profile.
  const made = await Tabs.createSpace({ name: "Reading", look: null });
  check("creating a space is admitted", made.accepted === true);
  const createdSpace = spaces().find((space) => space.name === "Reading");
  check("the new space belongs to the profile in front", createdSpace?.profile_id === RUNNING);
  check(
    "the profile owns both of its spaces",
    owned(RUNNING).some((space) => space.name === "Space") &&
      owned(RUNNING).some((space) => space.name === "Reading"),
  );
}

// === Spaces never move across profiles =====================================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  await Profiles.get();
  await Profiles.create({
    name: "Work",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  const work = owned(WORK)[0];
  const before = work.profile_id;

  // From the running profile, editing or deleting the Work space is refused.
  const edit = await Tabs.updateSpace({
    space: work.id,
    name: "Stolen",
    look: { icon: null, color: 0, theme: null },
  });
  check("another profile's space cannot be renamed", edit.accepted === false);
  const removed = await Tabs.deleteSpace({ space: work.id });
  check("another profile's space cannot be deleted", removed.accepted === false);
  check("its owner did not change", __spaceOwner(work.id) === before);

  // Switching to a space selects its owner, so ownership and the profile in
  // front can never disagree.
  await Tabs.switchSpace({ space: work.id });
  check("switching to a space selects its profile", __activeProfileId() === WORK);
  check("and the active space is that space", activeName() === "Work");

  // A tab cannot be moved into another profile's space.
  await Tabs.switchSpace({ space: "space-1" });
  const tab = await Tabs.create({ url: "https://personal.example/" });
  await Tabs.switchSpace({ space: work.id });
  const crossed = await Tabs.moveTabToSpace({
    tab: tab.astra_tab_id,
    space: "space-1",
  });
  check("moving a tab into another profile's space is refused", crossed.accepted === false);
  check(
    "the tab stayed in its own profile's space",
    (await Tabs.get({ astra_tab_id: tab.astra_tab_id })).tab.space_id === "space-1",
  );
}

// === Deleting a profile deletes all of its spaces ==========================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  await Profiles.get();
  await Profiles.create({
    name: "Work",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  const work = owned(WORK)[0];
  await Tabs.switchSpace({ space: work.id });
  await Tabs.createSpace({ name: "Design", look: null });
  check("the profile owns two spaces before deletion", owned(WORK).length === 2);

  await Tabs.switchSpace({ space: "space-1" });
  const removed = await Profiles.remove({ profile: WORK });
  check("deleting the profile is applied", removed.accepted === true);
  check("every space of the profile is gone", owned(WORK).length === 0);
  check(
    "the running profile's spaces are untouched",
    owned(RUNNING).length === 1 && __spaceOwner("space-1") === RUNNING,
  );
}

// === Bookmarks import stays inside one profile =============================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  await Profiles.get();
  const source = "space-1";
  const added = await bookmarks({
    kind: "add_link",
    parent: null,
    title: "Personal site",
    url: "https://personal.example/",
  });
  check("a bookmark is added to the running space", added.kind === "saved");

  await Tabs.createSpace({ name: "Reading", look: null });
  const target = __spacesState().active_space_id;
  check("the target space is a sibling in the same profile", __spaceOwner(target) === RUNNING);

  const imported = await bookmarks({ kind: "import_space", from: source, to: target });
  check("importing inside the profile is applied", imported.kind === "imported");
  check("the import copied the one bookmark", imported.count === 1);

  const targetList = await bookmarks({ kind: "list", folder: null });
  check(
    "the target space lists the copied bookmark",
    targetList.kind === "listing" &&
      targetList.items.some((item) => item.url === "https://personal.example/"),
  );

  // The source still holds it: an import copies, never moves.
  await Tabs.switchSpace({ space: source });
  const sourceList = await bookmarks({ kind: "list", folder: null });
  check(
    "the source space still holds its bookmark",
    sourceList.kind === "listing" &&
      sourceList.items.some((item) => item.url === "https://personal.example/"),
  );

  const same = await bookmarks({ kind: "import_space", from: source, to: source });
  check("importing a space into itself is refused", same.kind === "error");

  // A brand-new source space has never saved a bookmark, so its folder does
  // not exist yet. That is an empty source, not a failed import (the settings
  // page showed "The bookmarks could not be imported." for this case).
  await Tabs.createSpace({ name: "Empty source", look: null });
  const emptySource = __spacesState().active_space_id;
  await Tabs.switchSpace({ space: source });
  const fromEmpty = await bookmarks({
    kind: "import_space",
    from: emptySource,
    to: source,
  });
  check(
    "an empty source imports zero bookmarks instead of failing",
    fromEmpty.kind === "imported" && fromEmpty.count === 0,
    JSON.stringify(fromEmpty),
  );
  check("an empty import changes nothing", owned(RUNNING).length === 3);

  // A space owned by another profile is refused without revealing it.
  await Profiles.create({
    name: "Work",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  const work = owned(WORK)[0];
  const crossed = await bookmarks({ kind: "import_space", from: work.id, to: source });
  check(
    "importing from another profile's space is refused",
    crossed.kind === "error" && crossed.error === "missing",
  );
}

// === Session restore keeps the owner =======================================
{
  const { capture, plan } = MetadataMod.Metadata;
  const snapshot = capture({
    spaces: [
      {
        id: "space-1",
        name: "Space",
        profile_id: RUNNING,
      },
      {
        id: "space-2",
        name: "Reading",
        profile_id: WORK,
      },
    ],
    active_space_id: "space-1",
    tabs: [
      {
        astra_tab_id: "tab-1",
        space_id: "space-1",
        url: "https://personal.example/",
        private: false,
        window_id: "win-1",
      },
    ],
    windows: [{ window_id: "win-1", focused: true, title: "" }],
    selected_tab_id: "tab-1",
  });
  check(
    "the saved snapshot writes the owner",
    snapshot.spaces.find((space) => space.uuid === "space-1")?.profile_id === RUNNING &&
      snapshot.spaces.find((space) => space.uuid === "space-2")?.profile_id === WORK,
  );
  const restored = plan(snapshot, []);
  check(
    "restore keeps each owner",
    restored.spaces.find((space) => space.id === "space-1")?.profile_id === RUNNING &&
      restored.spaces.find((space) => space.id === "space-2")?.profile_id === WORK,
  );

  const old = {
    ...snapshot,
    spaces: snapshot.spaces.map((space) => ({ ...space, profile_id: undefined })),
  };
  const legacy = plan(old, []);
  check(
    "a pre-ownership snapshot restores unowned for adoption",
    legacy.spaces.every((space) => space.profile_id === "default"),
  );
}

// === Clearing one space addresses only that container =====================
{
  reset();
  const { backend } = fakeRoster();
  __setProfilesBackend(backend);
  await Profiles.get();
  await Tabs.createSpace({ name: "Reading", look: null });
  const reading = __spacesState().active_space_id;
  const seen = [];
  __setBrowsingDataBackend({
    isPrivate: () => false,
    hasWindow: () => true,
    async clearSpace(userContextId) {
      seen.push(userContextId);
      return true;
    },
  });
  const cleared = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear_space", space: reading },
  });
  check("clearing one space is applied", cleared.kind === "cleared");
  check("exactly one container was addressed", seen.length === 1);
  check(
    "the addressed container is this space's, not another's",
    seen[0] === (Number(/^space-(\d+)$/u.exec(reading)?.[1] ?? 0) - 1),
  );

  // A space owned by another profile cannot be cleared while that profile is
  // not the one in front.
  await Profiles.create({
    name: "Work",
    avatar: { style: "initials", color: 2, symbol: 0, photo: null },
  });
  const work = owned(WORK)[0];
  await Tabs.switchSpace({ space: "space-1" });
  const seenBefore = seen.length;
  const other = await BrowsingData.call({
    expected_profile: "default",
    call: { kind: "clear_space", space: work.id },
  });
  check(
    "a space of another profile is refused",
    other.kind === "error" && other.error === "invalid",
  );
  check("nothing was cleared for the refused space", seen.length === seenBefore);
}

console.log(`\nspaces_profiles_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
