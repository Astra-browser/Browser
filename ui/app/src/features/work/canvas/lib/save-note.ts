/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** A document doc as the person's note.
 *
 *  The same path the notes UI uses: `documentMarkdown` renders the title
 *  and the formatted document (or its paragraphs), then `WorkNotes.save`
 *  writes it as one new note. Only document docs persist; anything else
 *  has no Markdown to keep.
 */
import type { NoteSession } from "$domain/notes";
import { documentMarkdown, type WorkNotes } from "../../lib/work-notes";
import type { CanvasDoc } from "./types";

/** The doc as note Markdown; null when it is not a document. */
export function canvasNoteMarkdown(doc: CanvasDoc): string | null {
  if (doc.kind !== "document") return null;
  return documentMarkdown(doc.artifact);
}

/**
 * Writes the doc as a new note only when asked, and once per doc: the
 * note itself lives in Notes, this only remembers which one a doc became.
 */
export function saveCanvasNote(
  notes: WorkNotes,
  doc: CanvasDoc,
  key: string,
  session: NoteSession | null,
): Promise<string | null> {
  const markdown = canvasNoteMarkdown(doc);
  if (!markdown) return Promise.resolve(null);
  return notes.save(key, markdown, session);
}
