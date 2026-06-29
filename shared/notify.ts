/**
 * shared/notify.ts — consistent notification formatting across the suite.
 *
 * Thin wrapper over `ctx.ui.notify` (pi v0.79.0). Guards `ctx.hasUI` so
 * headless/RPC sessions never throw, and tags every message with a
 * `[pi-suite:<scope>]` prefix so suite output is greppable and attributable.
 */

// Matches pi v0.79.0 `ctx.ui.notify(message, type?)` levels exactly (#330 found
// the original "warn"/"success" guesses did not match the real API).
export type NotifyLevel = "info" | "error" | "warning";

/** The slice of `ExtensionContext` that `notify` reads. */
export interface NotifyContext {
  readonly hasUI?: boolean | undefined;
  readonly ui?: { notify(message: string, level?: NotifyLevel): void } | undefined;
}

const PREFIX = "pi-suite";

/** Format a scoped suite message: `[pi-suite:<scope>] <message>`. */
export function formatMessage(scope: string, message: string): string {
  return `[${PREFIX}:${scope}] ${message}`;
}

/**
 * Emit a scoped notification when a UI is present; no-op otherwise.
 * Returns whether the notification was delivered (useful for tests/telemetry).
 */
export function notify(
  ctx: NotifyContext,
  scope: string,
  message: string,
  level: NotifyLevel = "info",
): boolean {
  if (!ctx.hasUI || !ctx.ui) return false;
  ctx.ui.notify(formatMessage(scope, message), level);
  return true;
}
