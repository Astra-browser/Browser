/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// PDF helpers (P4-T08). Pure, framework-free: the unit project drives them
// with no DOM. Viewer integration embeds Firefox's built-in pdf.js viewer
// (see docs/astra/DOWNLOADS.md for the built-in vs custom decision).

/** MIME type Firefox assigns to PDF documents. */
export const PDF_MIME = "application/pdf";

/**
 * Built-in viewer document. Firefox serves its bundled pdf.js viewer here;
 * the document to show is passed as an encoded `?file=` value. The exact
 * resource path is pinned against the ESR in use at assembly time
 * (docs/astra/DOWNLOADS.md §PDF decision); callers that need a different
 * base (tests, future ESR moves) pass it explicitly.
 */
export const PDF_VIEWER_BASE = "resource://pdf.js/web/viewer.html";

/** True when the name ends in `.pdf` (case-insensitive, ignores URL query/fragment). */
export function isPdfFilename(filename: string): boolean {
  const bare = filename.split(/[?#]/u, 1)[0] ?? "";
  return bare.toLowerCase().endsWith(".pdf");
}

/** True when either the MIME type or the filename says PDF. */
export function isPdfDownload(entry: { filename: string; mime?: string | null }): boolean {
  if (entry.mime?.split(";")[0]?.trim().toLowerCase() === PDF_MIME) return true;
  return isPdfFilename(entry.filename);
}

/** Viewer URL wrapping `source`. The source is always encoded: raw `file=` values break on `&`/`#`. */
export function pdfViewerUrl(source: string, base: string = PDF_VIEWER_BASE): string {
  return `${base}?file=${encodeURIComponent(source)}`;
}

export type PdfOpenAction = "view" | "open";

/**
 * Where a finished download should go: inside the built-in viewer for PDFs
 * while the viewer is enabled, back to the OS handler otherwise.
 */
export function pdfOpenAction(
  entry: { filename: string; mime?: string | null },
  viewerEnabled: boolean = true,
): PdfOpenAction {
  return viewerEnabled && isPdfDownload(entry) ? "view" : "open";
}
