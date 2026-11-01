/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import type { DownloadCall, DownloadView } from "$shared/ipc/bindings";
import DownloadsList from "../components/DownloadsList.svelte";

const native = vi.hoisted(() => ({
  call: vi.fn(),
  listener: null as null | ((event: { payload: { profile: string } }) => void),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ downloadCall: native.call });
});
vi.mock("$shared/ipc/native-events", () => ({
  events: {
    downloadsChanged: {
      listen: (listener: typeof native.listener) => {
        native.listener = listener;
        return Promise.resolve(() => {
          native.listener = null;
        });
      },
    },
  },
}));

const profile = "00000000000000000000000001";

function entry(overrides: Partial<DownloadView> = {}): DownloadView {
  return {
    id: "00000000000000000000000002",
    revision: "00000001",
    created_at: "1",
    filename: "fixture.zip",
    source: "https://example.com",
    source_is_context: false,
    state: "receiving",
    received: "10",
    total: "100",
    error: null,
    ...overrides,
  };
}

function serve(entries: DownloadView[]) {
  native.call.mockImplementation(async (_profile: string, call: DownloadCall) => {
    if (call.kind === "list")
      return {
        kind: "page",
        cleanup: { running: false, error: null },
        entries,
        next: null,
        supported: true,
      };
    if (call.kind === "updates")
      return {
        kind: "updates",
        cleanup: { running: false, error: null },
        entries,
        removed: [],
      };
    return { kind: "applied" };
  });
}

test("in-progress downloads list progress and cancel", async () => {
  serve([entry()]);
  const screen = await render(DownloadsList, { profile });

  await expect.element(page.getByText("fixture", { exact: false })).toBeVisible();
  await expect.element(page.getByText("10 B of 100 B", { exact: true })).toBeVisible();
  const bar = page.getByRole("progressbar", { name: "Download progress for fixture.zip" });
  await expect.element(bar).toBeVisible();
  expect(
    screen.container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
  ).toBe("10");

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "cancel",
    id: "00000000000000000000000002",
  });
  await screen.unmount();
  expect(native.listener).toBeNull();
});

test("receiving downloads offer pause", async () => {
  serve([entry()]);
  const screen = await render(DownloadsList, { profile });

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "pause",
    id: "00000000000000000000000002",
  });
  await screen.unmount();
});

test("paused downloads offer resume", async () => {
  serve([entry({ state: "paused", revision: "00000002" })]);
  const screen = await render(DownloadsList, { profile });

  await expect.element(page.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "resume",
    id: "00000000000000000000000002",
  });
  await screen.unmount();
});

test("completed downloads offer open and reveal", async () => {
  serve([
    entry({
      state: "completed",
      revision: "00000002",
      received: "100",
      filename: "report.pdf",
    }),
  ]);
  const screen = await render(DownloadsList, { profile });

  await expect
    .element(page.getByRole("button", { name: "Open report.pdf", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Show in folder", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "reveal",
    id: "00000000000000000000000002",
  });
  await page.getByRole("button", { name: "Open report.pdf", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "open",
    id: "00000000000000000000000002",
  });
  await screen.unmount();
});

test("finished entries can be forgotten", async () => {
  serve([entry({ state: "cancelled", revision: "00000002" })]);
  const screen = await render(DownloadsList, { profile });

  await page.getByRole("button", { name: "Remove from list", exact: true }).click();
  expect(native.call).toHaveBeenCalledWith(profile, {
    kind: "forget",
    id: "00000000000000000000000002",
  });
  await screen.unmount();
});
