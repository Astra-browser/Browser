import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import { COMPLETED_KEY, THEME_KEY, Welcome, type WelcomeResult } from "../index";

const native = vi.hoisted(() => ({ settings: {} as Record<string, string> }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    settingGet: async (key: string) => native.settings[key] ?? null,
    settingSet: async (key: string, value: string) => {
      native.settings[key] = value;
      return { accepted: true, operation_id: null };
    },
  });
});

beforeEach(() => {
  native.settings = {};
  delete document.documentElement.dataset.theme;
});

const next = () =>
  page
    .getByRole("navigation")
    .getByRole("button", { name: /^(Get started|Continue|Start browsing)/u })
    .click();

test("welcome opens the flow and reaches the profile step", { timeout: 30_000 }, async () => {
  render(Welcome);
  await expect.element(page.getByRole("heading", { name: "Welcome to Astra" })).toBeVisible();
  await next();
  await expect
    .element(page.getByRole("heading", { name: "What should Astra call you?" }))
    .toBeVisible();
});

test("profile requires a name before continuing", { timeout: 30_000 }, async () => {
  render(Welcome);
  await page.getByRole("button", { name: "Get started" }).click();
  // No dead button: Continue stays disabled until a name is given.
  await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabelText("Name").fill("Ada");
  await expect.element(page.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.element(page.getByRole("heading", { name: "How should Astra look?" })).toBeVisible();
});

test(
  "theme choice applies live and persists via bridge settings",
  { timeout: 30_000 },
  async () => {
    render(Welcome);
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByLabelText("Name").fill("Ada");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect.poll(() => document.documentElement.dataset.theme).toBe("dark");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Bring your browsing with you" }))
      .toBeVisible();
    // Finishing the flow persists the theme through the bridge.
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Start browsing" }).click();
    await expect.poll(() => native.settings[THEME_KEY]).toBe("dark");
    await expect.poll(() => native.settings[COMPLETED_KEY]).toBe("true");
  },
);

test("import step is a disabled stub with no dead buttons", { timeout: 30_000 }, async () => {
  render(Welcome);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabelText("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.element(page.getByText("coming soon to Astra", { exact: false })).toBeVisible();
  const stub = page.getByRole("button", { name: "Import from another browser" });
  await expect.element(stub).toBeDisabled();
  // The stub never traps the flow: Continue moves on to done.
  await page.getByRole("button", { name: "Continue" }).click();
  await expect.element(page.getByRole("heading", { name: /You are all set/u })).toBeVisible();
});

test(
  "done finishes the run, persists the flag, and reports the result",
  { timeout: 30_000 },
  async () => {
    let result: WelcomeResult | null = null;
    render(Welcome, {
      onfinish: (value: WelcomeResult) => {
        result = value;
      },
    });
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByLabelText("Name").fill("Ada");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByRole("heading", { name: "You are all set, Ada" })).toBeVisible();
    await page.getByRole("button", { name: "Start browsing" }).click();
    await expect.poll(() => native.settings[COMPLETED_KEY]).toBe("true");
    expect(result).toEqual({ profileName: "Ada", theme: "system" });
  },
);

test("a finished run reopens on done via the persisted flag", { timeout: 30_000 }, async () => {
  native.settings[COMPLETED_KEY] = "true";
  render(Welcome);
  await expect.element(page.getByRole("heading", { name: /You are all set/u })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start browsing" })).toBeVisible();
});

test("Back walks to the previous step", { timeout: 30_000 }, async () => {
  render(Welcome);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByLabelText("Name").fill("Ada");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await expect
    .element(page.getByRole("heading", { name: "What should Astra call you?" }))
    .toBeVisible();
});
