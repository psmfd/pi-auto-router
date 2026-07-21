/**
 * shared/cost.ts — the suite's per-model cost shape and normalizer.
 *
 * Sourced from the model-registry `cost` field, exposed as
 * `{ input, output, cacheRead, cacheWrite }` priced per million tokens
 * (docs/models.md). `cacheRead` is the cached-input price the prefix-churn
 * accounting (#338) needs. Local models are priced at zero. Consumed via
 * candidates.ts (`normalizeCost`/`ModelCost`) — a build-a-table lookup API
 * (`buildCostTable`/`lookupCost`) shipped here unconsumed from inception and
 * was removed in the #788 review.
 */

export interface ModelCost {
  /** Fresh input price per million tokens. */
  readonly input: number;
  /** Output price per million tokens. */
  readonly output: number;
  /** Cached-input read price per million tokens (cheaper than `input`). */
  readonly cacheRead: number;
  /** Cache-write price per million tokens. */
  readonly cacheWrite: number;
}

export const ZERO_COST: ModelCost = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

/** Normalize a possibly-partial cost into a full `ModelCost` (missing fields -> 0). */
export function normalizeCost(cost?: Partial<ModelCost>): ModelCost {
  return { ...ZERO_COST, ...(cost ?? {}) };
}
