import { expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "$styles/global.css";
import GalleryPermissionPrompt from "../components/GalleryPermissionPrompt.svelte";

const answer = vi.hoisted(() => vi.fn());

test("a permission prompt names the extension, permission and site", async () => {
  render(GalleryPermissionPrompt, {
    dialogId: "dlg-1",
    extensionName: "Dark Reader",
    permission: "tabs",
    url: "https://example.com",
    onanswer: answer,
  });
  await expect.element(page.getByText("Dark Reader is asking for permission")).toBeVisible();
  await expect.element(page.getByText("tabs")).toBeVisible();
  await expect.element(page.getByText("https://example.com")).toBeVisible();
});

test("allowing forwards grant, denying forwards deny — never resolving itself", async () => {
  render(GalleryPermissionPrompt, {
    dialogId: "dlg-1",
    extensionName: "Dark Reader",
    permission: "tabs",
    url: "https://example.com",
    onanswer: answer,
  });
  await userEvent.click(page.getByRole("button", { name: "Allow" }));
  expect(answer).toHaveBeenCalledWith("dlg-1", true);
  cleanup();
  render(GalleryPermissionPrompt, {
    dialogId: "dlg-2",
    extensionName: "Dark Reader",
    permission: "storage",
    url: "https://example.com",
    onanswer: answer,
  });
  await userEvent.click(page.getByRole("button", { name: "Deny" }));
  expect(answer).toHaveBeenCalledWith("dlg-2", false);
});
