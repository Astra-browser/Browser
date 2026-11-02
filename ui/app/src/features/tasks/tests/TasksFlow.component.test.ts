/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** The task golden path through the real bridge: capture a task, complete it,
 *  reopen it, break it into a subtask, and follow its linked page. Every step
 *  goes through `resourceCall` against the test server, never around it. */
import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { resourceTestServer } from "$shared/testing/resources/server";
import type { ResourceRecord_Serialize } from "$shared/ipc/bindings";
import TaskHost from "./TaskHost.svelte";

const native = vi.hoisted(() => ({ call: vi.fn(), open: vi.fn() }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ resourceCall: native.call, browserOpenUrl: native.open });
});

function statusOf(records: Map<string, ResourceRecord_Serialize>, id: string) {
  const content = records.get(id)!.draft.content;
  return content.kind === "task" ? [content.status, content.completed] : null;
}

function stepsOf(records: Map<string, ResourceRecord_Serialize>, id: string) {
  const content = records.get(id)!.draft.content;
  if (content.kind !== "task") return null;
  return content.details?.steps?.map((step) => [step.title, step.completed]) ?? [];
}

test("create, complete, reopen, subtask, and follow the linked page", async () => {
  await page.viewport(900, 800);
  const profile = "00000000000000000000000041";
  const made = resourceTestServer(profile);
  native.call.mockImplementation(made.call);
  const { records } = made;

  // A task filed with a page, already in the store: it links back to it.
  const linked = "000000000000000000000043";
  records.set(linked, {
    id: linked,
    revision: "1",
    created_at: "100",
    updated_at: "100",
    trashed: false,
    draft: {
      title: "Read the brief",
      pinned: false,
      related: [],
      content: {
        kind: "task",
        details: {},
        description: "",
        completed: false,
        status: "open",
        assignee: "user",
        origin: "user",
        due_date: null,
        context: { url: "https://example.com/brief", title: "Quarterly brief" },
        sort_key: null,
        work: null,
      },
    },
  });
  const screen = await render(TaskHost, { profile, scope: "all" });
  await expect.element(screen.getByText("Read the brief", { exact: true })).toBeVisible();

  // Create the task the way a reader does: type a line, press Enter.
  const field = screen.getByRole("textbox", { name: "New task", exact: true });
  await field.fill("File the quarterly report");
  await field.click();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => [...records.values()].map((record) => record.draft.title).sort())
    .toEqual(["File the quarterly report", "Read the brief"]);
  const id = [...records.keys()].find((key) => key !== linked)!;
  await expect
    .element(screen.getByText("File the quarterly report", { exact: true }))
    .toBeVisible();

  // Complete it from its row; it settles as done and leaves for the pile.
  await screen.getByRole("checkbox", { name: /File the quarterly report/u }).click();
  await expect.poll(() => statusOf(records, id)).toEqual(["done", true]);

  // Reopen it from behind the Completed disclosure; it settles back open.
  await screen.getByRole("button", { name: /Completed/u }).click();
  await screen.getByRole("checkbox", { name: /File the quarterly report/u }).click();
  await expect.poll(() => statusOf(records, id)).toEqual(["open", false]);
  await expect
    .element(screen.getByText("File the quarterly report", { exact: true }))
    .toBeVisible();

  // Open it and break off a subtask; the step lands through the real update.
  await screen.getByText("File the quarterly report", { exact: true }).click();
  const subtask = screen.getByRole("textbox", { name: "Add a subtask…" });
  await expect.element(subtask).toBeVisible();
  await subtask.fill("Gather the figures");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => stepsOf(records, id)).toEqual([["Gather the figures", false]]);

  // Finish the subtask from its own box.
  await screen.getByRole("checkbox", { name: /Gather the figures/u }).click();
  await expect.poll(() => stepsOf(records, id)).toEqual([["Gather the figures", true]]);

  // Following the linked page opens it: back to the list, then into it.
  await screen.getByRole("button", { name: "Back to tasks" }).click();
  await expect.element(screen.getByText("Read the brief", { exact: true })).toBeVisible();
  await screen.getByText("Read the brief", { exact: true }).click();
  await expect.element(screen.getByText("Quarterly brief")).toBeVisible();
  const link = screen.container.querySelector(".context-link");
  expect(link).not.toBeNull();
  await (link as HTMLElement).click();
  expect(native.open).toHaveBeenCalledWith("https://example.com/brief", false);
});
