/**
 * auto-router/types.ts — shared type aliases for the router.
 *
 * `RouterModel` is the exact pi-ai model object that `complete()` and
 * `pi.setModel()` accept (derived from the published signature, so it tracks
 * the SDK without hand-maintenance). Imported from `@earendil-works/pi-ai/compat`
 * because pi 0.80.x moved the request/response API off the root entrypoint
 * (#573; runtime loader aliases root→compat as a strict superset, so this is
 * a typecheck-only concern). `Auth` mirrors the shape returned by
 * `ctx.modelRegistry.getApiKeyAndHeaders()` (verified against pi v0.80.2
 * examples).
 */

import type { complete } from "@earendil-works/pi-ai/compat";

/** The pi-ai model object accepted by `complete()` and `pi.setModel()`. */
export type RouterModel = Parameters<typeof complete>[0];

/** Credentials + headers for a model, from `modelRegistry.getApiKeyAndHeaders()`. */
export interface Auth {
  readonly ok: boolean;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly error?: string | undefined;
}

/**
 * The closed task-type taxonomy the classifier labels each prompt with
 * (#350/#351 Phase 1). Measurement-only in this phase: the label is recorded
 * next to real token usage so the Phase 2 routing matrix is seeded from
 * observed per-task-type cost. It never influences the routing decision here.
 */
export const TASK_TYPES = [
  "simple-qa",
  "code-edit",
  "code-review",
  "long-context",
  "agentic-loop",
  "creative",
] as const;

/** A taxonomy label, or "unknown" when the classifier omitted/invented one. */
export type TaskType = (typeof TASK_TYPES)[number] | "unknown";

/**
 * Which mechanism produced a routing target (#352, ADR-0078): the
 * deterministic capability-matrix pick, or the classifier's own free choice.
 * Carried on RouteOutcome, CachedDecision, and every TaskTypeRecord so
 * matrix-influenced turns stay distinguishable in the measurement data the
 * matrix itself is evaluated against.
 */
export type PickSource = "matrix" | "classifier";

/** Validate a classifier-supplied task type against the closed taxonomy. */
export function toTaskType(value: unknown): TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value)
    ? (value as TaskType)
    : "unknown";
}
