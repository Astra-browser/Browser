/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import "$styles/global.css";
import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { NoteSession } from "$domain/notes";
import { TaskSession } from "$domain/resources";
import CanvasSurface from "../components/CanvasSurface.svelte";
import { mockCanvasDocs } from "../lib/mock-stream";
import { canvasStepPlan } from "../lib/plan-tasks";
import { WorkNotes } from "../../lib/work-notes";
import { WorkTasks } from "../../lib/work-tasks";

const native = vi.hoisted(() => ({ resource: vi.fn(), note: vi.fn() }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ resourceCall: native.resource, noteCall: native.note });
});

async function setup() {
  await page.viewport(1400, 900);
  const profile = "01J0000000000000000000000C1";
  const { resourceTestServer } = await import("$shared/testing/resources/server");
  const { notesTestServer } = await import("$shared/testing/notes/server");
  const resources = resourceTestServer(profile);
  const notesServer = notesTestServer(profile);
  native.resource.mockImplementation(resources.call);
  native.note.mockImplementation(notesServer.call);
  const docs = mockCanvasDocs();
  const plan = docs.find((doc) => doc.kind === "plan")!;
  const plans = new Map([[plan.id, canvasStepPlan(plan, plan.id, "objective")!]]);
  const taskSession = new TaskSession(profile);
  await taskSession.start();
  const tasks = new WorkTasks(profile, taskSession, () => plans, vi.fn());
  const noteSession = new NoteSession(profile, "canvas");
  await noteSession.start();
  const notes = new WorkNotes();
  const screen = await render(CanvasSurface, {
    docs,
    tasks,
    workId: "objective",
    notes,
    session: noteSession,
  });
  return { screen, docs, resources, notesServer, tasks, taskSession, noteSession };
}

test("one section per renderer kind, in both themes", async () => {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.dataset.theme = theme;
    const { screen, docs } = await setup();
    for (const doc of docs) {
      await expect.element(screen.getByRole("article", { name: doc.title })).toBeVisible();
    }
    // Every kind draws, with its steps beside it.
    for (const title of [
      "Harbor plan pricing",
      "Weekday focus hours",
      "Trip planning flow",
      "Lisbon trip steps",
      "Total cost helper",
      "Lisbon notes",
    ]) {
      await expect.element(screen.getByRole("heading", { name: title, level: 2 })).toBeVisible();
    }
    await expect.element(screen.getByText("Read the Harbor pricing page")).toBeVisible();
    await expect.element(screen.getByText("Plotted focus against meetings by day")).toBeVisible();
    await screen.unmount();
    delete document.documentElement.dataset.theme;
  }
});

test("a plan doc's steps become the person's tasks only when asked", async () => {
  const { screen, resources } = await setup();
  const plan = screen.getByRole("article", { name: "Lisbon trip steps" });
  expect(resources.records.size).toBe(0);
  await plan.getByRole("button", { name: "Make tasks" }).click();
  await expect
    .poll(() => [...resources.records.values()].map((record) => record.draft.title))
    .toEqual([
      "Book the train from Porto on Friday",
      "Pack the adapter",
      "Buy the museum tickets",
      "Confirm the stay check-in time",
    ]);
  for (const record of resources.records.values()) {
    const task = record.draft.content;
    expect(task).toMatchObject({ kind: "task", origin: "agent", work: "objective" });
  }
  // Asked twice, the action is spent: the steps are tasks now.
  await expect
    .element(plan.getByRole("button", { name: "Make tasks", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .poll(() => plan.getByRole("button", { name: /Open in Tasks/ }).all())
    .not.toEqual([]);
  await screen.unmount();
});

test("a document doc is saved as a note only when asked, and then only once", async () => {
  const { screen, notesServer } = await setup();
  const document = screen.getByRole("article", { name: "Lisbon notes" });
  expect(notesServer.writes().length).toBe(0);
  await document.getByRole("button", { name: "Save as note" }).click();
  await expect
    .poll(() => notesServer.writes().filter((call) => call.kind === "create").length)
    .toBe(1);
  const saved = [...notesServer.notes.values()].find(
    (note) => note.summary.title === "Lisbon notes",
  );
  expect(saved?.summary.title).toBe("Lisbon notes");
  await expect.element(document.getByText("Already on this canvas")).toBeVisible();
  await screen.unmount();
});
