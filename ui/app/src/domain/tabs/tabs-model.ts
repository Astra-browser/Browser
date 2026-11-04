import type { ItemsState, TabView } from "$shared/ipc/bindings";

export const ZERO_PROJECTION_REVISION = "00000000000000000000000000000000";

export type PresentationTab = {
  tab: TabView;
  active: string | null;
};

export function initialItemsState(): ItemsState {
  return {
    projection_revision: ZERO_PROJECTION_REVISION,
    profile: null,
    spaces: [],
    active_space_id: null,
    nodes: [],
    tabs: [],
    active: null,
    split_group: null,
  };
}

/**
 * Framework-free projection admission for privileged browser chrome.
 *
 * Rust emits fixed-width lowercase hexadecimal revisions from one monotonic
 * process-local sequence. Lexicographic ordering is therefore exact. Keep
 * this admission layer independent of Svelte so rendering migrations cannot
 * weaken stale-projection rejection.
 */
export class TabProjectionModel {
  #state: ItemsState;
  #appliedGlobalRevision: string;
  readonly #appliedTabRevisions = new Map<string, string>();

  constructor(initial: ItemsState = initialItemsState()) {
    this.#state = initial;
    this.#appliedGlobalRevision = initial.projection_revision;
    for (const tab of initial.tabs) {
      this.#appliedTabRevisions.set(tab.id, tab.projection_revision);
    }
  }

  get value(): ItemsState {
    return this.#state;
  }

  applySnapshot(candidate: ItemsState): boolean {
    if (candidate.projection_revision <= this.#appliedGlobalRevision) return false;

    this.#appliedGlobalRevision = candidate.projection_revision;
    // Closed tabs must not keep a revision forever.
    const liveIds = new Set(candidate.tabs.map((tab) => tab.id));
    for (const id of this.#appliedTabRevisions.keys()) {
      if (!liveIds.has(id)) this.#appliedTabRevisions.delete(id);
    }
    for (const tab of candidate.tabs) {
      const previous = this.#appliedTabRevisions.get(tab.id);
      if (previous === undefined || tab.projection_revision > previous) {
        this.#appliedTabRevisions.set(tab.id, tab.projection_revision);
      }
    }
    // Native keeps an unchanged tab's revision; keeping its object too means
    // a tab switch re-renders only the rows that changed.
    const kept = new Map(this.#state.tabs.map((tab) => [tab.id, tab]));
    const tabs = candidate.tabs.map((tab) => {
      const previous = kept.get(tab.id);
      return previous?.projection_revision === tab.projection_revision ? previous : tab;
    });
    this.#state = { ...candidate, tabs };
    return true;
  }

  applyTab(tab: TabView): boolean {
    const index = this.#state.tabs.findIndex((candidate) => candidate.id === tab.id);
    // A delta for a tab the snapshot does not hold is stale; the snapshot is
    // the owner of membership.
    if (index === -1) return false;
    if (!this.#admitTabRevision(tab)) return false;
    const tabs = this.#state.tabs.slice();
    tabs[index] = tab;
    this.#state = { ...this.#state, tabs };
    return true;
  }

  applyPresentation({ tab, active }: PresentationTab): boolean {
    // A presentation carries the active tab as it was when it was sent. One
    // that arrives after a newer snapshot (a page restored on the way out of
    // Settings, then a new tab opened) still brings its tab up to date, but
    // the snapshot's choice of tab stands.
    const current = tab.projection_revision > this.#appliedGlobalRevision;
    const index = this.#state.tabs.findIndex((candidate) => candidate.id === tab.id);
    // The snapshot owns membership; a presentation for a tab it no longer
    // holds is stale, and adopting it would strand a revision with no row.
    if (index === -1) return false;
    if (!this.#admitTabRevision(tab)) return false;

    const tabs = this.#state.tabs.slice();
    tabs[index] = tab;
    const nextActive =
      current && (active === null || tabs.some((entry) => entry.id === active))
        ? active
        : this.#state.active;
    this.#state = { ...this.#state, tabs, active: nextActive };
    return true;
  }

  #admitTabRevision(tab: TabView): boolean {
    const previous = this.#appliedTabRevisions.get(tab.id) ?? ZERO_PROJECTION_REVISION;
    if (tab.projection_revision <= previous) return false;

    this.#appliedTabRevisions.set(tab.id, tab.projection_revision);
    if (tab.projection_revision > this.#appliedGlobalRevision) {
      this.#appliedGlobalRevision = tab.projection_revision;
    }
    return true;
  }
}
