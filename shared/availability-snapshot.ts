/**
 * Canonical, session-frozen model availability shared by auto-router and the
 * subagent spawn policy (#748). The snapshot captures one registry read, then
 * composes Copilot, Anthropic, and oMLX live evidence over that exact registry
 * generation. No credential or endpoint secret enters the snapshot or hash.
 */

import { createHash } from "node:crypto";

import {
  getCandidates,
  type Candidate,
  type RegistryModel,
} from "./candidates.ts";
import {
  resolveAnthropicFilter,
  type AnthropicAuthContext,
  type FetchLike as AnthropicFetchLike,
} from "./anthropic-discovery.ts";
import {
  resolveCopilotFilter,
  type CopilotAuthContext,
  type FetchLike,
} from "./copilot-discovery.ts";
import {
  resolveOmlxFilter,
  type OmlxFilterContext,
} from "./omlx-discovery.ts";

export type AvailabilityEvidenceState = "not-applicable" | "verified" | "inconclusive";

export interface ProviderAvailabilityEvidence {
  readonly state: AvailabilityEvidenceState;
  /** Bare provider model ids; present only for verified discovery. */
  readonly ids?: readonly string[];
}

export interface AvailabilitySnapshot {
  readonly v: 1;
  /** Monotonic process-local generation; changes only after an explicit clear. */
  readonly generation: number;
  readonly createdAt: string;
  /** Hash of canonical registry + filter + live-candidate evidence (not time/generation). */
  readonly hash: string;
  /** Credentialed static registry candidates before live provider filtering. */
  readonly registryCandidates: readonly Candidate[];
  /** Candidates after all three provider live filters compose. */
  readonly candidates: readonly Candidate[];
  readonly filters: {
    readonly copilot: ProviderAvailabilityEvidence;
    readonly anthropic: ProviderAvailabilityEvidence;
    readonly omlx: ProviderAvailabilityEvidence;
  };
}

interface SnapshotRegistryModel extends RegistryModel {
  readonly baseUrl?: string | undefined;
}

export interface AvailabilitySnapshotContext {
  readonly modelRegistry: {
    getAvailable():
      | Promise<readonly SnapshotRegistryModel[]>
      | readonly SnapshotRegistryModel[];
    find(provider: string, id: string): unknown;
    getApiKeyAndHeaders(model: unknown):
      | Promise<{
          readonly ok: boolean;
          readonly apiKey?: string | undefined;
          readonly headers?: Record<string, string> | undefined;
        }>
      | {
          readonly ok: boolean;
          readonly apiKey?: string | undefined;
          readonly headers?: Record<string, string> | undefined;
        };
  };
}

export interface AvailabilitySnapshotDeps {
  readonly fetchFn?: FetchLike;
  readonly signal?: AbortSignal | undefined;
  readonly now?: () => number;
  /** Pure-builder override; the shared cache assigns this in production. */
  readonly generation?: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function candidateKey(candidate: Candidate): string {
  return `${candidate.provider}/${candidate.id}`;
}

function canonicalCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates]
    .sort((a, b) => compareText(candidateKey(a), candidateKey(b)))
    .map((candidate) =>
      Object.freeze({
        provider: candidate.provider,
        id: candidate.id,
        contextWindow: candidate.contextWindow,
        cost: Object.freeze({ ...candidate.cost }),
      }),
    );
}

function evidence(
  provider: string,
  registryCandidates: readonly Candidate[],
  ids: ReadonlySet<string> | null,
  emptyIsAuthoritative = false,
): ProviderAvailabilityEvidence {
  if (!registryCandidates.some((candidate) => candidate.provider === provider)) {
    return Object.freeze({ state: "not-applicable" });
  }
  if (ids === null || (ids.size === 0 && !emptyIsAuthoritative)) {
    return Object.freeze({ state: "inconclusive" });
  }
  return Object.freeze({ state: "verified", ids: Object.freeze([...ids].sort(compareText)) });
}

export function availabilityEvidenceSet(value: ProviderAvailabilityEvidence): ReadonlySet<string> | null {
  return value.state === "verified" ? new Set(value.ids ?? []) : null;
}

function canonicalHashInput(
  registryCandidates: readonly Candidate[],
  candidates: readonly Candidate[],
  filters: AvailabilitySnapshot["filters"],
): string {
  return JSON.stringify({
    v: 1,
    registryCandidates,
    candidates,
    filters,
  });
}

/** Build one immutable snapshot from one registry observation. */
export async function buildAvailabilitySnapshot(
  ctx: AvailabilitySnapshotContext,
  deps: AvailabilitySnapshotDeps = {},
): Promise<AvailabilitySnapshot> {
  const available = await ctx.modelRegistry.getAvailable();
  const fixedContext = {
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
      getApiKeyAndHeaders: (model: unknown) => ctx.modelRegistry.getApiKeyAndHeaders(model),
    },
  };
  const registryCandidates = canonicalCandidates(
    await getCandidates({ modelRegistry: { getAvailable: () => available } }),
  );
  const discoveryDeps = {
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const [copilotIds, anthropicIds, omlxIds] = await Promise.all([
    resolveCopilotFilter(fixedContext as CopilotAuthContext, discoveryDeps).catch(() => null),
    resolveAnthropicFilter(
      fixedContext as AnthropicAuthContext,
      discoveryDeps as { fetchFn?: AnthropicFetchLike; signal?: AbortSignal; now?: () => number },
    ).catch(() => null),
    resolveOmlxFilter(fixedContext as OmlxFilterContext, discoveryDeps).catch(() => null),
  ]);
  const filters = Object.freeze({
    copilot: evidence("github-copilot", registryCandidates, copilotIds),
    anthropic: evidence("anthropic", registryCandidates, anthropicIds),
    omlx: evidence("omlx", registryCandidates, omlxIds, true),
  });
  const candidates = canonicalCandidates(
    await getCandidates(
      { modelRegistry: { getAvailable: () => available } },
      {
        copilotFilter: availabilityEvidenceSet(filters.copilot),
        anthropicFilter: availabilityEvidenceSet(filters.anthropic),
        omlxFilter: availabilityEvidenceSet(filters.omlx),
      },
    ),
  );
  const hash = `sha256:${createHash("sha256")
    .update(canonicalHashInput(registryCandidates, candidates, filters))
    .digest("hex")}`;
  const now = deps.now ?? Date.now;
  return Object.freeze({
    v: 1,
    generation: deps.generation ?? 1,
    createdAt: new Date(now()).toISOString(),
    hash,
    registryCandidates: Object.freeze(registryCandidates),
    candidates: Object.freeze(candidates),
    filters,
  });
}

let generation = 0;
let cachedSnapshot: Promise<AvailabilitySnapshot> | undefined;
let cachedSnapshotToken: object | undefined;
let cachedSnapshotAbort: AbortController | undefined;

/** Return the session-frozen snapshot, building it once on first use. */
export function getAvailabilitySnapshot(
  ctx: AvailabilitySnapshotContext,
  deps: AvailabilitySnapshotDeps = {},
): Promise<AvailabilitySnapshot> {
  if (cachedSnapshot) return cachedSnapshot;
  generation += 1;
  const token = {};
  const abort = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, abort.signal]) : abort.signal;
  const current = buildAvailabilitySnapshot(ctx, { ...deps, signal, generation });
  const guarded = current.catch((error: unknown) => {
    // A cleared older generation may reject after a replacement build starts.
    // Never let that stale rejection evict the newer in-flight/cache promise.
    if (cachedSnapshotToken === token) {
      cachedSnapshot = undefined;
      cachedSnapshotToken = undefined;
      cachedSnapshotAbort = undefined;
    }
    throw error;
  });
  cachedSnapshot = guarded;
  cachedSnapshotToken = token;
  cachedSnapshotAbort = abort;
  return guarded;
}

/** Return the current frozen/in-flight generation without starting discovery. */
export function peekAvailabilitySnapshot(): Promise<AvailabilitySnapshot> | null {
  return cachedSnapshot ?? null;
}

/** Clear only the frozen generation; provider discovery caches are caller-owned. */
export function clearAvailabilitySnapshot(): void {
  cachedSnapshotAbort?.abort(new Error("availability snapshot generation cleared"));
  cachedSnapshot = undefined;
  cachedSnapshotToken = undefined;
  cachedSnapshotAbort = undefined;
}
