import assert from "node:assert/strict";
import { test } from "node:test";

import type { AvailabilitySnapshot } from "../shared/availability-snapshot.ts";
import type { Candidate } from "../shared/candidates.ts";
import type { MatrixLoadResult } from "../shared/routing-matrix.ts";
import {
  buildMatrixStatusPayload,
  formatMatrixStatusHuman,
  formatMatrixStatusJson,
} from "../matrix-status.ts";

function candidate(provider: string, id: string): Candidate {
  return {
    provider,
    id,
    contextWindow: 128_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

const LOAD: MatrixLoadResult = {
  ok: true,
  path: "/matrix.json",
  matrix: {
    v: 1,
    lastReviewed: "2026-07-10",
    staleAfterDays: 180,
    refresh: {
      at: "2026-07-15T00:00:00.000Z",
      tool: "scripts/analyze-routing-matrix.sh",
      source: "test evidence",
    },
    models: {
      "p/live": { capable: ["simple-qa"] },
      "p/filtered": { capable: ["simple-qa"] },
      "p/dangling": { capable: ["simple-qa"] },
      "q/inert": { capable: ["simple-qa"] },
    },
  },
  diagnostics: [],
};

const SNAPSHOT: AvailabilitySnapshot = {
  v: 1,
  generation: 3,
  createdAt: "2026-07-16T00:00:00.000Z",
  hash: `sha256:${"b".repeat(64)}`,
  registryCandidates: [candidate("p", "filtered"), candidate("p", "live"), candidate("p", "unlisted")],
  candidates: [candidate("p", "live"), candidate("p", "unlisted")],
  filters: {
    copilot: { state: "not-applicable" },
    anthropic: { state: "inconclusive" },
    omlx: { state: "verified", ids: [] },
  },
};

function payload(allowlist = ["p/live", "p/unlisted"], unavailable = new Set(["p/dead"])) {
  return buildMatrixStatusPayload({
    enabled: true,
    matrixLoad: LOAD,
    snapshot: SNAPSHOT,
    localRole: "full",
    preferLocalOmlx: true,
    allowlist,
    providerAllowlist: ["p"],
    unavailable,
    now: new Date("2026-07-16T00:00:00Z"),
  });
}

test("status reports deterministic matrix, snapshot, coverage, and policy inputs", () => {
  const status = payload();
  assert.equal(status.matrix.state, "loaded");
  assert.equal(status.availability.state, "loaded");
  assert.deepEqual(status.coverage, {
    intersection: 1,
    unlisted: 1,
    inertRows: ["q/inert"],
    danglingRows: ["p/dangling"],
    filteredRows: ["p/filtered"],
    unlistedByProvider: { p: 1 },
  });
  assert.deepEqual(status.policy.unavailable, ["p/dead"]);
  assert.equal(status.matrix.state === "loaded" && status.matrix.freshnessSource, "refresh");
  assert.equal(status.matrix.state === "loaded" && status.matrix.freshnessAgeDays, 1);
  const human = formatMatrixStatusHuman(status);
  assert.match(human, /snapshot=g3 sha256:/);
  assert.match(human, /freshness=refresh@2026-07-15T00:00:00.000Z age=1d staleAfter=180d stale=no/);
  assert.match(human, /inert=1\[q\/inert\].*dangling=1\[p\/dangling\].*filtered=1\[p\/filtered\]/);
  assert.match(human, /allowlist=2\[p\/live,p\/unlisted\].*unavailable=1\[p\/dead\]/);
  assert.match(human, /registryReload=current-process; open \/model before refresh/);
});

test("JSON output is stable for equivalent unordered policy inputs", () => {
  const first = payload(["p/unlisted", "p/live"], new Set(["z/dead", "a/dead"]));
  const second = payload(["p/live", "p/unlisted"], new Set(["a/dead", "z/dead"]));
  assert.equal(formatMatrixStatusJson(first), formatMatrixStatusJson(second));
});

test("status surfaces typed matrix and availability failures", () => {
  const failedLoad: MatrixLoadResult = {
    ok: false,
    path: "/matrix.json",
    matrix: null,
    diagnostics: [{ code: "invalid-json", severity: "error", message: "invalid" }],
  };
  const status = buildMatrixStatusPayload({
    enabled: true,
    matrixLoad: failedLoad,
    snapshot: null,
    snapshotError: "registry unavailable",
    localRole: "off",
    preferLocalOmlx: false,
    allowlist: [],
    providerAllowlist: [],
    unavailable: new Set(),
  });
  assert.equal(status.matrix.state, "error");
  assert.equal(status.availability.state, "error");
  assert.match(formatMatrixStatusHuman(status), /matrix=ON error=invalid-json/);
  assert.match(formatMatrixStatusHuman(status), /snapshot=error:snapshot-build-failed/);
  assert.doesNotMatch(formatMatrixStatusJson(status), /registry unavailable/);
});
