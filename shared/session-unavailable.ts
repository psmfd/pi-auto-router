/**
 * Process-local provider deny state shared by auto-router and subagent runtime
 * failover. This state is dynamic session evidence, never reviewed capability
 * policy and never part of the immutable availability snapshot.
 */

// Provider is the first path segment; model ids may themselves contain `/`
// (for example openrouter/anthropic/claude).
const QUALIFIED_MODEL_ID = /^[^/\s]+\/\S+$/u;
const RATE_LIMIT_PATTERN = /\b429\b|quota|rate[\s-]?limit|too many requests/i;

/** Canonical process-local deny set. Callers must use qualified provider/id keys. */
export const sessionUnavailableModels = new Set<string>();

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

/** Mark one qualified provider/id unavailable. Invalid or bare ids are refused. */
export function markSessionUnavailable(modelId: string): boolean {
  if (!QUALIFIED_MODEL_ID.test(modelId)) return false;
  sessionUnavailableModels.add(modelId);
  return true;
}

/** Clear dynamic deny evidence, normally at session start or explicit retry. */
export function clearSessionUnavailable(): void {
  sessionUnavailableModels.clear();
}
