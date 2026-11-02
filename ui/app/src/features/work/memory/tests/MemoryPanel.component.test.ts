import "$styles/global.css";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import MemoryPanel from "../components/MemoryPanel.svelte";
import type { MemoryEntry } from "../lib/memory";

const entries: MemoryEntry[] = [
  { id: "a", scope: "global", content: "prefers dark mode", updatedAt: 30 },
  { id: "b", scope: "site", content: "loves quiet keyboards", updatedAt: 10, site: "shop.example" },
];

test("lists memories, searches, edits, and deletes only after confirm", async () => {
  const onupdate = vi.fn();
  const ondelete = vi.fn();
  const screen = await render(MemoryPanel, { entries, onupdate, ondelete });

  await expect.element(page.getByText("prefers dark mode")).toBeVisible();
  await expect.element(page.getByText("loves quiet keyboards")).toBeVisible();

  // Search narrows the list.
  await page.getByPlaceholder("Search memories").fill("keyboards");
  await expect.element(page.getByText("loves quiet keyboards")).toBeVisible();
  await expect.element(page.getByText("prefers dark mode")).not.toBeInTheDocument();
  await page.getByPlaceholder("Search memories").fill("");

  // Delete asks first: first click only arms the confirm.
  await screen.container.querySelector<HTMLElement>('[data-entry="a"] button:last-child')!.click();
  await expect.element(page.getByText("Delete this memory? This cannot be undone.")).toBeVisible();
  expect(ondelete).not.toHaveBeenCalled();
  await expect.element(page.getByText("prefers dark mode")).toBeVisible();

  // Cancelling keeps the row and calls nothing.
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(ondelete).not.toHaveBeenCalled();
  await expect.element(page.getByText("prefers dark mode")).toBeVisible();

  // Confirming deletes exactly that row.
  await screen.container.querySelector<HTMLElement>('[data-entry="a"] button:last-child')!.click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  expect(ondelete).toHaveBeenCalledTimes(1);
  expect(ondelete).toHaveBeenCalledWith("a");

  // Edit round-trips the new content through onupdate.
  await screen.container.querySelector<HTMLElement>('[data-entry="b"] button:first-child')!.click();
  await userEvent.fill(
    page.getByRole("textbox", { name: "Edit memory" }),
    "loves silent keyboards",
  );
  await page.getByRole("button", { name: "Save" }).click();
  expect(onupdate).toHaveBeenCalledTimes(1);
  expect(onupdate).toHaveBeenCalledWith("b", "loves silent keyboards");

  await screen.unmount();
});

test("empty and no-match states read back", async () => {
  const empty = await render(MemoryPanel, { entries: [] });
  await expect.element(page.getByText("Nothing kept yet.")).toBeVisible();
  await empty.unmount();

  const screen = await render(MemoryPanel, { entries });
  await page.getByPlaceholder("Search memories").fill("no such memory");
  await expect.element(page.getByText("No memories match.")).toBeVisible();
  await screen.unmount();
});
