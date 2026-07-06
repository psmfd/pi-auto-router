import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAnthropicHeaders,
  clearAnthropicCache,
  fetchAnthropicModels,
  getServedAnthropicModels,
  parseModelsPage,
  resolveAnthropicFilter,
  type FetchLike,
} from "../anthropic-discovery.ts";

const API_KEY_AUTH = { ok: true, apiKey: "sk-ant-api03-test" };
const OAUTH_AUTH = { ok: true, apiKey: "sk-ant-oat01-test" };

function pageBody(ids: string[], hasMore = false, lastId: string | null = null): string {
  return JSON.stringify({
    data: ids.map((id) => ({ type: "model", id })),
    has_more: hasMore,
    last_id: lastId,
  });
}

function fetchReturning(status: number, body: string): FetchLike {
  return () => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
}

test("buildAnthropicHeaders: API key uses x-api-key; OAuth uses Bearer + beta", () => {
  const key = buildAnthropicHeaders(API_KEY_AUTH);
  assert.equal(key?.["x-api-key"], "sk-ant-api03-test");
  assert.equal(key?.["anthropic-version"], "2023-06-01");
  assert.equal(key?.authorization, undefined);

  const oauth = buildAnthropicHeaders(OAUTH_AUTH);
  assert.equal(oauth?.authorization, "Bearer sk-ant-oat01-test");
  assert.equal(oauth?.["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(oauth?.["x-api-key"], undefined);

  assert.equal(buildAnthropicHeaders({ ok: false }), null);
  assert.equal(buildAnthropicHeaders({ ok: true }), null);
});

test("parseModelsPage: extracts valid ids, pagination fields, rejects junk", () => {
  const page = parseModelsPage(pageBody(["claude-sonnet-4-5", "claude-haiku-4-5"], true, "claude-haiku-4-5"));
  assert.deepEqual(page?.ids, ["claude-sonnet-4-5", "claude-haiku-4-5"]);
  assert.equal(page?.hasMore, true);
  assert.equal(page?.lastId, "claude-haiku-4-5");

  assert.equal(parseModelsPage("not json"), null);
  assert.equal(parseModelsPage(JSON.stringify({ data: "nope" })), null);
  const weird = parseModelsPage(JSON.stringify({ data: [{ id: 42 }, { id: "ok-model" }, null] }));
  assert.deepEqual(weird?.ids, ["ok-model"]);
});

test("fetchAnthropicModels: single page yields the id set", async () => {
  const models = await fetchAnthropicModels(API_KEY_AUTH, {
    fetchFn: fetchReturning(200, pageBody(["claude-sonnet-4-5"])),
  });
  assert.deepEqual(models, new Set(["claude-sonnet-4-5"]));
});

test("fetchAnthropicModels: follows pagination and aggregates", async () => {
  const calls: string[] = [];
  const fetchFn: FetchLike = (url) => {
    calls.push(url);
    const body = url.includes("after_id=a-1")
      ? pageBody(["b-2"], false, null)
      : pageBody(["a-1"], true, "a-1");
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
  };
  const models = await fetchAnthropicModels(API_KEY_AUTH, { fetchFn });
  assert.deepEqual(models, new Set(["a-1", "b-2"]));
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /after_id=a-1/);
});

test("fetchAnthropicModels fails open: non-2xx, malformed, empty, network error", async () => {
  assert.equal(await fetchAnthropicModels(API_KEY_AUTH, { fetchFn: fetchReturning(401, "{}") }), null);
  assert.equal(await fetchAnthropicModels(API_KEY_AUTH, { fetchFn: fetchReturning(200, "garbage") }), null);
  assert.equal(await fetchAnthropicModels(API_KEY_AUTH, { fetchFn: fetchReturning(200, pageBody([])) }), null);
  const throwing: FetchLike = () => Promise.reject(new Error("network down"));
  assert.equal(await fetchAnthropicModels(API_KEY_AUTH, { fetchFn: throwing }), null);
  assert.equal(await fetchAnthropicModels({ ok: false }, { fetchFn: fetchReturning(200, pageBody(["x"])) }), null);
});

test("getServedAnthropicModels: caches non-null within TTL; null is not cached", async () => {
  clearAnthropicCache();
  let okCalls = 0;
  const okFetch: FetchLike = () => {
    okCalls++;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(pageBody(["m-1"])) });
  };
  let t = 1_000;
  const now = () => t;
  assert.deepEqual(await getServedAnthropicModels(API_KEY_AUTH, { fetchFn: okFetch, now }), new Set(["m-1"]));
  t += 60_000; // inside TTL
  assert.deepEqual(await getServedAnthropicModels(API_KEY_AUTH, { fetchFn: okFetch, now }), new Set(["m-1"]));
  assert.equal(okCalls, 1);
  t += 21 * 60_000; // past TTL
  await getServedAnthropicModels(API_KEY_AUTH, { fetchFn: okFetch, now });
  assert.equal(okCalls, 2);

  clearAnthropicCache();
  let failCalls = 0;
  const failFetch: FetchLike = () => {
    failCalls++;
    return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("") });
  };
  assert.equal(await getServedAnthropicModels(API_KEY_AUTH, { fetchFn: failFetch, now }), null);
  assert.equal(await getServedAnthropicModels(API_KEY_AUTH, { fetchFn: failFetch, now }), null);
  assert.equal(failCalls, 2); // null result is never cached
  clearAnthropicCache();
});

test("resolveAnthropicFilter: null with no anthropic models; resolves via registry auth", async () => {
  clearAnthropicCache();
  const noAnthropic = {
    modelRegistry: {
      getAvailable: () => [{ provider: "omlx", id: "coding-workhorse" }],
      find: () => ({}),
      getApiKeyAndHeaders: () => API_KEY_AUTH,
    },
  };
  assert.equal(await resolveAnthropicFilter(noAnthropic), null);

  const withAnthropic = {
    modelRegistry: {
      getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
      find: () => ({}),
      getApiKeyAndHeaders: () => API_KEY_AUTH,
    },
  };
  const filter = await resolveAnthropicFilter(withAnthropic, {
    fetchFn: fetchReturning(200, pageBody(["claude-sonnet-4-5", "claude-haiku-4-5"])),
  });
  assert.deepEqual(filter, new Set(["claude-sonnet-4-5", "claude-haiku-4-5"]));
  clearAnthropicCache();
});

test("resolveAnthropicFilter: registry errors fail open to null", async () => {
  clearAnthropicCache();
  const broken = {
    modelRegistry: {
      getAvailable: () => {
        throw new Error("registry down");
      },
      find: () => ({}),
      getApiKeyAndHeaders: () => API_KEY_AUTH,
    },
  };
  assert.equal(await resolveAnthropicFilter(broken), null);
});
