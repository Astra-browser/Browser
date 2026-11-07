import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { blocker } from "$domain/blocker";
import ProtectionControls from "../components/ProtectionControls.svelte";

vi.mock("$domain/blocker", () => ({
  blocker: {
    status: () => ({
      protection: "disabled",
      preference: "authoritative",
      desired_enabled: false,
      can_enable: true,
      can_refresh_sources: true,
      source_phase: "fresh",
      retryable: false,
    }),
    refresh: vi.fn().mockResolvedValue(undefined),
    setEnabled: vi.fn(),
    refreshSources: vi.fn(),
    resetStats: vi.fn(),
    configure: vi.fn(),
    lists: vi.fn().mockResolvedValue({
      available: true,
      lists: [],
      update_hours: 24,
      auto_update: true,
      cosmetic: true,
      scriptlets: true,
      last_update_unix: null,
      next_update_unix: null,
      installed_rules: 2,
      stats: { today: 0, last7Days: 0, days: [] },
      mode: "standard",
      removeparam: true,
      bounce: true,
      block_scripts: false,
      redirects: true,
      cname: true,
      custom_lists: [],
      user_rules: "",
      cloaked: [],
    }),
  },
}));

afterEach(() => vi.clearAllMocks());

test("the real toggle dispatches intent and never invents applied protection", async () => {
  let complete!: (result: blocker.BlockerMutationResult) => void;
  vi.mocked(blocker.setEnabled).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const screen = await render(ProtectionControls);
  const toggle = screen.getByRole("switch", { name: /Block ads/ });
  await toggle.click();
  expect(blocker.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  await expect.element(toggle).toBeDisabled();
  expect(screen.container.textContent).toContain("Protection is off for this profile.");
  complete({ state: "unavailable" });
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Could not confirm this change");
  await expect.element(toggle).toBeEnabled();
  expect(screen.container.textContent).not.toContain("Protection is active.");
});

test("filter refresh uses the real updater and reports pending settlement", async () => {
  vi.mocked(blocker.refreshSources).mockResolvedValueOnce({
    state: "pending",
    operation_id: "refresh",
  });
  const screen = await render(ProtectionControls);
  await screen.getByRole("button", { name: "Update lists now" }).click();
  expect(blocker.refreshSources).toHaveBeenCalledExactlyOnceWith();
  await expect.element(screen.getByRole("status")).toHaveTextContent("still being applied");
});

test("protection mode and shield switches dispatch the new configuration", async () => {
  vi.mocked(blocker.configure).mockResolvedValue({
    state: "processed",
    disposition: { outcome: "applied", reason: "mutation_applied" },
  } as never);
  const screen = await render(ProtectionControls);

  await screen.getByRole("button", { name: "Aggressive" }).click();
  expect(blocker.configure).toHaveBeenCalledWith(expect.objectContaining({ mode: "aggressive" }));

  vi.mocked(blocker.configure).mockClear();
  await screen.getByRole("switch", { name: "Strip tracking parameters" }).click();
  expect(blocker.configure).toHaveBeenCalledWith(expect.objectContaining({ removeparam: false }));

  vi.mocked(blocker.configure).mockClear();
  await screen.getByRole("switch", { name: "Block scripts" }).click();
  expect(blocker.configure).toHaveBeenCalledWith(expect.objectContaining({ blockScripts: true }));
});
