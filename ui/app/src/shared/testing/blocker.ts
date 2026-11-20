import type { BlockerStatusView } from "../ipc/bindings";
// A test fixture needs the domain's own initial projection so a fixture cannot
// drift from the product; the boundary policy has no shared -> domain edge.
// eslint-disable-next-line boundaries/dependencies
import { initialBlockerStatus } from "$domain/blocker";

/**
 * A blocker the host has already reconciled: active, authoritative and with a
 * settled (non-zero) projection revision. Chrome reads that revision to decide
 * whether a status still needs polling, so a fixture that leaves it at the
 * zero revision makes every mount retry and keeps the window awake.
 */
export function blockerStatusFixture(
  overrides: Partial<BlockerStatusView> = {},
): BlockerStatusView {
  return {
    ...initialBlockerStatus(),
    projection_revision: "1".padStart(32, "0"),
    protection: "active",
    phase: "ready",
    preference: "authoritative",
    config_revision: null,
    desired_enabled: true,
    applied_enabled: true,
    desired_generation: "1",
    retained_generation: "1",
    failure: null,
    retryable: false,
    source_phase: "fresh",
    ...overrides,
  };
}
