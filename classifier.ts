/**
 * auto-router/classifier.ts — the cheap-model side-call that picks a model.
 *
 * Uses pi-ai `complete()` (verified against pi v0.80.10-psmfd.1 examples
 * `examples/extensions/qna.ts`, `summarize.ts`, `handoff.ts`,
 * `custom-compaction.ts` — NOT `streamSimple`, which is a provider
 * implementation hook; see ADR-0031). Imported from
 * `@earendil-works/pi-ai/compat` because pi 0.80.x moved the request/response
 * API off the root entrypoint per the pi 0.80.2 CHANGELOG (#573; runtime
 * loader aliases root→compat as a strict superset, so the imports remain
 * runtime-safe). Credentials are passed explicitly (pi-ai requires
 * `options.apiKey`). `complete` is injected so the parse/fallback logic
 * unit-tests without a network call.
 *
 * Failure is never fatal: any error, missing credential, abort, or unparseable
 * reply returns `null`, and the caller keeps the current model. Routing must
 * never block a turn.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";

import { isProviderRateLimited } from "./shared/session-unavailable.ts";
import type { RoutingPrompt } from "./policy.ts";
import { toTaskType, type Auth, type RouterModel, type TaskType } from "./types.ts";

export interface ClassifierChoice {
  readonly model: string;
  readonly reason: string;
  /**
   * Measurement-only task-type label (#351): validated against the closed
   * taxonomy, degraded to "unknown" on anything absent/invented. Never affects
   * which model is routed to in this phase.
   */
  readonly taskType: TaskType;
}

/**
 * Outcome of one classifier call. `unavailable` means the provider call threw
 * (e.g. a 429 quota/rate error or a network failure) — the model should be
 * skipped and another tried. `bad-response` means the model replied but with no
 * usable choice (try another, but the model itself is fine).
 */
export type ClassifyResult =
  | { readonly status: "ok"; readonly choice: ClassifierChoice }
  | { readonly status: "no-credential" }
  | { readonly status: "unavailable"; readonly detail: "rate-limited" | "error" }
  | { readonly status: "bad-response" };

/** The subset of `complete`'s signature the classifier depends on (injectable for tests). */
export type CompleteFn = (
  model: RouterModel,
  context: { systemPrompt?: string; messages: UserMessage[] },
  options: { apiKey: string; headers?: Record<string, string> | undefined; signal?: AbortSignal | undefined },
) => Promise<{ stopReason?: string; content: ReadonlyArray<{ type: string; text?: string }> }>;

/** Extract `{taskType, model, reason}` from a model reply, tolerating surrounding prose/fences. */
export function parseChoice(text: string): ClassifierChoice | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.model !== "string" || rec.model.length === 0) return null;
  // Cap the model-supplied reason: it is shown verbatim in the UI toast, and a
  // prompt-injected classifier could otherwise emit an arbitrarily long string
  // (the "<=12 words" system instruction is advisory only).
  const reason = typeof rec.reason === "string" ? rec.reason.slice(0, 200) : "";
  // taskType is measurement-only: an invalid/missing label degrades to
  // "unknown" and NEVER fails the parse — routing must not depend on it.
  return { model: rec.model, reason, taskType: toTaskType(rec.taskType) };
}

export interface ClassifyDeps {
  readonly completeFn?: CompleteFn;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Run the classifier. Returns the chosen `{model, reason}` or `null` on any
 * failure (missing credential, network/parse error, abort) so the caller falls
 * back to the current model.
 */
export async function classify(
  model: RouterModel,
  auth: Auth,
  prompt: RoutingPrompt,
  deps: ClassifyDeps = {},
): Promise<ClassifyResult> {
  if (!auth.ok || !auth.apiKey) return { status: "no-credential" };
  const run = deps.completeFn ?? (complete as unknown as CompleteFn);

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: prompt.userText }],
    timestamp: Date.now(),
  };

  let response: Awaited<ReturnType<CompleteFn>>;
  try {
    response = await run(
      model,
      { systemPrompt: prompt.systemPrompt, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal: deps.signal },
    );
  } catch (err) {
    // Provider error — try a different model. Tag rate-limit/quota so the UI can
    // say "you're out of quota" rather than a generic failure.
    return { status: "unavailable", detail: isProviderRateLimited(err) ? "rate-limited" : "error" };
  }
  if (response.stopReason === "aborted") return { status: "bad-response" };

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  const choice = parseChoice(text);
  return choice ? { status: "ok", choice } : { status: "bad-response" };
}
