/**
 * shared/cost.ts — one per-model cost table for the suite.
 *
 * Sourced from the model-registry `cost` field, which pi v0.79.0 exposes as
 * `{ input, output, cacheRead, cacheWrite }` priced per million tokens
 * (docs/models.md:208). `cacheRead` is the cached-input price the prefix-churn
 * accounting (#338) needs. Local models are priced at zero.
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

/** A registry entry carrying an optional (possibly partial) cost. */
export interface CostModel {
  readonly provider: string;
  readonly id: string;
  readonly cost?: Partial<ModelCost> | undefined;
}

/** Canonical `provider/id` key. */
export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Normalize a possibly-partial cost into a full `ModelCost` (missing fields -> 0). */
export function normalizeCost(cost?: Partial<ModelCost>): ModelCost {
  return { ...ZERO_COST, ...(cost ?? {}) };
}

/** Build a `provider/id` -> `ModelCost` table from registry entries. */
export function buildCostTable(models: readonly CostModel[]): Map<string, ModelCost> {
  const table = new Map<string, ModelCost>();
  for (const m of models) {
    table.set(modelKey(m.provider, m.id), normalizeCost(m.cost));
  }
  return table;
}

/** Look up a model's cost; unknown models fall back to `ZERO_COST`. */
export function lookupCost(
  table: ReadonlyMap<string, ModelCost>,
  provider: string,
  id: string,
): ModelCost {
  return table.get(modelKey(provider, id)) ?? ZERO_COST;
}
