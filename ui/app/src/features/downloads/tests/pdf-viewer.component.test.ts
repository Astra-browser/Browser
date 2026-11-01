/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import PdfViewer from "../components/PdfViewer.svelte";
import { PDF_VIEWER_BASE } from "../lib/pdf";

const src = "https://example.com/files/report.pdf?x=1&y=2";

test("a PDF opens inside the built-in viewer", async () => {
  const screen = await render(PdfViewer, { src, filename: "report.pdf" });

  const frame = screen.container.querySelector("iframe");
  expect(frame?.getAttribute("title")).toBe("Open report.pdf");
  expect(frame?.getAttribute("src")).toBe(`${PDF_VIEWER_BASE}?file=${encodeURIComponent(src)}`);
  await expect.element(page.getByTitle("Open report.pdf")).toBeVisible();
  await screen.unmount();
});

test("the viewer base can be overridden", async () => {
  const screen = await render(PdfViewer, {
    src,
    filename: "report.pdf",
    viewerBase: "https://viewer.example/v/",
  });

  expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(
    `https://viewer.example/v/?file=${encodeURIComponent(src)}`,
  );
  await screen.unmount();
});

test("without the viewer the file itself is offered", async () => {
  const screen = await render(PdfViewer, { src, filename: "report.pdf", enabled: false });

  expect(screen.container.querySelector("iframe")).toBeNull();
  const link = page.getByRole("link", { name: "Download PDF" });
  await expect.element(link).toBeVisible();
  expect(screen.container.querySelector("a.download")?.getAttribute("href")).toBe(src);
  await screen.unmount();
});
