import "$styles/global.css";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import SpacesPage from "../components/sections/SpacesPage.svelte";

const native = vi.hoisted(() => ({
  createSpace: vi.fn(async () => ({ outcome: "applied" as const })),
  switchSpace: vi.fn(async () => ({ outcome: "applied" as const })),
  reorderSpace: vi.fn(async () => ({ outcome: "applied" as const })),
}));

const spaces = vi.hoisted(() => [
  {
    id: "space-1",
    name: "Home",
    profile_id: "profile-dev",
    icon: null,
    color: 0,
    theme: null,
    tabs: 3,
    previews: [],
  },
  {
    id: "space-2",
    name: "Reading",
    profile_id: "profile-dev",
    icon: null,
    color: 3,
    theme: null,
    tabs: 1,
    previews: [],
  },
]);

vi.mock("$domain/profiles", () => ({
  profiles: {
    retain: async () => {},
    release: () => {},
    current: () => ({ id: "profile-dev", name: "Dev", kind: "default" }),
    others: () => [],
  },
}));

vi.mock("$domain/tabs", () => ({
  tabs: {
    spaces: () => spaces,
    activeSpace: () => spaces[0],
    profile: () => ({ id: "default" }),
    createSpace: native.createSpace,
    switchSpace: native.switchSpace,
    reorderSpace: native.reorderSpace,
  },
}));

vi.mock("$features/tabs", () => ({
  loadSpaceEditor: () => new Promise(() => {}),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({});
});

test("lists the profile's spaces and starts a new one", async () => {
  await page.viewport(1200, 800);
  const screen = await render(SpacesPage);

  await expect.element(screen.getByText("Spaces in Dev")).toBeVisible();
  await expect.element(screen.getByText("Home").first()).toBeVisible();
  await expect.element(screen.getByText("Reading").first()).toBeVisible();
  await expect.element(screen.getByText(/This space/u)).toBeVisible();
  await expect.element(screen.getByText(/3 tabs/u)).toBeVisible();

  await screen.getByRole("button", { name: "New Space" }).click();
  await expect.poll(() => native.createSpace.mock.calls.length).toBe(1);

  await screen.getByRole("button", { name: "Switch this window to Reading" }).click();
  await expect.poll(() => native.switchSpace.mock.calls.length).toBe(1);

  await expect.element(screen.getByRole("heading", { name: "Other profiles" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Clear space data" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Import…" })).toBeVisible();
});
