import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearCopilotCache,
  copilotBaseUrl,
  fetchCopilotEnabledModels,
  getEnabledCopilotModels,
  parseEnabledModels,
  resolveCopilotFilter,
  type FetchLike,
  type FetchResponseLike,
} from "../copilot-discovery.ts";

const JWT = "tid=abc;exp=9999;proxy-ep=proxy.individual.githubcopilot.com;ol=1";
const AUTH = { ok: true, apiKey: JWT, headers: { "Copilot-Integration-Id": "vscode-chat" } };

function jsonResponse(body: unknown, ok = true, status = 200): FetchResponseLike {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function fetchReturning(body: unknown, ok = true): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    return jsonResponse(body, ok);
  };
  return { fn, calls };
}

const SAMPLE = {
  data: [
    { id: "gpt-5.5", model_picker_enabled: true, policy: { state: "enabled" } },
    { id: "gpt-5.4-nano", model_picker_enabled: false, policy: { state: "enabled" } }, // picker off
    { id: "claude-opus-4.8", model_picker_enabled: true, policy: { state: "disabled" } }, // tier-gated
    { id: "gpt-5-mini", model_picker_enabled: true }, // no policy → allowed
  ],
};

// --- copilotBaseUrl --------------------------------------------------------
test("copilotBaseUrl derives api host from the JWT proxy-ep field", () => {
  assert.equal(copilotBaseUrl(JWT), "https://api.individual.githubcopilot.com");
  assert.equal(
    copilotBaseUrl("proxy-ep=proxy.business.githubcopilot.com;x=1"),
    "https://api.business.githubcopilot.com",
  );
});

test("copilotBaseUrl returns null when no proxy-ep is present", () => {
  assert.equal(copilotBaseUrl("tid=abc;exp=9999"), null);
});

// --- parseEnabledModels ----------------------------------------------------
test("parseEnabledModels keeps only picker-enabled, non-disabled models", () => {
  const set = parseEnabledModels(JSON.stringify(SAMPLE));
  assert.deepEqual([...(set ?? [])].sort(), ["gpt-5-mini", "gpt-5.5"]);
  assert.ok(!set?.has("gpt-5.4-nano"), "picker-disabled dropped");
  assert.ok(!set?.has("claude-opus-4.8"), "policy.state=disabled dropped");
});

test("parseEnabledModels returns null for an empty or all-filtered set (not an empty Set)", () => {
  assert.equal(parseEnabledModels(JSON.stringify({ data: [] })), null);
  assert.equal(
    parseEnabledModels(JSON.stringify({ data: [{ id: "x", model_picker_enabled: false }] })),
    null,
  );
});

test("parseEnabledModels returns null on malformed / non-array bodies", () => {
  assert.equal(parseEnabledModels("not json"), null);
  assert.equal(parseEnabledModels(JSON.stringify({ data: "nope" })), null);
  assert.equal(parseEnabledModels(JSON.stringify({})), null);
});

test("parseEnabledModels rejects malformed ids", () => {
  const set = parseEnabledModels(
    JSON.stringify({ data: [{ id: "bad id with spaces", model_picker_enabled: true }, { id: "ok-1", model_picker_enabled: true }] }),
  );
  assert.deepEqual([...(set ?? [])], ["ok-1"]);
});

// --- fetchCopilotEnabledModels --------------------------------------------
test("fetchCopilotEnabledModels returns the enabled set on a good response", async () => {
  const { fn, calls } = fetchReturning(SAMPLE);
  const set = await fetchCopilotEnabledModels(AUTH, { fetchFn: fn });
  assert.deepEqual([...(set ?? [])].sort(), ["gpt-5-mini", "gpt-5.5"]);
  assert.equal(calls[0], "https://api.individual.githubcopilot.com/models");
});

test("fetchCopilotEnabledModels fails open (null) without a usable token", async () => {
  assert.equal(await fetchCopilotEnabledModels({ ok: false }, { fetchFn: fetchReturning(SAMPLE).fn }), null);
  assert.equal(await fetchCopilotEnabledModels({ ok: true }, { fetchFn: fetchReturning(SAMPLE).fn }), null);
});

test("fetchCopilotEnabledModels refuses a base host outside the Copilot allowlist", async () => {
  let called = false;
  const fn: FetchLike = async () => { called = true; return jsonResponse(SAMPLE); };
  const evil = { ok: true, apiKey: "proxy-ep=proxy.evil.com;x=1" };
  assert.equal(await fetchCopilotEnabledModels(evil, { fetchFn: fn }), null);
  assert.equal(called, false, "must not fetch an off-allowlist host");
});

test("fetchCopilotEnabledModels fails open on non-2xx", async () => {
  const fn: FetchLike = async () => jsonResponse(SAMPLE, false, 403);
  assert.equal(await fetchCopilotEnabledModels(AUTH, { fetchFn: fn }), null);
});

test("fetchCopilotEnabledModels fails open when the body exceeds the size cap", async () => {
  const big = "x".repeat(256 * 1024 + 1);
  const fn: FetchLike = async () => ({ ok: true, status: 200, text: async () => big });
  assert.equal(await fetchCopilotEnabledModels(AUTH, { fetchFn: fn }), null);
});

test("fetchCopilotEnabledModels fails open when fetch throws (network / redirect)", async () => {
  const fn: FetchLike = async () => { throw new Error("redirect not allowed"); };
  assert.equal(await fetchCopilotEnabledModels(AUTH, { fetchFn: fn }), null);
});

test("fetchCopilotEnabledModels sends the Bearer token in the Authorization header", async () => {
  let seen: Record<string, string> = {};
  const fn: FetchLike = async (_url, init) => { seen = init.headers; return jsonResponse(SAMPLE); };
  await fetchCopilotEnabledModels(AUTH, { fetchFn: fn });
  assert.equal(seen["Authorization"], `Bearer ${JWT}`);
  assert.equal(seen["Copilot-Integration-Id"], "vscode-chat");
});

// --- getEnabledCopilotModels (caching) ------------------------------------
test("getEnabledCopilotModels caches within the TTL and re-fetches after", async () => {
  clearCopilotCache();
  let fetches = 0;
  const fn: FetchLike = async () => { fetches += 1; return jsonResponse(SAMPLE); };
  let t = 1_000_000;
  const now = () => t;

  await getEnabledCopilotModels(AUTH, { fetchFn: fn, now });
  await getEnabledCopilotModels(AUTH, { fetchFn: fn, now }); // within TTL → cached
  assert.equal(fetches, 1);

  t += 20 * 60 * 1000 + 1; // past TTL
  await getEnabledCopilotModels(AUTH, { fetchFn: fn, now });
  assert.equal(fetches, 2);
  clearCopilotCache();
});

test("getEnabledCopilotModels does not cache a null (failure) result", async () => {
  clearCopilotCache();
  let fetches = 0;
  const fn: FetchLike = async () => { fetches += 1; return jsonResponse(SAMPLE, false, 500); };
  await getEnabledCopilotModels(AUTH, { fetchFn: fn });
  await getEnabledCopilotModels(AUTH, { fetchFn: fn });
  assert.equal(fetches, 2, "a failed discovery is retried, not cached");
  clearCopilotCache();
});

// --- resolveCopilotFilter --------------------------------------------------
function registry(
  available: { provider: string; id: string }[],
  auth: { ok: boolean; apiKey?: string; headers?: Record<string, string> } = AUTH,
) {
  return {
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => ({ provider, id }),
      getApiKeyAndHeaders: () => auth,
    },
  };
}

test("resolveCopilotFilter returns null (no fetch) when no copilot models exist", async () => {
  clearCopilotCache();
  let called = false;
  const fn: FetchLike = async () => { called = true; return jsonResponse(SAMPLE); };
  const out = await resolveCopilotFilter(registry([{ provider: "anthropic", id: "claude-x" }]), { fetchFn: fn });
  assert.equal(out, null);
  assert.equal(called, false);
});

test("resolveCopilotFilter discovers via any available copilot model", async () => {
  clearCopilotCache();
  const { fn } = fetchReturning(SAMPLE);
  const out = await resolveCopilotFilter(
    registry([{ provider: "github-copilot", id: "gpt-5.5" }]),
    { fetchFn: fn },
  );
  assert.deepEqual([...(out ?? [])].sort(), ["gpt-5-mini", "gpt-5.5"]);
  clearCopilotCache();
});

test("resolveCopilotFilter fails open when auth is unavailable", async () => {
  clearCopilotCache();
  const { fn } = fetchReturning(SAMPLE);
  const out = await resolveCopilotFilter(
    registry([{ provider: "github-copilot", id: "gpt-5.5" }], { ok: false }),
    { fetchFn: fn },
  );
  assert.equal(out, null);
  clearCopilotCache();
});
