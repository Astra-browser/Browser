/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from "vitest";
import {
  PDF_MIME,
  PDF_VIEWER_BASE,
  isPdfDownload,
  isPdfFilename,
  pdfOpenAction,
  pdfViewerUrl,
} from "../lib/pdf";

describe("isPdfFilename", () => {
  test.each([
    ["report.pdf", true],
    ["REPORT.PDF", true],
    ["archive.tar.gz", false],
    ["pdf", false],
    ["report.pdfx", false],
    ["report.pdf?download=1", true],
    ["https://example.com/files/report.PDF#page=2", true],
  ])("%s -> %s", (filename, expected) => {
    expect(isPdfFilename(filename)).toBe(expected);
  });
});

describe("isPdfDownload", () => {
  test("mime wins even when the name says otherwise", () => {
    expect(isPdfDownload({ filename: "download", mime: PDF_MIME })).toBe(true);
  });

  test("mime parameters and casing do not matter", () => {
    expect(isPdfDownload({ filename: "download", mime: "Application/PDF; charset=binary" })).toBe(
      true,
    );
  });

  test("name wins when mime is absent", () => {
    expect(isPdfDownload({ filename: "report.pdf", mime: null })).toBe(true);
  });

  test("neither mime nor name -> not a PDF", () => {
    expect(isPdfDownload({ filename: "setup.dmg", mime: "application/octet-stream" })).toBe(false);
    expect(isPdfDownload({ filename: "setup.dmg" })).toBe(false);
  });
});

describe("pdfViewerUrl", () => {
  test("wraps the source as an encoded file parameter", () => {
    const source = "https://example.com/a b.pdf?x=1&y=2#page=3";
    expect(pdfViewerUrl(source)).toBe(`${PDF_VIEWER_BASE}?file=${encodeURIComponent(source)}`);
  });

  test("a custom base overrides the built-in default", () => {
    expect(pdfViewerUrl("https://example.com/a.pdf", "https://viewer.example/v/")).toBe(
      "https://viewer.example/v/?file=https%3A%2F%2Fexample.com%2Fa.pdf",
    );
  });
});

describe("pdfOpenAction", () => {
  const pdf = { filename: "report.pdf", mime: PDF_MIME };

  test("PDFs open in the viewer while it is enabled", () => {
    expect(pdfOpenAction(pdf)).toBe("view");
  });

  test("a disabled viewer falls back to the OS handler", () => {
    expect(pdfOpenAction(pdf, false)).toBe("open");
  });

  test("non-PDFs always use the OS handler", () => {
    expect(pdfOpenAction({ filename: "setup.dmg", mime: "application/octet-stream" })).toBe("open");
  });
});
