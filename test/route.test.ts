import assert from "node:assert/strict";
import { test } from "node:test";

import type { RegistryModel } from "../shared/candidates.ts";
import type { CompleteFn } from "../classifier.ts";
import { clearCopilotCache, type FetchLike } from "../copilot-discovery.ts";
import { route, type RouteContext, type RoutePi } from "../route.ts";
import { DecisionCache, type RouterState } from "../state.ts";
import type { Auth, RouterModel } from "../types.ts";

const CFG: RouterState = { enabled: true, classifierModel: null, allowlist: [] };

function mkModel(provider: string, id: string): RouterModel {
  return { provider, id } as unknown as RouterModel;
}

function modelId(model: RouterModel): string {
  return (model as unknown as { id: string }).id;
}

interface MockOpts {
  available?: RegistryModel[];
  auth?: Auth;
  findUndefinedFor?: string; // "provider/id" for which find() returns undefined
}

function makeCtx(opts: MockOpts = {}): RouteContext & { notes: string[] } {
  const available: RegistryModel[] =
    opts.available ?? [
      { provider: "anthropic", id: "haiku", contextWindow: 200_000, cost: { input: 0.8, output: 4, cacheRead: 0, cacheWrite: 0 } },
      { provider: "anthropic", id: "opus", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } },
    ];
  const notes: string[] = [];
  return {
    notes,
    hasUI: true,
    ui: { notify: (m: string) => void notes.push(m) },
    model: undefined,
    signal: undefined,
    getContextUsage: () => ({ tokens: 1000 }),
    modelRegistry: {
      getAvailable: () => available,
      getApiKeyAndHeaders: () => opts.auth ?? { ok: true, apiKey: "k" },
      find: (provider: string, id: string) =>
        `${provider}/${id}` === opts.findUndefinedFor ? undefined : mkModel(provider, id),
    },
  };
}

function makePi(setModelResult = true): RoutePi & { calls: RouterModel[] } {
  const calls: RouterModel[] = [];
  return {
    calls,
    setModel: async (m: RouterModel) => {
      calls.push(m);
      return setModelResult;
    },
  };
}

function completeReturning(text: string): CompleteFn {
  return async () => ({ content: [{ type: "text", text }] });
}

test("routes to the classifier's chosen credentialed model", async () => {
  const pi = makePi(true);
  const out = await route(pi, makeCtx(), "big refactor", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"anthropic/opus","reason":"x"}'),
  });
  assert.deepEqual(out, { kind: "routed", target: "anthropic/opus", cached: false, reason: "x" });
  assert.equal(pi.calls.length, 1);
});

test("serves identical prompts from the decision cache without re-classifying", async () => {
  const pi = makePi(true);
  const ctx = makeCtx();
  const cache = new DecisionCache();
  const unavailable = new Set<string>();
  let calls = 0;
  const cf: CompleteFn = async () => {
    calls += 1;
    return { content: [{ type: "text", text: '{"model":"anthropic/opus"}' }] };
  };
  await route(pi, ctx, "same prompt", CFG, cache, unavailable, { completeFn: cf });
  const out2 = await route(pi, ctx, "same prompt", CFG, cache, unavailable, { completeFn: cf });
  assert.equal(calls, 1);
  assert.deepEqual(out2, { kind: "routed", target: "anthropic/opus", cached: true });
});

test("a cached target that went unavailable is re-classified, not reused", async () => {
  const pi = makePi(true);
  const ctx = makeCtx();
  const cache = new DecisionCache();
  const unavailable = new Set<string>();
  // First turn caches anthropic/opus.
  await route(pi, ctx, "p", CFG, cache, unavailable, {
    completeFn: completeReturning('{"model":"anthropic/opus","reason":"a"}'),
  });
  // opus 429s out-of-band this session; the same prompt must NOT be served the
  // dead cached opus — it must re-classify (and the menu now excludes opus).
  unavailable.add("anthropic/opus");
  const out = await route(pi, ctx, "p", CFG, cache, unavailable, {
    completeFn: completeReturning('{"model":"anthropic/haiku","reason":"b"}'),
  });
  assert.deepEqual(out, { kind: "routed", target: "anthropic/haiku", cached: false, reason: "b" });
});

test("skips a classifier candidate absent from the registry and fails over", async () => {
  // haiku (cheapest) is not in the registry as a classifier model → "not-in-registry";
  // the loop fails over to opus, which answers.
  const out = await route(makePi(true), makeCtx({ findUndefinedFor: "anthropic/haiku" }), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"anthropic/opus","reason":"x"}'),
  });
  assert.deepEqual(out, { kind: "routed", target: "anthropic/opus", cached: false, reason: "x" });
});

test("returns no-registry-model when the resolved target is absent from the registry", async () => {
  // The haiku classifier picks opus, but opus is not findable as a routable model.
  const out = await route(makePi(), makeCtx({ findUndefinedFor: "anthropic/opus" }), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"anthropic/opus","reason":"x"}'),
  });
  assert.deepEqual(out, { kind: "no-registry-model", target: "anthropic/opus" });
});

test("returns no-candidates when nothing is credentialed", async () => {
  const out = await route(makePi(), makeCtx({ available: [] }), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning("{}"),
  });
  assert.deepEqual(out, { kind: "no-candidates", reason: "none-credentialed" });
});

test("falls back (no setModel) when every candidate returns no JSON", async () => {
  const pi = makePi();
  const out = await route(pi, makeCtx(), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning("I cannot decide"),
  });
  assert.equal(out.kind, "classify-failed");
  assert.equal(pi.calls.length, 0);
});

test("returns unresolved when the choice is not a credentialed candidate", async () => {
  const out = await route(makePi(), makeCtx(), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"ghost/model"}'),
  });
  assert.deepEqual(out, { kind: "unresolved", choice: "ghost/model" });
});

test("reports no-credential (no throw) when setModel returns false", async () => {
  const pi = makePi(false);
  const out = await route(pi, makeCtx(), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"anthropic/opus"}'),
  });
  assert.deepEqual(out, { kind: "no-credential", target: "anthropic/opus" });
});

test("falls back when the classifier model has no credential", async () => {
  const out = await route(makePi(), makeCtx({ auth: { ok: false } }), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"anthropic/opus"}'),
  });
  assert.equal(out.kind, "classify-failed");
});

test("fails over to the next classifier model on a provider error (e.g. 429)", async () => {
  const pi = makePi(true);
  const unavailable = new Set<string>();
  // cheapest-first classifier order is haiku, then opus. haiku 429s; opus answers.
  const cf: CompleteFn = async (model) => {
    if (modelId(model) === "haiku") throw new Error("OpenAI API error (429): quota exceeded");
    return { content: [{ type: "text", text: '{"model":"anthropic/opus","reason":"x"}' }] };
  };
  const out = await route(pi, makeCtx(), "hi", CFG, new DecisionCache(), unavailable, { completeFn: cf });
  assert.deepEqual(out, { kind: "routed", target: "anthropic/opus", cached: false, reason: "x" });
  assert.equal(unavailable.has("anthropic/haiku"), true);
  assert.equal(unavailable.has("anthropic/opus"), false);
});

test("exhausts the list and marks every unavailable model when all fail over", async () => {
  const unavailable = new Set<string>();
  const cf: CompleteFn = async () => {
    throw new Error("429 quota exceeded");
  };
  const out = await route(makePi(), makeCtx(), "hi", CFG, new DecisionCache(), unavailable, { completeFn: cf });
  assert.deepEqual(out, {
    kind: "classify-failed",
    attempts: [
      { model: "anthropic/haiku", status: "unavailable", detail: "rate-limited" },
      { model: "anthropic/opus", status: "unavailable", detail: "rate-limited" },
    ],
  });
  assert.equal(unavailable.has("anthropic/haiku"), true);
  assert.equal(unavailable.has("anthropic/opus"), true);
});

test("excludes already-unavailable models from the menu", async () => {
  const unavailable = new Set(["anthropic/haiku", "anthropic/opus"]);
  const out = await route(makePi(), makeCtx(), "hi", CFG, new DecisionCache(), unavailable, {
    completeFn: completeReturning('{"model":"anthropic/opus"}'),
  });
  assert.deepEqual(out, { kind: "no-candidates", reason: "all-unavailable" });
});

// --- #343: live Copilot availability filter --------------------------------
const COPILOT_CTX: MockOpts = {
  available: [
    { provider: "github-copilot", id: "gpt-5.5", contextWindow: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { provider: "github-copilot", id: "gpt-5.4-nano", contextWindow: 128_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ],
  auth: { ok: true, apiKey: "proxy-ep=proxy.individual.githubcopilot.com;x=1" },
};

// /models reports only gpt-5.5 as picker-enabled — gpt-5.4-nano is a phantom.
const onlyGpt55: FetchLike = async () =>
  ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "gpt-5.5", model_picker_enabled: true }] }) });

test("drops a Copilot model the live /models set excludes (the gpt-5.4-nano bug)", async () => {
  clearCopilotCache();
  // The classifier 'picks' the phantom; with the filter active it is not in the
  // menu, so resolveChoice fails rather than routing the real turn to a 400.
  const out = await route(makePi(), makeCtx(COPILOT_CTX), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"github-copilot/gpt-5.4-nano"}'),
    fetchFn: onlyGpt55,
  });
  assert.equal(out.kind, "unresolved");
  clearCopilotCache();
});

test("routes to a Copilot model that IS picker-enabled", async () => {
  clearCopilotCache();
  const out = await route(makePi(), makeCtx(COPILOT_CTX), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"github-copilot/gpt-5.5","reason":"ok"}'),
    fetchFn: onlyGpt55,
  });
  assert.deepEqual(out, { kind: "routed", target: "github-copilot/gpt-5.5", cached: false, reason: "ok" });
  clearCopilotCache();
});

test("fails open: a /models error leaves the static menu (nano stays routable)", async () => {
  clearCopilotCache();
  const throwing: FetchLike = async () => { throw new Error("network"); };
  const out = await route(makePi(), makeCtx(COPILOT_CTX), "hi", CFG, new DecisionCache(), new Set(), {
    completeFn: completeReturning('{"model":"github-copilot/gpt-5.4-nano","reason":"x"}'),
    fetchFn: throwing,
  });
  assert.deepEqual(out, { kind: "routed", target: "github-copilot/gpt-5.4-nano", cached: false, reason: "x" });
  clearCopilotCache();
});
