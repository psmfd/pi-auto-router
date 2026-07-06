import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendTaskRecord,
  buildTaskRecord,
  taskTypesLogPath,
  type AssistantMessageLike,
} from "../recorder.ts";

const CTX = { ts: "2026-07-05T00:00:00.000Z", turn: 2, providerFallback: "anthropic", policyTag: "untagged" };

test("buildTaskRecord joins the pending taskType with the assistant turn's usage", () => {
  const msg: AssistantMessageLike = {
    role: "assistant",
    model: "claude-sonnet-5",
    provider: "anthropic",
    usage: { input: 812, output: 340, cacheRead: 4200, cacheWrite: 0, cost: { total: 0.0193 } },
  };
  assert.deepEqual(buildTaskRecord("code-edit", "classifier", msg, CTX), {
    ts: CTX.ts, turn: 2, taskType: "code-edit", source: "classifier", model: "claude-sonnet-5", provider: "anthropic",
    input: 812, cacheRead: 4200, cacheWrite: 0, output: 340, costTotal: 0.0193, policy: "untagged",
  });
});

test("buildTaskRecord returns null for non-assistant messages", () => {
  assert.equal(buildTaskRecord("simple-qa", "classifier", { role: "user" }, CTX), null);
  assert.equal(buildTaskRecord("simple-qa", "classifier", undefined, CTX), null);
});

test("buildTaskRecord defaults absent usage/model/provider and keeps missing cost null", () => {
  const r = buildTaskRecord("unknown", "classifier", { role: "assistant" }, CTX)!;
  assert.deepEqual(r, {
    ts: CTX.ts, turn: 2, taskType: "unknown", source: "classifier", model: "unknown", provider: "anthropic",
    input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costTotal: null, policy: "untagged",
  });
});

test("buildTaskRecord stamps an explicit policyTag and normalizes empty to untagged (#521)", () => {
  const msg: AssistantMessageLike = { role: "assistant", model: "m", provider: "p" };
  assert.equal(buildTaskRecord("simple-qa", "classifier", msg, { ...CTX, policyTag: "mixed-local" })!.policy, "mixed-local");
  assert.equal(buildTaskRecord("simple-qa", "classifier", msg, { ...CTX, policyTag: "  " })!.policy, "untagged");
});

test("buildTaskRecord falls back to the inherited TOKEN_METER_POLICY_TAG env (#521)", () => {
  const msg: AssistantMessageLike = { role: "assistant", model: "m", provider: "p" };
  const prev = process.env["TOKEN_METER_POLICY_TAG"];
  try {
    process.env["TOKEN_METER_POLICY_TAG"] = "all-frontier";
    const noTagCtx = { ts: CTX.ts, turn: CTX.turn, providerFallback: CTX.providerFallback };
    assert.equal(buildTaskRecord("simple-qa", "classifier", msg, noTagCtx)!.policy, "all-frontier");
    delete process.env["TOKEN_METER_POLICY_TAG"];
    assert.equal(buildTaskRecord("simple-qa", "classifier", msg, noTagCtx)!.policy, "untagged");
  } finally {
    if (prev === undefined) delete process.env["TOKEN_METER_POLICY_TAG"];
    else process.env["TOKEN_METER_POLICY_TAG"] = prev;
  }
});

test("appendTaskRecord appends JSONL lines under the extension dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auto-router-rec-"));
  try {
    const rec = buildTaskRecord(
      "agentic-loop",
      "matrix",
      { role: "assistant", model: "m", provider: "p", usage: { input: 1, output: 2 } },
      CTX,
    )!;
    await appendTaskRecord(rec, dir);
    await appendTaskRecord(rec, dir);
    const file = taskTypesLogPath(dir);
    assert.equal(file, join(dir, "extensions", "auto-router", "task-types.jsonl"));
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), rec);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
