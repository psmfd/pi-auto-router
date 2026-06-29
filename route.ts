/**
 * auto-router/route.ts — the dispatch logic, structurally typed so it can be
 * unit-tested with mocks (the live integration is exercised by the probe in
 * the PR). Returns a discriminated `RouteOutcome` rather than throwing, so the
 * caller (before_agent_start) can stay a thin never-throws wrapper.
 *
 * Fallback discipline: every failure path keeps the current model. The router
 * only ever *narrows* to a credentialed candidate the classifier picked.
 */

import type { NotifyContext } from "./shared/notify.ts";
import { classify, type ClassifierChoice, type CompleteFn } from "./classifier.ts";
import { resolveCopilotFilter, type FetchLike } from "./copilot-discovery.ts";
import { buildRoutingPrompt, orderClassifierModels, resolveChoice, type PolicyContext } from "./policy.ts";
import { hashPrompt, type DecisionCache, type RouterState } from "./state.ts";
import type { Auth, RouterModel } from "./types.ts";

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
  | { readonly kind: "routed"; readonly target: string; readonly cached: boolean; readonly reason?: string };

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
  cache: DecisionCache,
  unavailable: Set<string>,
  deps: RouteDeps = {},
): Promise<RouteOutcome> {
  const key = hashPrompt(prompt);
  let target = cache.get(key);
  // A cached target that went unavailable earlier this session (e.g. 429'd) must
  // NOT be reused — drop it and re-classify. The in-loop guard below only
  // protects the fresh-classification path; without this a cache hit would route
  // the real turn straight to a quota-dead model. The re-classification's
  // buildRoutingPrompt excludes `unavailable`, and cache.set() overwrites the
  // stale entry with the fresh choice.
  if (target !== undefined && unavailable.has(target)) {
    target = undefined;
  }
  let cached = target !== undefined;
  let reason: string | undefined;

  if (target === undefined) {
    // Live Copilot availability: drop tier-gated/picker-disabled github-copilot
    // models the static catalog over-reports. Fails open to null (static menu).
    const copilotFilter = await resolveCopilotFilter(ctx, {
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }).catch(() => null);

    // The menu excludes models already known to be unavailable this session.
    const built = await buildRoutingPrompt(
      ctx,
      prompt,
      { allowlist: cfg.allowlist, copilotFilter },
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

    target = `${cand.provider}/${cand.id}`;
    reason = choice.reason;
    cache.set(key, target);
    cached = false;
  }

  const { provider, id } = splitTarget(target);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) return { kind: "no-registry-model", target };

  const ok = await pi.setModel(model);
  if (!ok) return { kind: "no-credential", target };
  return reason === undefined
    ? { kind: "routed", target, cached }
    : { kind: "routed", target, cached, reason };
}
