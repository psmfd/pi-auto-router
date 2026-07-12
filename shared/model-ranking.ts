/**
 * shared/model-ranking.ts — deterministic model ranking primitives shared by
 * auto-router and subagent policy.
 *
 * The capability floor is separate from cost: a caller first constrains the
 * candidate set to models declared capable for the task, then ranks the
 * remaining live/window-adequate candidates. When local use is allowed, local
 * providers rank above non-local providers before cost. Within each lane, the
 * cheapest capable model wins using the ADR-0078 scalar `input + k·output`.
 */

import type { Candidate } from "./candidates.ts";
import type { MatrixTier, RoutingMatrix } from "./routing-matrix.ts";
import { THRESHOLDS, type NormalizedUsage } from "./signals.ts";

/** The output weight in the matrix cost-rank scalar `input + k·output`. */
export const COST_RANK_K = 1;

/** Default local provider ids. Strict provider equality; no prefix matching. */
export const DEFAULT_LOCAL_PROVIDERS = ["omlx"] as const;

export interface RankOptions {
  /** Whether local candidates form the first ranking lane. Defaults to true. */
  readonly preferLocal?: boolean | undefined;
  /** Provider ids treated as local. Defaults to `omlx`. */
  readonly localProviders?: readonly string[] | undefined;
}

/** The matrix cost-rank scalar (ADR-0078) — dollars per Mtok, both axes. */
export function costRank(c: Candidate): number {
  return c.cost.input + COST_RANK_K * c.cost.output;
}

function localProviderSet(options: RankOptions): ReadonlySet<string> {
  return new Set(options.localProviders ?? DEFAULT_LOCAL_PROVIDERS);
}

/** True when a candidate belongs to a configured local provider lane. */
export function isLocalCandidate(c: Candidate, options: RankOptions = {}): boolean {
  return localProviderSet(options).has(c.provider);
}

/** Deterministic local-first, cheapest-capable ordering for already-eligible candidates. */
export function orderRankedCandidates(
  candidates: readonly Candidate[],
  options: RankOptions = {},
): Candidate[] {
  const preferLocal = options.preferLocal ?? true;
  return [...candidates].sort((a, b) => {
    if (preferLocal) {
      const localDelta = Number(isLocalCandidate(b, options)) - Number(isLocalCandidate(a, options));
      if (localDelta !== 0) return localDelta;
    }
    return (
      costRank(a) - costRank(b) ||
      a.contextWindow - b.contextWindow ||
      `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
    );
  });
}

/**
 * Deterministic capability-matrix pick: local-first (when allowed), then
 * cheapest capable live/window-adequate candidate. Returns null when the
 * matrix is unavailable, task type is unknown, or any filter stage empties.
 */
export function resolveCapabilityPick(
  candidates: readonly Candidate[],
  taskType: string,
  matrix: RoutingMatrix | null,
  unavailable: ReadonlySet<string>,
  usage: NormalizedUsage | null,
  options: RankOptions = {},
): Candidate | null {
  if (matrix === null || taskType === "unknown") return null;
  const eligible = candidates.filter((c) => {
    const key = `${c.provider}/${c.id}`;
    const entry = matrix.models[key];
    if (!entry || !entry.capable.includes(taskType)) return false;
    if (unavailable.has(key)) return false;
    if (usage !== null && usage.tokens / c.contextWindow >= THRESHOLDS.FORCE_COMPACT_AT) {
      return false;
    }
    return true;
  });
  return orderRankedCandidates(eligible, options)[0] ?? null;
}

/** Numeric rank of a tier, for "requested tier or better" comparisons. */
const TIER_RANK: Readonly<Record<MatrixTier, number>> = { frontier: 3, capable: 2, fast: 1 };

/**
 * Deterministic quality-first tier pick (#656): among candidates whose matrix
 * row declares a tier at or above the requested one AND covers `taskType`,
 * pick the highest tier — cost deliberately drops out of the ordering (an
 * agent that requested a tier said quality decides, not price). Ties break on
 * larger context window, then `provider/id` lexical order, so the pick never
 * depends on menu order. Untiered rows never satisfy a tier request. Returns
 * null when the matrix is unavailable or no row qualifies — callers fall
 * through their own ladder, same contract as resolveCapabilityPick.
 *
 * Provider-agnostic by construction: rows for any provider (OpenAI,
 * Anthropic, Copilot, local) qualify identically; a row whose provider has no
 * credentialed candidate simply never appears in `candidates` and is inert.
 */
export function resolveTierPick(
  candidates: readonly Candidate[],
  tier: MatrixTier,
  taskType: string,
  matrix: RoutingMatrix | null,
  unavailable: ReadonlySet<string>,
): Candidate | null {
  if (matrix === null) return null;
  const wanted = TIER_RANK[tier];
  const eligible = candidates.filter((c) => {
    const key = `${c.provider}/${c.id}`;
    const entry = matrix.models[key];
    if (!entry?.tier || TIER_RANK[entry.tier] < wanted) return false;
    if (!entry.capable.includes(taskType)) return false;
    return !unavailable.has(key);
  });
  return (
    [...eligible].sort((a, b) => {
      const tierDelta =
        TIER_RANK[matrix.models[`${b.provider}/${b.id}`].tier as MatrixTier] -
        TIER_RANK[matrix.models[`${a.provider}/${a.id}`].tier as MatrixTier];
      return (
        tierDelta ||
        b.contextWindow - a.contextWindow ||
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)
      );
    })[0] ?? null
  );
}
