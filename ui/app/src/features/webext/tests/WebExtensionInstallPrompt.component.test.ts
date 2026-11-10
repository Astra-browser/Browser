import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import type { WebExtensionPromptView } from "$shared/ipc/bindings";
import "$styles/global.css";
import WebExtensionInstallPrompt from "../components/WebExtensionInstallPrompt.svelte";

const actions = vi.hoisted(() => ({ answerPrompt: vi.fn(async () => {}) }));

vi.mock("$domain/webext", () => ({
  webext: { ...actions, isAnsweringPrompt: () => false },
}));
vi.mock("$session/sidebar-mode.svelte", () => ({
  COMPACT_WIDTH: 48,
  effectiveWidth: () => 320,
  expandBriefly: () => () => {},
  hasPanel: () => false,
}));

afterEach(() => vi.clearAllMocks());

const prompt: WebExtensionPromptView = {
  prompt_id: "prompt-1",
  kind: "install",
  name: "Fixture",
  header: "Add Fixture",
  messages: ["Read and change all your data on the websites you visit"],
  data_collection: null,
  icon: null,
  unsigned: false,
  accept_text: "Add",
  cancel_text: "Cancel",
  show_private: true,
  private_allowed: false,
  show_technical: true,
  technical_allowed: true,
};

test("Add answers the prompt with the chosen optional settings", async () => {
  render(WebExtensionInstallPrompt, { prompt });
  await userEvent.click(page.getByRole("checkbox", { name: "Allow in private windows" }));
  await userEvent.click(page.getByRole("button", { name: "Add", exact: true }));
  expect(actions.answerPrompt).toHaveBeenCalledExactlyOnceWith(true, true, true);
});
