// Shell-hosted pages: Tasks, Notes and Time. These read the golden resource
// servers (taskSession / notesTestServer / timeReport), so their state is
// local and real: a task can be added, a note can be filtered and opened, and
// Time renders its report. They are the strongest interaction coverage the
// standalone lane can offer without a host.
import { expect, test } from "../../ui/app/node_modules/playwright/test.mjs";
import { openScreen } from "./support.ts";

test.describe("tasks page", () => {
  test("lists the seeded tasks with their completion controls", async ({ page }) => {
    await openScreen(page, "tasks");

    // Two nested groups carry the name: the page shell and the list root.
    const group = page.getByRole("group", { name: "Tasks" }).last();
    await expect(group).toBeVisible();
    const boxes = group.getByRole("checkbox");
    await expect(boxes).toHaveCount(2);
    await expect(group.getByText("Review the browser task experience")).toBeVisible();
    await expect(group.getByText("Write the launch notes")).toBeVisible();
    await expect(boxes.first()).toHaveAttribute("aria-label", /^To do — /);

    // The column header and the list rail both offer "New list".
    await expect(page.getByRole("button", { name: "New list" }).first()).toBeVisible();
    for (const name of ["Completed", "Trash"]) {
      await expect(page.getByRole("button", { name, exact: true }).first()).toBeVisible();
    }
    await expect(page.getByRole("textbox", { name: "New task" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search tasks" })).toBeVisible();
  });

  test("a task typed into the composer joins the list", async ({ page }) => {
    await openScreen(page, "tasks");
    // Two nested groups carry the name: the page shell and the list root.
    const group = page.getByRole("group", { name: "Tasks" }).last();
    const before = await group.getByRole("checkbox").count();

    const composer = page.getByRole("textbox", { name: "New task" });
    await composer.fill("Ship the QA lane");
    await composer.press("Enter");

    await expect(group.getByText("Ship the QA lane")).toBeVisible();
    await expect(group.getByRole("checkbox")).toHaveCount(before + 1);
  });

  test("task search narrows the list to what matches", async ({ page }) => {
    await openScreen(page, "tasks");
    // Two nested groups carry the name: the page shell and the list root.
    const group = page.getByRole("group", { name: "Tasks" }).last();
    await page.getByRole("searchbox", { name: "Search tasks" }).fill("launch");
    await expect(group.getByText("Write the launch notes")).toBeVisible();
    await expect(group.getByText("Review the browser task experience")).toBeHidden();
  });
});

test.describe("notes page", () => {
  test("lists the seeded notes and opens one in the editor", async ({ page }) => {
    await openScreen(page, "notes");

    const list = page.getByRole("listbox", { name: "Notes" });
    await expect(list).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(3);
    await expect(list.getByRole("option", { name: /Reading list/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /Trip to Lisbon/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /Weekly review/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^New note/ }).first()).toBeVisible();

    await list.getByRole("option", { name: /Trip to Lisbon/ }).click();
    await expect(page.getByText(/train from Porto/)).toBeVisible();
  });

  test("notes search filters the list", async ({ page }) => {
    await openScreen(page, "notes");
    await page.getByRole("searchbox", { name: "Search notes" }).fill("lisbon");
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option", { name: /Trip to Lisbon/ })).toBeVisible();
  });
});

test.describe("time page", () => {
  test("renders the seeded report with its two totals", async ({ page }) => {
    await openScreen(page, "time");

    const body = page.locator("body");
    await expect(body).toContainText(/on the web/);
    await expect(body).toContainText(/in Work/);
    const range = page.getByRole("radiogroup", { name: "Show" });
    await expect(range.getByRole("radio", { name: "Day" })).toBeVisible();
    await expect(range.getByRole("radio", { name: "Week" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Focus", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shut during focus", exact: true })).toBeVisible();
  });
});
