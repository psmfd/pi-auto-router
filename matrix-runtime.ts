import type { AvailabilitySnapshot } from "./shared/availability-snapshot.ts";
import type { MatrixLoadResult } from "./shared/routing-matrix.ts";

export interface MatrixRefreshDeps {
  readonly loadMatrix: () => Promise<MatrixLoadResult>;
  readonly clearAvailabilitySnapshot: () => void;
  readonly clearCopilotCache: () => void;
  readonly clearAnthropicCache: () => void;
  readonly clearOmlxCache: () => void;
  readonly buildSnapshot: () => Promise<AvailabilitySnapshot>;
  readonly clearDecisionCache: () => void;
  readonly unavailable: Set<string>;
}

export interface MatrixRefreshResult {
  readonly matrixLoad: MatrixLoadResult;
  readonly snapshot: AvailabilitySnapshot | null;
  readonly snapshotError?: string;
  readonly retriedUnavailable: boolean;
}

/**
 * Explicit in-session refresh orchestration (#749). Policy is read-only: this
 * clears memory caches, reloads the committed matrix, and builds one new shared
 * snapshot generation. Session provider-error denies survive unless the user
 * explicitly requests retry.
 */
export async function refreshMatrixRuntime(
  deps: MatrixRefreshDeps,
  retryUnavailable: boolean,
): Promise<MatrixRefreshResult> {
  deps.clearAvailabilitySnapshot();
  deps.clearCopilotCache();
  deps.clearAnthropicCache();
  deps.clearOmlxCache();
  deps.clearDecisionCache();
  if (retryUnavailable) deps.unavailable.clear();

  const matrixLoad = await deps.loadMatrix();
  try {
    const snapshot = await deps.buildSnapshot();
    return { matrixLoad, snapshot, retriedUnavailable: retryUnavailable };
  } catch {
    return {
      matrixLoad,
      snapshot: null,
      snapshotError: "snapshot-build-failed",
      retriedUnavailable: retryUnavailable,
    };
  }
}
