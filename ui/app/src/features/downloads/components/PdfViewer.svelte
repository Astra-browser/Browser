<!-- This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->
<!-- PDF viewing (P4-T08): a finished PDF opens inside Firefox's built-in
   viewer. The iframe wraps the engine's bundled pdf.js document
   (`resource://pdf.js/web/viewer.html`, see `lib/pdf.ts` + the PDF decision
   in docs/astra/DOWNLOADS.md); the host keeps owning the bytes, so no
   custom renderer, worker, or extra dependency ships in this lane. Where the
   viewer is unavailable (standalone goldens/dev over http(s), viewer
   disabled) the fallback offers the file itself instead of a dead frame. -->
<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { PDF_VIEWER_BASE, pdfViewerUrl } from "../lib/pdf";

  let {
    src,
    filename,
    viewerBase = PDF_VIEWER_BASE,
    enabled = true,
  }: {
    /** Where the finished PDF bytes live (download URL or object URL). */
    src: string;
    /** Shown in the frame title and the fallback link. */
    filename: string;
    /** Viewer document base; override for tests and future ESR moves. */
    viewerBase?: string;
    /** False outside Firefox chrome, where `resource://` cannot resolve. */
    enabled?: boolean;
  } = $props();

  let viewer = $derived(pdfViewerUrl(src, viewerBase));
</script>

{#if enabled}
  <iframe class="pdf-viewer" src={viewer} title={m.download_open_named({ name: filename })}
  ></iframe>
{:else}
  <div class="pdf-fallback" role="status">
    <p>{m.download_open_named({ name: filename })}</p>
    <!-- TODO(P4-T08 assembly): move to messages/en.json; new keys are outside this lane. -->
    <a class="download" href={src} download={filename}>Download PDF</a>
  </div>
{/if}

<style>
  .pdf-viewer {
    display: block;
    width: 100%;
    min-height: 480px;
    border: 0;
    border-radius: var(--radius-row);
    background: var(--color-fill);
  }

  .pdf-fallback {
    display: grid;
    gap: 8px;
    justify-items: start;
    padding: 16px;
    border-radius: var(--radius-row);
    background: var(--color-fill);
    color: var(--color-text);
    font-size: var(--text-label);
  }

  .pdf-fallback p {
    margin: 0;
    overflow: hidden;
    max-width: 100%;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .pdf-fallback .download {
    color: var(--color-accent);
  }
</style>
