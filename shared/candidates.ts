/**
 * shared/candidates.ts — the "models available under this login" menu.
 *
 * Verified against pi v0.79.0 (Phase 0, #328): `ctx.modelRegistry.getAvailable()`
 * returns only models with valid API keys configured (docs/sdk.md), which is
 * exactly the credentialed candidate set the router needs. An optional user
 * allowlist narrows it further.
 */

import { normalizeCost, type ModelCost } from "./cost.ts";

/** Registry model shape consumed here (structural subset of pi's model type). */
export interface RegistryModel {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow?: number | undefined;
  readonly cost?: Partial<ModelCost> | undefined;
}

/** The slice of `ExtensionContext` that `getCandidates` reads. */
export interface CandidatesContext {
  readonly modelRegistry: {
    getAvailable(): Promise<readonly RegistryModel[]> | readonly RegistryModel[];
  };
}

export interface Candidate {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  readonly cost: ModelCost;
}

export interface CandidateOptions {
  /** If set and non-empty, only `provider/id` entries in this list pass. */
  readonly allowlist?: readonly string[] | undefined;
  /** Context-window fallback when the registry omits it. Defaults to 128000. */
  readonly defaultContextWindow?: number | undefined;
  /**
   * Live availability filter for `github-copilot` models (#343, ADR-0035): a
   * non-empty set of genuinely-usable copilot model ids. A copilot candidate
   * whose id is absent is dropped; non-copilot candidates are never affected.
   * `null`/`undefined`/empty disables the filter (the static menu is unchanged),
   * so a failed or zero-result discovery can never empty the menu. Composes with
   * `allowlist` as AND — a candidate must pass both.
   */
  readonly copilotFilter?: ReadonlySet<string> | null | undefined;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Compute the credentialed candidate menu, optionally filtered by an allowlist.
 * `getAvailable()` may be sync or async (#328) — both are awaited safely.
 */
export async function getCandidates(
  ctx: CandidatesContext,
  options: CandidateOptions = {},
): Promise<Candidate[]> {
  const available = await ctx.modelRegistry.getAvailable();
  const allow =
    options.allowlist && options.allowlist.length > 0 ? new Set(options.allowlist) : null;
  // Only an active (non-empty) copilot filter narrows the menu; null/empty is a
  // no-op, so a failed or zero-result discovery never empties the menu (#343).
  const copilotFilter =
    options.copilotFilter && options.copilotFilter.size > 0 ? options.copilotFilter : null;
  const fallbackWindow = options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;

  const out: Candidate[] = [];
  for (const m of available) {
    // allowlist AND live-copilot-filter both apply; neither bypasses the other.
    if (allow && !allow.has(`${m.provider}/${m.id}`)) continue;
    if (copilotFilter && m.provider === "github-copilot" && !copilotFilter.has(m.id)) continue;
    out.push({
      provider: m.provider,
      id: m.id,
      contextWindow: m.contextWindow ?? fallbackWindow,
      cost: normalizeCost(m.cost),
    });
  }
  return out;
}
