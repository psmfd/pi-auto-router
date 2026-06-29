/**
 * shared/signals.ts — normalized context-usage signal + suite thresholds.
 *
 * Single source of truth for "how full is the context" across the suite
 * (auto-router, context-manager, indexing). Pure functions, structurally typed
 * against the slice of `ExtensionContext` they need so they unit-test without a
 * live pi runtime.
 *
 * Verified against pi v0.79.0 (Phase 0, issue #328):
 *   - `ctx.getContextUsage()` returns usage with `.tokens`; MAY be undefined
 *     (docs/extensions.md:958 — "uses last assistant usage when available,
 *     then estimates tokens for trailing messages").
 *   - context-window size comes from `ctx.model.contextWindow` (docs/models.md).
 */

/** Suite-wide usage thresholds (fraction of the context window, 0..1). */
export const THRESHOLDS = {
  /** Begin pruning stale/oversized tool output. */
  PRUNE_AT: 0.7,
  /** Bias the router toward a larger-window model. */
  ESCALATE_AT: 0.85,
  /** Force compaction before the next turn. */
  FORCE_COMPACT_AT: 0.9,
} as const;

export type UsageLevel = "ok" | "prune" | "escalate" | "force";

export interface NormalizedUsage {
  /** Estimated tokens currently in context. */
  readonly tokens: number;
  /** Active model's context-window size in tokens. */
  readonly window: number;
  /** `tokens / window`, clamped to >= 0 (may exceed 1 when over the window). */
  readonly pct: number;
  /** Threshold band the current usage falls into. */
  readonly level: UsageLevel;
}

/** The slice of `ExtensionContext` that `getUsage` reads. */
export interface UsageContext {
  getContextUsage(): { readonly tokens?: number } | undefined | null;
  readonly model?: { readonly contextWindow?: number } | undefined;
}

/** Map a usage fraction to its threshold band. */
export function classify(pct: number): UsageLevel {
  if (pct >= THRESHOLDS.FORCE_COMPACT_AT) return "force";
  if (pct >= THRESHOLDS.ESCALATE_AT) return "escalate";
  if (pct >= THRESHOLDS.PRUNE_AT) return "prune";
  return "ok";
}

/**
 * Read and normalize the current context usage. Returns `null` when usage or
 * the window size is unavailable (callers must treat `null` as "unknown", never
 * as "empty") — see #328 finding F.
 */
export function getUsage(ctx: UsageContext): NormalizedUsage | null {
  const usage = ctx.getContextUsage();
  const tokens = usage?.tokens;
  const window = ctx.model?.contextWindow;
  if (typeof tokens !== "number" || typeof window !== "number" || window <= 0) {
    return null;
  }
  const pct = Math.max(0, tokens / window);
  return { tokens, window, pct, level: classify(pct) };
}
