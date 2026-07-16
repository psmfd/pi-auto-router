/**
 * Closed task taxonomy shared by auto-router classification and the routing
 * capability matrix. Keeping one immutable list prevents loader validation,
 * classifier parsing, telemetry, and matrix policy from drifting.
 */
export const MATRIX_TASK_TYPES = [
  "simple-qa",
  "code-edit",
  "code-review",
  "long-context",
  "agentic-loop",
  "creative",
] as const;

export type MatrixTaskType = (typeof MATRIX_TASK_TYPES)[number];
