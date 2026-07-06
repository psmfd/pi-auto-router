/**
 * auto-router/route.ts — the dispatch logic, structurally typed so it can be
 * unit-tested with mocks (the live integration is exercised by the probe in
 * the PR). Returns a discriminated `RouteOutcome` rather than throwing, so the
 * caller (before_agent_start) can stay a thin never-throws wrapper.
 *
 * Fallback discipline: every failure path keeps the current model. The router
 * only ever *narrows* to a credentialed candidate from the live-filtered menu —
 * either the classifier's pick or (matrix routing enabled, #352) the
 * deterministic capability-matrix pick, both validated through the same gates.
 */

import type { NotifyContext } from "./shared/notify.ts";
import type { RoutingMatrix } from "./shared/routing-matrix.ts";
import { getUsage } from "./shared/signals.ts";
import { resolveAnthropicFilter } from "./anthropic-discovery.ts";
import { classify, type ClassifierChoice, type CompleteFn } from "./classifier.ts";
import { resolveCopilotFilter, type FetchLike } from "./shared/copilot-discovery.ts";
import { resolveOmlxFilter } from "./shared/omlx-discovery.ts";
import {
  buildRoutingPrompt,
  orderClassifierModels,
  resolveByTaskType,
  resolveChoice,
  type PolicyContext,
} from "./policy.ts";
import { hashPrompt, type CachedDecision, type DecisionCache, type RouterState } from "./state.ts";
import type { Auth, PickSource, RouterModel, TaskType } from "./types.ts";

export interface RouteContext extends PolicyContext, NotifyContext {
  readonly model?: RouterModel | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly modelRegistry: PolicyContext["modelRegistry"] & {
    getApiKeyAndHeaders(model: RouterModel): Promise<Auth> | Auth;
    find(provider: string, id: string): RouterModel | undefined;
  };
}

export interface RoutePi {
  setModel(model: RouterModel): Promise<boolean>;
}

/** One classifier attempt: the model tried, its status, and (if unavailable) why. */
export interface ClassifierAttempt {
  readonly model: string;
  readonly status: string;
  readonly detail?: string;
}

export type RouteOutcome =
  | { readonly kind: "no-candidates"; readonly reason: "none-credentialed" | "all-unavailable" | "copilot-filtered" }
  | { readonly kind: "classify-failed"; readonly attempts: readonly ClassifierAttempt[] }
  | { readonly kind: "unresolved"; readonly choice: string }
  | { readonly kind: "no-registry-model"; readonly target: string }
  | { readonly kind: "no-credential"; readonly target: string }
  | {
      readonly kind: "routed";
      readonly target: string;
      readonly cached: boolean;
      /** Measurement-only task-type label from the (possibly cached) classification (#351). */
      readonly taskType: TaskType;
      /** Whether the matrix or the classifier produced the target (#352). */
      readonly source: PickSource;
      readonly reason?: string;
    };

export interface RouteDeps {
  readonly completeFn?: CompleteFn;
  /** Injectable fetch for Copilot live-model discovery (real `fetch` in prod). */
  readonly fetchFn?: FetchLike;
}

function splitTarget(target: string): { provider: string; id: string } {
  const slash = target.indexOf("/");
  return { provider: target.slice(0, slash), id: target.slice(slash + 1) };
}

export async function route(
  pi: RoutePi,
  ctx: RouteContext,
  prompt: string,
  cfg: RouterState,
  matrix: RoutingMatrix | null,
  cache: DecisionCache,
  unavailable: Set<string>,
  deps: RouteDeps = {},
): Promise<RouteOutcome> {
  const key = hashPrompt(prompt);
  let decision: CachedDecision | undefined = cache.get(key);
  // A cached target that went unavailable earlier this session (e.g. 429'd) must
  // NOT be reused — drop it and re-classify. The in-loop guard below only
  // protects the fresh-classification path; without this a cache hit would route
  // the real turn straight to a quota-dead model. The re-classification's
  // buildRoutingPrompt excludes `unavailable`, and cache.set() overwrites the
  // stale entry with the fresh choice.
  if (decision !== undefined && unavailable.has(decision.target)) {
    decision = undefined;
  }
  let cached = decision !== undefined;
  let reason: string | undefined;

  if (decision === undefined) {
    // Live Copilot availability: drop tier-gated/picker-disabled github-copilot
    // models the static catalog over-reports. Fails open to null (static menu).
    const copilotFilter = await resolveCopilotFilter(ctx, {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }).catch(() => null);

    // Live Anthropic availability (#538): drop retired ids the static registry
    // still lists (they 404 when routed). Fails open to null.
    const anthropicFilter = await resolveAnthropicFilter(ctx, {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }).catch(() => null);

    // Live oMLX availability (#364): drop the local candidate when the server
    // is confirmed down or the model is not loaded. Fails open to null.
    const omlxFilter = await resolveOmlxFilter(ctx, {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }).catch(() => null);

    // The menu excludes models already known to be unavailable this session.
    const built = await buildRoutingPrompt(
      ctx,
      prompt,
      { allowlist: cfg.allowlist, copilotFilter, anthropicFilter, omlxFilter },
      unavailable,
    );
    if (!built.ok) return { kind: "no-candidates", reason: built.reason };

    // Try candidates cheapest-first as the classifier model; fail over on a
    // provider error (e.g. 429), recording the dead model so we skip it next time.
    let choice: ClassifierChoice | undefined;
    const attempts: ClassifierAttempt[] = [];
    for (const cand of orderClassifierModels(built.candidates, cfg.classifierModel)) {
      const id = `${cand.provider}/${cand.id}`;
      const classifierModel = ctx.modelRegistry.find(cand.provider, cand.id);
      if (!classifierModel) {
        attempts.push({ model: id, status: "not-in-registry" });
        continue;
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(classifierModel);
      const result = await classify(classifierModel, auth, built.prompt, {
        signal: ctx.signal,
        completeFn: deps.completeFn,
      });
      attempts.push(
        result.status === "unavailable"
          ? { model: id, status: "unavailable", detail: result.detail }
          : { model: id, status: result.status },
      );
      if (result.status === "ok") {
        choice = result.choice;
        break;
      }
      if (result.status === "unavailable") unavailable.add(id);
    }
    if (!choice) return { kind: "classify-failed", attempts };

    const cand = resolveChoice(built.candidates, choice.model);
    // Reject a choice that is unknown or went unavailable during the loop, so we
    // never route the real turn to a quota-dead model.
    if (!cand || unavailable.has(`${cand.provider}/${cand.id}`)) {
      return { kind: "unresolved", choice: choice.model };
    }

    let target = `${cand.provider}/${cand.id}`;
    let source: PickSource = "classifier";

    // #352 (ADR-0078): when enabled, the deterministic capability-matrix pick
    // overrides the classifier's model choice (its taskType label is kept).
    // The pick consumes the same live-filtered menu the classifier saw, and is
    // re-validated through the SAME gates as the classifier path — resolveChoice
    // plus a post-classify-loop `unavailable` check (the loop can 429 a model
    // AFTER built.candidates was computed). A null pick means "no capable,
    // available, window-adequate candidate": the classifier's target stands.
    if (cfg.matrixEnabled && matrix) {
      const pick = resolveByTaskType(
        built.candidates,
        choice.taskType,
        matrix,
        unavailable,
        getUsage(ctx),
      );
      if (pick) {
        const revalidated = resolveChoice(built.candidates, `${pick.provider}/${pick.id}`);
        if (revalidated && !unavailable.has(`${revalidated.provider}/${revalidated.id}`)) {
          target = `${revalidated.provider}/${revalidated.id}`;
          source = "matrix";
        }
      }
    }

    decision = { target, taskType: choice.taskType, source };
    reason = choice.reason;
    cache.set(key, decision);
    cached = false;
  }

  const { target, taskType, source } = decision;
  const { provider, id } = splitTarget(target);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) return { kind: "no-registry-model", target };

  const ok = await pi.setModel(model);
  if (!ok) return { kind: "no-credential", target };
  return reason === undefined
    ? { kind: "routed", target, cached, taskType, source }
    : { kind: "routed", target, cached, taskType, source, reason };
}
