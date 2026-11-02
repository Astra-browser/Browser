/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test, vi } from "vitest";
import type { NoteSession } from "$domain/notes";
import { mockCanvasDocs } from "../lib/mock-stream";
import { canvasNoteMarkdown, saveCanvasNote } from "../lib/save-note";
import type { WorkNotes } from "../../lib/work-notes";

const docs = () => mockCanvasDocs();
const byKind = (kind: string) => docs().find((doc) => doc.kind === kind)!;

test("a document doc renders as its title plus its paragraphs", () => {
  const markdown = canvasNoteMarkdown(byKind("document"));
  expect(markdown).toContain("# Lisbon notes");
  expect(markdown).toContain("Three nights in Lisbon");
});

test("anything but a document has no Markdown to keep", () => {
  for (const kind of ["table", "chart", "diagram", "plan", "code"] as const) {
    expect(canvasNoteMarkdown(byKind(kind))).toBeNull();
  }
});

test("saving writes the Markdown once through WorkNotes, and never for other kinds", async () => {
  const notes = { save: vi.fn(async () => "note-1") } as unknown as WorkNotes;
  const session = {} as unknown as NoteSession;
  const document = byKind("document");
  await expect(saveCanvasNote(notes, document, document.id, session)).resolves.toBe("note-1");
  expect(notes.save).toHaveBeenCalledExactlyOnceWith(
    document.id,
    canvasNoteMarkdown(document),
    session,
  );
  const table = byKind("table");
  await expect(saveCanvasNote(notes, table, table.id, session)).resolves.toBeNull();
  expect(notes.save).toHaveBeenCalledTimes(1);
});
