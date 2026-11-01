import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import type { WebExtensionReview as Review } from "$shared/ipc/bindings";
import WebExtensionReview from "../components/WebExtensionReview.svelte";
import WebExtensionAccessPrompt from "../components/WebExtensionAccessPrompt.svelte";
import type { WebExtensionAccessRequestView } from "$shared/ipc/bindings";

// Same seams as WebExtensionReview.component.test.ts: the prompts answer
// through the webext domain and size themselves off the sidebar.
vi.mock("$domain/webext", () => ({
  webext: {
    isConfirming: () => false,
    isAnswering: () => false,
    error: () => null,
    named: () => null,
    cancel: vi.fn(),
    confirm: vi.fn(async () => {}),
    answerAccess: vi.fn(async () => {}),
  },
}));
vi.mock("$session/sidebar-mode.svelte", () => ({
  COMPACT_WIDTH: 48,
  effectiveWidth: () => 320,
  expandBriefly: () => () => {},
  hasPanel: () => false,
}));

afterEach(() => vi.clearAllMocks());

const review: Review = {
  review_id: "a11y-review",
  id: "extension-id",
  name: "Fixture",
  version: "1.0",
  description: "",
  // A lead warning plus "more" and "limitations" toggles, so the sheet holds
  // four tab stops and a wrap is observable.
  warnings: ["Manage your downloads", "Read your history"],
  limitations: ["Can't show its side panel"],
  icon: null,
  update: false,
  from_file: false,
};

const access: WebExtensionAccessRequestView = {
  profile_id: "profile",
  request: "a11y-access",
  extension_id: "extension-id",
  warnings: ["Manage your downloads"],
  permissions: [],
  patterns: [],
};

function dialogButtons(container: HTMLElement): HTMLButtonElement[] {
  const dialog = container.querySelector('[role="alertdialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  const buttons = [...dialog!.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  return buttons;
}

test("review dialog loops Tab over its own buttons", async () => {
  const screen = await render(WebExtensionReview, { review });
  const buttons = dialogButtons(screen.container);
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;

  last.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(first);

  first.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(last);
});

test("access dialog loops Tab over its own buttons", async () => {
  const screen = await render(WebExtensionAccessPrompt, { request: access });
  const buttons = dialogButtons(screen.container);
  const first = buttons[0]!;
  const last = buttons[buttons.length - 1]!;

  last.focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(first);

  first.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(last);
});

test("Tab never leaves the modal sheet for the page behind it", async () => {
  const screen = await render(WebExtensionReview, { review });
  const dialog = screen.container.querySelector('[role="alertdialog"]')!;
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];

  // Walk a full cycle from the first button: every stop stays in the sheet.
  buttons[0]!.focus();
  for (let i = 0; i < buttons.length; i++) await userEvent.keyboard("{Tab}");
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(buttons[0]);
});
