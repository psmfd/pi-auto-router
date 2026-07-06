import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, parseChoice, type CompleteFn } from "../classifier.ts";
import type { Auth, RouterModel } from "../types.ts";

const MODEL = { provider: "anthropic", id: "haiku" } as unknown as RouterModel;
const OK_AUTH: Auth = { ok: true, apiKey: "k" };
const PROMPT = { systemPrompt: "sys", userText: "user" };

function completeReturning(text: string, stopReason?: string): CompleteFn {
  return async () => ({ stopReason, content: [{ type: "text", text }] });
}

test("parseChoice extracts JSON from a bare object", () => {
  assert.deepEqual(parseChoice('{"model":"anthropic/opus","reason":"complex"}'), {
    model: "anthropic/opus",
    reason: "complex",
    taskType: "unknown",
  });
});

test("parseChoice tolerates surrounding prose / code fences", () => {
  const wrapped = 'Sure!\n```json\n{"model":"anthropic/haiku","reason":"simple"}\n```';
  assert.equal(parseChoice(wrapped)?.model, "anthropic/haiku");
});

test("parseChoice defaults reason to empty string and rejects bad shapes", () => {
  assert.deepEqual(parseChoice('{"model":"x/y"}'), { model: "x/y", reason: "", taskType: "unknown" });
  assert.equal(parseChoice("no json here"), null);
  assert.equal(parseChoice("{ not json"), null);
  assert.equal(parseChoice('{"reason":"missing model"}'), null);
  assert.equal(parseChoice('{"model":""}'), null);
});

test("parseChoice validates taskType against the closed taxonomy (#351)", () => {
  assert.equal(parseChoice('{"taskType":"code-edit","model":"a/b"}')?.taskType, "code-edit");
  assert.equal(parseChoice('{"taskType":"simple-qa","model":"a/b"}')?.taskType, "simple-qa");
});

test("parseChoice degrades an invented/missing taskType to unknown, never a parse failure", () => {
  assert.equal(parseChoice('{"taskType":"world-domination","model":"a/b"}')?.taskType, "unknown");
  assert.equal(parseChoice('{"taskType":42,"model":"a/b"}')?.taskType, "unknown");
  assert.equal(parseChoice('{"model":"a/b"}')?.taskType, "unknown");
});

test("parseChoice caps the model-supplied reason (shown verbatim in the UI)", () => {
  const longReason = "z".repeat(5000);
  const choice = parseChoice(`{"model":"a/b","reason":"${longReason}"}`);
  assert.equal(choice?.model, "a/b");
  assert.equal(choice?.reason.length, 200);
});

test("classify reports no-credential without a usable credential", async () => {
  assert.deepEqual(await classify(MODEL, { ok: false }, PROMPT, { completeFn: completeReturning("{}") }), {
    status: "no-credential",
  });
  assert.deepEqual(await classify(MODEL, { ok: true }, PROMPT, { completeFn: completeReturning("{}") }), {
    status: "no-credential",
  });
});

test("classify reports ok with the parsed choice on success", async () => {
  const result = await classify(MODEL, OK_AUTH, PROMPT, {
    completeFn: completeReturning('{"model":"anthropic/opus","reason":"big task"}'),
  });
  assert.deepEqual(result, {
    status: "ok",
    choice: { model: "anthropic/opus", reason: "big task", taskType: "unknown" },
  });
});

test("classify reports bad-response on abort or unparseable reply", async () => {
  assert.deepEqual(
    await classify(MODEL, OK_AUTH, PROMPT, { completeFn: completeReturning('{"model":"x/y"}', "aborted") }),
    { status: "bad-response" },
  );
  assert.deepEqual(await classify(MODEL, OK_AUTH, PROMPT, { completeFn: completeReturning("no json here") }), {
    status: "bad-response",
  });
});

test("classify reports unavailable + rate-limited on a 429", async () => {
  const throwing: CompleteFn = async () => {
    throw new Error("OpenAI API error (429): quota exceeded");
  };
  assert.deepEqual(await classify(MODEL, OK_AUTH, PROMPT, { completeFn: throwing }), {
    status: "unavailable",
    detail: "rate-limited",
  });
});

test("classify tags a non-rate-limit error as detail=error", async () => {
  const throwing: CompleteFn = async () => {
    throw new Error("ECONNRESET");
  };
  assert.deepEqual(await classify(MODEL, OK_AUTH, PROMPT, { completeFn: throwing }), {
    status: "unavailable",
    detail: "error",
  });
});

test("classify passes the credential through to complete()", async () => {
  let seenApiKey: string | undefined;
  const spy: CompleteFn = async (_model, _context, options) => {
    seenApiKey = options.apiKey;
    return { content: [{ type: "text", text: '{"model":"a/b"}' }] };
  };
  await classify(MODEL, { ok: true, apiKey: "secret-key" }, PROMPT, { completeFn: spy });
  assert.equal(seenApiKey, "secret-key");
});
