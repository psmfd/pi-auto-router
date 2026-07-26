/**
 * Process-local provider deny state shared by auto-router and subagent runtime
 * failover. This state is dynamic session evidence, never reviewed capability
 * policy and never part of the immutable availability snapshot.
 *
 * ADR-0126 (#902) widened it from a flat model set to two scopes:
 *
 *   - `model`    — one exact `provider/id` is unusable (a single row 429'd).
 *   - `provider` — every model from a provider is unusable this session (the
 *                  circuit breaker): an operator disable, or auto-escalation
 *                  once enough distinct models of one provider have produced
 *                  rate-limit evidence.
 *
 * Both scopes answer one question for the ranking layer — `has(provider/id)` —
 * so `resolveCapabilityPick`, `resolveTierPick`, and `buildRoutingPrompt`
 * consume the same view regardless of why a candidate is excluded.
 *
 * The state is instantiable ({@link createSessionDeny}) so tests inject an
 * isolated instance; {@link sessionDeny} is the canonical process-local one
 * that auto-router and subagent share. Nothing is persisted — `session_start`
 * clears every scope including operator disables (#904 tracks an opt-in
 * persistence path).
 */

// Provider is the first path segment; model ids may themselves contain `/`
// (for example openrouter/anthropic/claude).
const QUALIFIED_MODEL_ID = /^[^/\s]+\/\S+$/u;
/** A bare provider id: no slash, no whitespace (matches auto-router's parser). */
const PROVIDER_ID = /^[^/\s]+$/u;
const RATE_LIMIT_PATTERN = /\b429\b|quota|rate[\s-]?limit|too many requests/i;

/** Scope of a deny record: one exact model, or a whole provider. */
export type DenyScope = "model" | "provider";

/**
 * Why the entry exists. `operator` is an explicit `/auto providers disable`;
 * the rest are runtime evidence and are cleared by `--retry-unavailable`.
 */
export type DenySource = "operator" | "runtime-failover" | "classifier-probe" | "auto-escalation";

/** One deny entry, with the provenance status/telemetry surfaces render. */
export interface DenyRecord {
  /** `provider` for a provider-scope record, `provider/id` for a model-scope one. */
  readonly key: string;
  readonly scope: DenyScope;
  readonly source: DenySource;
  /**
   * Bounded reason text. NEVER raw provider error bodies — ADR-0122 keeps
   * arbitrary provider text out of failover telemetry and that holds here.
   */
  readonly reason: string;
  /** ISO-8601 instant the record was first written. */
  readonly at: string;
}

/**
 * The read side consumed by ranking and prompt building. A plain
 * `ReadonlySet<string>` satisfies this shape, so callers and tests that pass a
 * bare set of model keys keep working unchanged.
 */
export interface ModelDenyView {
  /** True when this exact model is denied OR its provider's breaker is tripped. */
  has(qualifiedId: string): boolean;
  /** Number of explicit records across both scopes (NOT the models implied). */
  readonly size: number;
}

/** Options for {@link SessionDeny.mark}. */
export interface MarkModelOptions {
  readonly source?: DenySource;
  readonly reason?: string;
  /**
   * Whether the failure carried conclusive rate-limit evidence. Only
   * rate-limited denies count toward provider auto-escalation — a generic
   * classifier error says nothing about the account's quota. Defaults to true,
   * preserving the ADR-0122 call sites that only ever marked 429s.
   */
  readonly rateLimited?: boolean;
}

/** Options for {@link SessionDeny.markProvider}. */
export interface MarkProviderOptions {
  readonly source?: DenySource;
  readonly reason?: string;
}

/** Options for {@link SessionDeny.clear}. */
export interface ClearOptions {
  /**
   * Keep explicit operator disables. `/auto matrix refresh --retry-unavailable`
   * clears transient runtime evidence but must not silently undo a deliberate
   * operator directive; `session_start` and `/auto providers enable` clear
   * everything.
   */
  readonly keepOperator?: boolean;
}

/** Mutable two-scope deny state. */
export interface SessionDeny extends ModelDenyView {
  /**
   * Mark one qualified `provider/id` unavailable. Invalid or bare ids are
   * refused (returns false). First-writer-wins: re-marking preserves the
   * original source and timestamp, so concurrent children observing the same
   * failure cannot rewrite provenance. Accumulated rate-limit evidence trips
   * the provider breaker at {@link SessionDeny.threshold}.
   */
  mark(modelId: string, options?: MarkModelOptions): boolean;
  /**
   * Trip the breaker for a whole provider. Bare provider ids only — a
   * `provider/id` argument is refused so a model key can never be mistaken for
   * a provider-wide directive. First-writer-wins, like {@link SessionDeny.mark}.
   */
  markProvider(provider: string, options?: MarkProviderOptions): boolean;
  /**
   * Re-enable a provider: drops its breaker record, its model-scope records,
   * and its accumulated escalation evidence, so a recovered provider starts
   * clean rather than re-tripping on one further failure. True when anything
   * was actually cleared.
   */
  clearProvider(provider: string): boolean;
  /** Clear deny evidence; see {@link ClearOptions} for the operator carve-out. */
  clear(options?: ClearOptions): void;
  /** Model-scope records, key-sorted for deterministic rendering. */
  models(): readonly DenyRecord[];
  /** Provider-scope records, key-sorted for deterministic rendering. */
  providers(): readonly DenyRecord[];
  /** True when this provider's breaker is tripped. */
  isProviderDenied(provider: string): boolean;
  /** This provider's breaker record, or null when it is selectable. */
  providerRecord(provider: string): DenyRecord | null;
  /**
   * Override the auto-escalation threshold. Values below the two-model minimum
   * are refused (returns false): a threshold of 1 would make every model-scope
   * 429 provider-wide, erasing the model/provider distinction entirely.
   */
  setThreshold(value: unknown): boolean;
  /** The escalation threshold currently in effect. */
  readonly threshold: number;
}

/**
 * Distinct rate-limited models of one provider required before the breaker
 * trips. Two is the minimum that constitutes a pattern: one model 429ing is
 * routine, a second means the quota — not the row — is exhausted.
 */
export const DEFAULT_BREAKER_THRESHOLD = 2;
const MIN_BREAKER_THRESHOLD = 2;

/** Provider segment of a qualified model key (everything before the first `/`). */
export function providerOf(qualifiedId: string): string {
  const slash = qualifiedId.indexOf("/");
  return slash <= 0 ? "" : qualifiedId.slice(0, slash);
}

function byKey(a: DenyRecord, b: DenyRecord): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Build an isolated two-scope deny state. */
export function createSessionDeny(threshold: number = DEFAULT_BREAKER_THRESHOLD): SessionDeny {
  const modelDenies = new Map<string, DenyRecord>();
  const providerDenies = new Map<string, DenyRecord>();
  /** Distinct rate-limited model keys seen per provider, for auto-escalation. */
  const rateLimitedByProvider = new Map<string, Set<string>>();
  let breakerThreshold = Math.max(MIN_BREAKER_THRESHOLD, threshold);

  const state: SessionDeny = {
    has(qualifiedId: string): boolean {
      if (modelDenies.has(qualifiedId)) return true;
      const provider = providerOf(qualifiedId);
      return provider !== "" && providerDenies.has(provider);
    },
    get size(): number {
      return modelDenies.size + providerDenies.size;
    },
    get threshold(): number {
      return breakerThreshold;
    },
    mark(modelId: string, options: MarkModelOptions = {}): boolean {
      if (!QUALIFIED_MODEL_ID.test(modelId)) return false;
      if (!modelDenies.has(modelId)) {
        modelDenies.set(modelId, {
          key: modelId,
          scope: "model",
          source: options.source ?? "runtime-failover",
          reason: options.reason ?? "rate-limited",
          at: new Date().toISOString(),
        });
      }
      if (options.rateLimited ?? true) {
        const provider = providerOf(modelId);
        if (provider !== "") {
          const seen = rateLimitedByProvider.get(provider) ?? new Set<string>();
          seen.add(modelId);
          rateLimitedByProvider.set(provider, seen);
          if (seen.size >= breakerThreshold && !providerDenies.has(provider)) {
            state.markProvider(provider, {
              source: "auto-escalation",
              reason: `${seen.size} distinct models rate-limited this session`,
            });
          }
        }
      }
      return true;
    },
    markProvider(provider: string, options: MarkProviderOptions = {}): boolean {
      if (!PROVIDER_ID.test(provider)) return false;
      if (providerDenies.has(provider)) return true; // first-writer-wins
      providerDenies.set(provider, {
        key: provider,
        scope: "provider",
        source: options.source ?? "operator",
        reason: options.reason ?? "operator disable",
        at: new Date().toISOString(),
      });
      return true;
    },
    clearProvider(provider: string): boolean {
      let changed = providerDenies.delete(provider);
      for (const key of [...modelDenies.keys()]) {
        if (providerOf(key) === provider) {
          modelDenies.delete(key);
          changed = true;
        }
      }
      if (rateLimitedByProvider.delete(provider)) changed = true;
      return changed;
    },
    clear(options: ClearOptions = {}): void {
      if (!options.keepOperator) {
        modelDenies.clear();
        providerDenies.clear();
        rateLimitedByProvider.clear();
        return;
      }
      for (const [key, record] of [...modelDenies]) {
        if (record.source !== "operator") modelDenies.delete(key);
      }
      for (const [key, record] of [...providerDenies]) {
        if (record.source !== "operator") providerDenies.delete(key);
      }
      // Escalation evidence is runtime evidence: it survives only for a
      // provider whose operator disable survived, so a re-enabled provider
      // cannot re-trip instantly on stale counts.
      for (const provider of [...rateLimitedByProvider.keys()]) {
        if (!providerDenies.has(provider)) rateLimitedByProvider.delete(provider);
      }
    },
    models(): readonly DenyRecord[] {
      return [...modelDenies.values()].sort(byKey);
    },
    providers(): readonly DenyRecord[] {
      return [...providerDenies.values()].sort(byKey);
    },
    isProviderDenied(provider: string): boolean {
      return providerDenies.has(provider);
    },
    providerRecord(provider: string): DenyRecord | null {
      return providerDenies.get(provider) ?? null;
    },
    setThreshold(value: unknown): boolean {
      if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_BREAKER_THRESHOLD) {
        return false;
      }
      breakerThreshold = value;
      return true;
    },
  };
  return state;
}

/** Canonical process-local deny state shared by auto-router and subagent. */
export const sessionDeny: SessionDeny = createSessionDeny();

/** Return whether a provider failure is conclusively quota/rate-limit shaped. */
export function isProviderRateLimited(value: unknown): boolean {
  let message = "";
  if (value instanceof Error) message = value.message;
  else if (typeof value === "string") message = value;
  else if (typeof value === "number") message = String(value);
  else if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    message = value.message;
  }
  return RATE_LIMIT_PATTERN.test(message);
}

/** Mark one qualified provider/id unavailable on the canonical state. */
export function markSessionUnavailable(
  modelId: string,
  options: MarkModelOptions = {},
): boolean {
  return sessionDeny.mark(modelId, options);
}

/** Clear the canonical state; see {@link ClearOptions}. */
export function clearSessionUnavailable(options: ClearOptions = {}): void {
  sessionDeny.clear(options);
}
