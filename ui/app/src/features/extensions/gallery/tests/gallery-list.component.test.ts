import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "$styles/global.css";
import GalleryDetail from "../components/GalleryDetail.svelte";
import GalleryList from "../components/GalleryList.svelte";
import type { GalleryViewEntry, GalleryViewGroup } from "../lib/gallery-view";

const darkReader: GalleryViewEntry = {
  chromeStoreId: "eimadpbcbfnmbkopoojfekhnkhdbieeh",
  name: "Dark Reader",
  category: "browsing",
  status: "equivalent",
  slug: "darkreader",
  installHref: "https://addons.mozilla.org/firefox/addon/darkreader/",
  note: "Official Dark Reader build, public AMO listing confirmed.",
  installed: false,
};

const docsOffline: GalleryViewEntry = {
  chromeStoreId: "ghbmnnjooekpmoecnnnilnnbdlolhkhi",
  name: "Google Docs Offline",
  category: "productivity",
  status: "none",
  slug: null,
  installHref: null,
  note: "No equivalent: Google Docs Offline is Chrome-only.",
  installed: false,
};

const groups: GalleryViewGroup[] = [
  { category: "browsing", entries: [darkReader] },
  { category: "productivity", entries: [docsOffline] },
];

test("the list badges each mapping and only offers installs that exist", async () => {
  const onselect = vi.fn();
  const oninstall = vi.fn();
  render(GalleryList, { groups, onselect, oninstall });
  await expect.element(page.getByText("Browsing")).toBeVisible();
  await expect.element(page.getByText("Firefox equivalent")).toBeVisible();
  await expect.element(page.getByText("No Firefox version")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Get for Firefox" })).toBeVisible();
  await expect.element(page.getByText("Chrome-only")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /Dark Reader/ }));
  expect(onselect).toHaveBeenCalledWith(darkReader.chromeStoreId);
  await userEvent.click(page.getByRole("button", { name: "Get for Firefox" }));
  expect(oninstall).toHaveBeenCalledWith(darkReader.installHref);
});

test("the detail shows the mapping note and the AMO install", async () => {
  const onback = vi.fn();
  const oninstall = vi.fn();
  render(GalleryDetail, { entry: docsOffline, onback, oninstall });
  await expect.element(page.getByRole("heading", { name: "Google Docs Offline" })).toBeVisible();
  await expect
    .element(page.getByText("No equivalent: Google Docs Offline is Chrome-only."))
    .toBeVisible();
  await expect.element(page.getByText("Chrome-only", { exact: false })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Back to gallery" }));
  expect(onback).toHaveBeenCalledOnce();
});
