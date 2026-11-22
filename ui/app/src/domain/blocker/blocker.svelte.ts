import type { BlockerListsView, BlockerStatusView, OperationAdmission } from "$shared/ipc/bindings";
import { commands } from "$shared/ipc/bindings";
import { events } from "$shared/ipc/native-events";
import { BLOCKER_ZERO_REVISION, initialBlockerStatus, newestBlockerStatus } from "./blocker-model";
import { operations } from "$domain/operations";
import { createSlice } from "$shared/lib/lifecycle";

let state = $state.raw<BlockerStatusView>(initialBlockerStatus());

const RECONCILE_ATTEMPTS = 3;
const RECONCILE_RETRY_MS = 500;
const IPC_ATTEMPT_TIMEOUT_MS = 2_000;
const MUTATION_ADMISSION_TIMEOUT_MS = 5_000;

let reconciling: Promise<void> | null = null;

export const status = () => state;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function boundedIpc<T>(request: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("bounded privileged IPC timeout")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function apply(candidate: BlockerStatusView) {
  const newest = newestBlockerStatus(state, candidate);
  if (newest !== state) state = newest;
}

async function reconcileStatus(generation: number) {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS && slice.isCurrent(generation); attempt += 1) {
    try {
      const response = await boundedIpc(commands.blockerStatus(), IPC_ATTEMPT_TIMEOUT_MS);
      if (!slice.isCurrent(generation)) return;
      if (response.status !== "ok") {
        await delay(RECONCILE_RETRY_MS);
        continue;
      }
      const result = response.data;
      apply(result);
      if (result.projection_revision !== BLOCKER_ZERO_REVISION) return;
    } catch {
      // Setup/navigation races are bounded and reconciled by the scoped event
      // listener. Never turn diagnostics failure into browser startup failure.
    }
    await delay(RECONCILE_RETRY_MS);
  }
}

function beginReconciliation(generation: number): Promise<void> {
  if (reconciling !== null) return reconciling;
  const task = reconcileStatus(generation);
  reconciling = task;
  void task.then(
    () => {
      if (reconciling === task) reconciling = null;
    },
    () => {
      if (reconciling === task) reconciling = null;
    },
  );
  return task;
}

export const slice = createSlice({
  async register({ generation, isCurrent, attach }) {
    let stop: () => void;
    try {
      stop = await events.blockerStatusChanged.listen((event) => {
        if (isCurrent()) apply(event.payload);
      });
    } catch {
      // The bootstrap query still gives the UI an actor-ordered snapshot. Keep
      // the listener unregistered so opening the popover retries it.
      await beginReconciliation(generation);
      return;
    }
    if (!isCurrent()) {
      stop();
      return;
    }
    attach(stop);
    await beginReconciliation(generation);
  },
  reset() {
    reconciling = null;
  },
});

export const init = () => slice.init();
export const dispose = () => slice.dispose();

export async function refresh(): Promise<void> {
  if (!slice.ready()) {
    await init();
    return;
  }

  const generation = slice.current();
  const active = reconciling;
  if (active !== null) await active;
  if (!slice.isCurrent(generation) || !slice.ready()) return;
  await beginReconciliation(generation);
}

export type BlockerMutationResult =
  operations.OperationResolution | { state: "not_admitted" } | { state: "unavailable" };

export async function settleMutation(
  dispatch: () => Promise<OperationAdmission>,
): Promise<BlockerMutationResult> {
  // Install the operation event listener before admission. The ledger query
  // remains an exact fallback if initialization races trusted UI startup.
  try {
    await operations.init();
  } catch {
    // Do not reject an otherwise valid mutation solely because diagnostics
    // event registration failed; waitForDisposition also queries the ledger.
  }

  let result: BlockerMutationResult;
  try {
    const admission = await boundedIpc(dispatch(), MUTATION_ADMISSION_TIMEOUT_MS);
    if (!admission.accepted) {
      result = { state: "not_admitted" };
    } else if (admission.operation_id === null) {
      // Blocker mutations are actor-owned and must always carry an id. Treat a
      // contradictory admission as unavailable rather than inventing success.
      result = { state: "unavailable" };
    } else {
      result = await operations.waitForDisposition(admission.operation_id);
    }
  } catch {
    result = { state: "unavailable" };
  }

  // Query after terminal settlement (or the bounded wait) so the diagnostic
  // view is based on an actor-ordered projection, not optimistic UI state.
  await refresh();
  return result;
}

export const setEnabled = (enabled: boolean) =>
  settleMutation(() => commands.blockerSetEnabled(enabled));

export const retry = (failedGeneration: string) =>
  settleMutation(() => commands.blockerRetry(failedGeneration));

export const refreshSources = () => settleMutation(() => commands.blockerRefreshSources());

export const resetStats = () => settleMutation(() => commands.blockerResetStats());

export type BlockerConfiguration = {
  listIds: string[] | null;
  updateHours: number | null;
  autoUpdate: boolean | null;
  cosmetic: boolean | null;
  scriptlets: boolean | null;
  mode?: "standard" | "aggressive" | null;
  removeparam?: boolean | null;
  bounce?: boolean | null;
  blockScripts?: boolean | null;
  redirects?: boolean | null;
  cname?: boolean | null;
  customLists?: string[] | null;
  userRules?: string | null;
};

export const configure = (input: BlockerConfiguration) =>
  settleMutation(() =>
    commands.blockerConfigure(
      input.listIds,
      input.updateHours,
      input.autoUpdate,
      input.cosmetic,
      input.scriptlets,
      input.mode ?? null,
      input.removeparam ?? null,
      input.bounce ?? null,
      input.blockScripts ?? null,
      input.redirects ?? null,
      input.cname ?? null,
      input.customLists ?? null,
      input.userRules ?? null,
    ),
  );

/** The Settings page reads lists, schedule and counters through this. */
export async function lists(): Promise<BlockerListsView | null> {
  try {
    const response = await boundedIpc(commands.blockerLists(), IPC_ATTEMPT_TIMEOUT_MS);
    return response.status === "ok" ? response.data : null;
  } catch {
    return null;
  }
}
