import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { commands } from "$shared/ipc/bindings";
import type {
  GalleryCall,
  GalleryFolder,
  GalleryItem,
  GalleryPage,
  GalleryState,
} from "$shared/ipc/bindings";

const PAGE = 160;
const POLL_MS = 320;
const THUMB_CONCURRENCY = 3;
const PREVIEW_BUDGET = 10;

function isPage(value: unknown): value is GalleryPage {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "list";
}

function isState(value: unknown): value is GalleryState {
  return !!value && typeof value === "object" && (value as { kind?: string }).kind === "state";
}

/**
 * The Gallery page's own projection. One session per page mount, bound to the
 * profile it opened for: a second window gets a second list, and leaving the
 * page drops every timer, queued decode and in-memory picture.
 *
 * The host does the walking and decoding; this class only pages the index,
 * asks for the pictures that come into view, and ignores every answer that
 * arrives after the page it belongs to has gone.
 */
export class GallerySession {
  readonly profile: string;
  enabled = $state(true);
  folders = $state.raw<GalleryFolder[]>([]);
  items = $state.raw<GalleryItem[]>([]);
  total = $state(0);
  next = $state<number | null>(null);
  scanning = $state(false);
  truncated = $state(false);
  scannedAt = $state<number | null>(null);
  cacheBytes = $state(0);
  cacheCount = $state(0);
  error = $state<string | null>(null);
  loading = $state(false);
  loadingMore = $state(false);
  query = $state("");
  folder = $state<string | null>(null);

  /** Small, resized previews by picture path. */
  thumbs = new SvelteMap<string, string>();
  /** A path the host could not decode, so the tile shows a file mark. */
  failed = new SvelteMap<string, string>();
  /** The few full-size previews the viewer has asked for. */
  previews = new SvelteMap<string, string>();

  private active = false;
  private generation = 0;
  private requestSeq = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: GalleryItem[] = [];
  private queued = new SvelteSet<string>();
  private inFlight = new SvelteSet<string>();
  private activeThumbs = 0;
  private previewPending = new SvelteMap<string, Promise<string | null>>();

  constructor(profile: string) {
    this.profile = profile;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    await this.load(true);
  }

  stop() {
    this.active = false;
    this.generation += 1;
    this.requestSeq += 1;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.queue = [];
    this.queued.clear();
    this.inFlight.clear();
    this.activeThumbs = 0;
    this.previewPending.clear();
    this.items = [];
    this.thumbs.clear();
    this.failed.clear();
    this.previews.clear();
  }

  /** The list as it is now, with the newest scan generation stamped onto it. */
  private apply(page: GalleryPage, reset: boolean) {
    this.enabled = page.enabled !== false;
    this.folders = page.folders;
    this.total = page.total;
    this.next = page.next;
    this.scanning = page.scanning;
    this.truncated = page.truncated;
    this.scannedAt = page.scanned_at;
    if (reset) {
      this.items = page.items;
    } else {
      const seen = new SvelteSet(this.items.map((item) => item.path));
      this.items = [...this.items, ...page.items.filter((item) => !seen.has(item.path))];
    }
    this.error = null;
  }

  private applyState(state: GalleryState) {
    this.enabled = state.enabled;
    this.folders = state.folders;
    this.total = state.total;
    this.scanning = state.scanning;
    this.truncated = state.truncated;
    this.scannedAt = state.scanned_at;
    this.cacheBytes = state.cache_bytes;
    this.cacheCount = state.cache_count;
    this.error = null;
  }

  private schedulePoll(generation: number) {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (!this.scanning || !this.active) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.active || generation !== this.generation) return;
      void this.load(true, true);
    }, POLL_MS);
  }

  /** Load the first page (or the next one). Keeps the old list while a poll runs. */
  async load(reset = true, silent = false) {
    if (!this.active) return;
    if (!reset && (this.next === null || this.loadingMore)) return;
    const generation = this.generation;
    const seq = ++this.requestSeq;
    if (reset) {
      if (!silent) this.loading = this.items.length === 0;
    } else {
      this.loadingMore = true;
    }
    try {
      const call: GalleryCall = {
        kind: "list",
        query: this.query.trim(),
        folder: this.folder,
        offset: reset ? 0 : (this.next ?? 0),
        limit: PAGE,
      };
      const response = await commands.mediaGallery(this.profile, call);
      if (!this.active || generation !== this.generation || seq !== this.requestSeq) return;
      if (isPage(response)) {
        this.apply(response, reset);
        this.schedulePoll(generation);
      } else if (response && response.kind === "error") {
        this.error = response.error;
      } else {
        this.error = "unavailable";
      }
    } catch {
      if (this.active && generation === this.generation && seq === this.requestSeq) {
        this.error = "unavailable";
      }
    } finally {
      if (generation === this.generation && seq === this.requestSeq) {
        this.loading = false;
        this.loadingMore = false;
      }
    }
  }

  /** Re-query with the same folder filter, from the first page. */
  reload() {
    // `null`, not 0: the grid's sentinel treats any non-null offset as a
    // further page, and a reset is still in flight.
    this.next = null;
    // A poll scheduled by the previous page would start after this call and
    // carry the old filter. The new answer schedules its own poll.
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    void this.load(true);
  }

  async more() {
    if (this.loading || this.loadingMore) return;
    await this.load(false);
  }

  setFolder(path: string | null) {
    if (this.folder === path) return;
    this.folder = path;
    this.reload();
  }

  /**
   * Searching filters the index the host already built, so it costs one list
   * call and no folder walk. Older answers are dropped by `requestSeq`; a
   * timer here can be cancelled by a session restart before it runs.
   */
  setQuery(value: string) {
    this.query = value;
    this.reload();
  }

  async refresh() {
    if (!this.active) return;
    const generation = this.generation;
    this.loading = this.items.length === 0;
    try {
      const response = await commands.mediaGallery(this.profile, { kind: "refresh" });
      if (!this.active || generation !== this.generation) return;
      if (isState(response)) this.applyState(response);
      else if (response && response.kind === "error") this.error = response.error;
      await this.load(true, true);
    } catch {
      if (this.active && generation === this.generation) this.error = "unavailable";
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  async enable() {
    if (!this.active) return;
    const generation = this.generation;
    try {
      const response = await commands.mediaGallery(this.profile, {
        kind: "set_enabled",
        enabled: true,
      });
      if (!this.active || generation !== this.generation) return;
      if (isState(response)) this.applyState(response);
      await this.load(true);
    } catch {
      if (this.active && generation === this.generation) this.error = "unavailable";
    }
  }

  /** Ask for one tile's picture, at most once and only when it is near view. */
  want(item: GalleryItem) {
    if (!this.active) return;
    if (this.thumbs.has(item.path) || this.failed.has(item.path)) return;
    if (this.queued.has(item.path) || this.inFlight.has(item.path)) return;
    this.queued.add(item.path);
    this.queue.push(item);
    this.pump();
  }

  private pump() {
    while (this.activeThumbs < THUMB_CONCURRENCY && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.queued.delete(item.path);
      if (this.thumbs.has(item.path) || this.failed.has(item.path)) continue;
      this.inFlight.add(item.path);
      this.activeThumbs += 1;
      const generation = this.generation;
      void commands
        .mediaGallery(this.profile, { kind: "thumbnail", path: item.path, size: 480 })
        .then((response) => {
          if (!this.active || generation !== this.generation) return;
          if (response && response.kind === "thumbnail" && response.data) {
            this.thumbs.set(item.path, response.data);
          } else {
            this.failed.set(
              item.path,
              response && response.kind === "thumbnail"
                ? (response.error ?? "unsupported")
                : "unavailable",
            );
          }
        })
        .catch(() => {
          if (this.active && generation === this.generation) {
            this.failed.set(item.path, "unavailable");
          }
        })
        .finally(() => {
          this.inFlight.delete(item.path);
          this.activeThumbs = Math.max(0, this.activeThumbs - 1);
          if (this.active) this.pump();
        });
    }
  }

  /**
   * The viewer's larger copy. Kept to a few entries because a preview is much
   * heavier than a tile; the oldest is dropped when the budget is reached.
   */
  preview(item: GalleryItem): Promise<string | null> {
    if (!this.active) return Promise.resolve(null);
    const ready = this.previews.get(item.path);
    // No read-time eviction/rewrite: this method is called from a viewer
    // effect, and mutating a map the call reads would feed the effect again.
    if (ready) return Promise.resolve(ready);
    const pending = this.previewPending.get(item.path);
    if (pending) return pending;
    const generation = this.generation;
    const task = commands
      .mediaGallery(this.profile, { kind: "thumbnail", path: item.path, size: 1800 })
      .then((response) => {
        if (!this.active || generation !== this.generation) return null;
        const data =
          response && response.kind === "thumbnail" && response.data ? response.data : null;
        if (data) {
          this.previews.set(item.path, data);
          while (this.previews.size > PREVIEW_BUDGET) {
            const oldest = this.previews.keys().next().value;
            if (oldest === undefined) break;
            this.previews.delete(oldest);
          }
        }
        return data;
      })
      .catch(() => null)
      .finally(() => {
        this.previewPending.delete(item.path);
      });
    this.previewPending.set(item.path, task);
    return task;
  }

  /** The file commands the viewer's menu offers. */
  async act(kind: "open" | "reveal" | "copy", item: GalleryItem): Promise<boolean> {
    if (!this.active) return false;
    try {
      const response = await commands.mediaGallery(this.profile, { kind, path: item.path });
      return !!response && response.kind === "action" && response.ok;
    } catch {
      return false;
    }
  }

  async opener(item: GalleryItem): Promise<string> {
    try {
      const response = await commands.mediaGallery(this.profile, {
        kind: "opener",
        path: item.path,
      });
      return response && response.kind === "opener" ? response.opener : "";
    } catch {
      return "";
    }
  }
}
