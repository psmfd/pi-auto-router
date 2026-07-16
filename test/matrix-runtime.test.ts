import assert from "node:assert/strict";
import { test } from "node:test";

import type { AvailabilitySnapshot } from "../shared/availability-snapshot.ts";
import type { MatrixLoadResult } from "../shared/routing-matrix.ts";
import { refreshMatrixRuntime } from "../matrix-runtime.ts";

const LOAD: MatrixLoadResult = {
  ok: true,
  path: "/matrix.json",
  matrix: {
    v: 1,
    lastReviewed: "2026-07-16",
    staleAfterDays: 180,
    models: { "p/m": { capable: ["simple-qa"] } },
  },
  diagnostics: [],
};

const SNAPSHOT = {
  v: 1,
  generation: 2,
  createdAt: "2026-07-16T00:00:00.000Z",
  hash: `sha256:${"a".repeat(64)}`,
  registryCandidates: [],
  candidates: [],
  filters: {
    copilot: { state: "not-applicable" },
    anthropic: { state: "not-applicable" },
    omlx: { state: "not-applicable" },
  },
} as const satisfies AvailabilitySnapshot;

function deps(unavailable: Set<string>, calls: string[], snapshot: () => Promise<AvailabilitySnapshot> = () => Promise.resolve(SNAPSHOT)) {
  return {
    loadMatrix: () => {
      calls.push("load-matrix");
      return Promise.resolve(LOAD);
    },
    clearAvailabilitySnapshot: () => void calls.push("clear-snapshot"),
    clearCopilotCache: () => void calls.push("clear-copilot"),
    clearAnthropicCache: () => void calls.push("clear-anthropic"),
    clearOmlxCache: () => void calls.push("clear-omlx"),
    buildSnapshot: snapshot,
    clearDecisionCache: () => void calls.push("clear-decisions"),
    unavailable,
  };
}

test("refresh clears policy/discovery caches but preserves session unavailable by default", async () => {
  const calls: string[] = [];
  const unavailable = new Set(["p/dead"]);
  const result = await refreshMatrixRuntime(deps(unavailable, calls), false);
  assert.deepEqual(calls, [
    "clear-snapshot",
    "clear-copilot",
    "clear-anthropic",
    "clear-omlx",
    "clear-decisions",
    "load-matrix",
  ]);
  assert.deepEqual([...unavailable], ["p/dead"]);
  assert.equal(result.snapshot, SNAPSHOT);
  assert.equal(result.retriedUnavailable, false);
});

test("retry-unavailable explicitly clears the session deny set", async () => {
  const unavailable = new Set(["p/dead"]);
  const result = await refreshMatrixRuntime(deps(unavailable, []), true);
  assert.equal(unavailable.size, 0);
  assert.equal(result.retriedUnavailable, true);
});

test("snapshot failure is sanitized without discarding the reloaded matrix", async () => {
  const result = await refreshMatrixRuntime(
    deps(new Set(), [], () => Promise.reject(new Error("https://token@example.invalid/private"))),
    false,
  );
  assert.equal(result.matrixLoad, LOAD);
  assert.equal(result.snapshot, null);
  assert.equal(result.snapshotError, "snapshot-build-failed");
  assert.doesNotMatch(JSON.stringify(result), /token@example/);
});
