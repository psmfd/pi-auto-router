import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import type { AvailabilitySnapshot } from "../shared/availability-snapshot.ts";
import type { Candidate } from "../shared/candidates.ts";
import type { MatrixLoadResult, MatrixEntry } from "../shared/routing-matrix.ts";
import {
  buildMatrixReviewPayload,
  extractContextClaims,
  formatMatrixReviewHuman,
  formatMatrixReviewJson,
} from "../matrix-review.ts";

function candidate(provider: string, id: string, contextWindow: number): Candidate {
  return {
    provider,
    id,
    contextWindow,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function fixture(reverse = false): {
  matrixLoad: MatrixLoadResult;
  snapshot: AvailabilitySnapshot;
  unavailable: Set<string>;
} {
  const activeRows: Array<[string, MatrixEntry]> = [
    [
      "github-copilot/claude-opus-4.7",
      {
        capable: ["creative", "simple-qa"],
        tier: "frontier",
        rationale: "Copilot registration has a 200K window, so no long-context.",
      },
    ],
    ...Array.from({ length: 6 }, (_, index): [string, MatrixEntry] => [
      `github-copilot/m${index}`,
      {
        capable: ["code-review", "simple-qa"],
        tier: "capable",
        rationale: "200K window fixture evidence.",
      },
    ]),
  ];
  const inertRows = Array.from({ length: 4 }, (_, index): [string, MatrixEntry] => [
    `anthropic/future-${index}`,
    {
      capable: ["simple-qa"],
      tier: "frontier",
      rationale: "Official provider evidence; forward declared on this host.",
    },
  ]);
  const rows = [...activeRows, ...inertRows];
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: {
      v: 1,
      lastReviewed: "2026-07-12",
      staleAfterDays: 180,
      models: Object.fromEntries(reverse ? [...rows].reverse() : rows),
    },
    diagnostics: [],
  };

  const matching = [
    candidate("github-copilot", "claude-opus-4.7", 1_000_000),
    ...Array.from({ length: 6 }, (_, index) => candidate("github-copilot", `m${index}`, 200_000)),
  ];
  const unlisted = Array.from({ length: 21 }, (_, index) =>
    candidate("github-copilot", `unlisted-${String(index).padStart(2, "0")}`, 128_000),
  );
  const registry = [...matching, ...unlisted];
  const candidates = reverse ? [...registry].reverse() : registry;
  const snapshot: AvailabilitySnapshot = {
    v: 1,
    generation: 4,
    createdAt: "2026-07-16T00:00:00.000Z",
    hash: `sha256:${"c".repeat(64)}`,
    registryCandidates: candidates,
    candidates,
    filters: {
      copilot: {
        state: "verified",
        ids: candidates.map((model) => model.id),
      },
      anthropic: { state: "not-applicable" },
      omlx: { state: "not-applicable" },
    },
  };
  return {
    matrixLoad,
    snapshot,
    unavailable: new Set(reverse ? ["z/dead", "a/dead"] : ["a/dead", "z/dead"]),
  };
}

test("review covers the 28/11/7/21/4 baseline and detects the Opus context conflict", () => {
  const payload = buildMatrixReviewPayload(fixture());
  assert.deepEqual(payload.counts, {
    catalog: 28,
    matrix: 11,
    intersection: 7,
    live: 28,
    unlisted: 21,
    unlistedLive: 21,
    unlistedFiltered: 0,
    inert: 4,
    dangling: 0,
    filtered: 0,
    sessionUnavailable: 2,
  });
  const conflict = payload.observations.find(
    (item) => item.kind === "context-rationale-conflict" && item.key === "github-copilot/claude-opus-4.7",
  );
  assert.match(conflict?.detail ?? "", /contextWindow=1000000; rationale claims=200000/);
  assert.equal(payload.proposals.filter((item) => item.action === "review-addition").length, 21);
  assert.equal(payload.proposals.filter((item) => item.action === "review-change-or-removal").length, 4);
  assert.match(payload.evidenceHash, /^sha256:[0-9a-f]{64}$/);
});

test("equivalent reordered inputs produce byte-stable human and JSON reports", () => {
  const forward = buildMatrixReviewPayload(fixture(false));
  const reverse = buildMatrixReviewPayload(fixture(true));
  assert.equal(forward.evidenceHash, reverse.evidenceHash);
  assert.equal(formatMatrixReviewJson(forward), formatMatrixReviewJson(reverse));
  assert.equal(formatMatrixReviewHuman(forward), formatMatrixReviewHuman(reverse));
});

test("review separates facts, observations, and human-only proposals", () => {
  const payload = buildMatrixReviewPayload(fixture());
  assert.equal(payload.facts.unlistedModels.length, 21);
  assert.equal(payload.facts.inertRows.length, 4);
  assert.ok(payload.observations.some((item) => item.kind === "session-unavailable"));
  assert.ok(payload.proposals.every((item) => !("capable" in item) && !("tier" in item)));
  const human = formatMatrixReviewHuman(payload);
  assert.match(human, /^MATRIX REVIEW v1 evidence=sha256:/);
  assert.match(human, /OBSERVATIONS \(/);
  assert.match(human, /HUMAN-ACTION PROPOSALS \(/);
  assert.match(human, /this command never writes or grants capability policy/);
});

test("snapshot failures are typed and never serialize raw exception text", () => {
  const payload = buildMatrixReviewPayload({
    matrixLoad: null,
    snapshot: null,
    snapshotError: "https://token@example.invalid/private",
    unavailable: new Set(),
  });
  const json = formatMatrixReviewJson(payload);
  assert.match(json, /snapshot-build-failed/);
  assert.doesNotMatch(json, /token@example/);
});

test("review reports every typed loader gap even when strict loading rejects the matrix", () => {
  const cases = [
    ["capable", "capability-gap", "capabilities"],
    ["rationale", "rationale-gap", "rationales"],
    ["tier", "tier-gap", "tiers"],
  ] as const;
  for (const [field, kind, fact] of cases) {
    const failedLoad: MatrixLoadResult = {
      ok: false,
      path: "/fixture/routing-matrix.json",
      matrix: null,
      diagnostics: [
        {
          code: "invalid-schema",
          severity: "error",
          message: `matrix row p/bad has a ${field} gap`,
          row: "p/bad",
          field,
        },
      ],
    };
    const payload = buildMatrixReviewPayload({
      matrixLoad: failedLoad,
      snapshot: null,
      unavailable: new Set(),
    });
    assert.deepEqual(payload.facts.policyGaps[fact], ["p/bad"]);
    assert.ok(payload.observations.some((item) => item.kind === kind && item.key === "p/bad"));
    assert.ok(payload.proposals.some((item) => item.action === "review-change" && item.target === "p/bad"));
  }
});

test("missing matrix diagnostics remain visible and produce evidence collection", () => {
  const missing: MatrixLoadResult = {
    ok: false,
    path: "/fixture/routing-matrix.json",
    matrix: null,
    diagnostics: [{ code: "missing", severity: "error", message: "matrix file is missing" }],
  };
  const payload = buildMatrixReviewPayload({
    matrixLoad: missing,
    snapshot: null,
    unavailable: new Set(),
  });
  assert.ok(payload.observations.some((item) => item.kind === "matrix-diagnostic" && item.key === "missing"));
  assert.ok(payload.proposals.some((item) => item.action === "collect-evidence" && item.target === "matrix"));
});

test("review distinguishes dangling, filtered, inert, and filtered-unlisted evidence", () => {
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: {
      v: 1,
      lastReviewed: "2026-01-01",
      staleAfterDays: 30,
      models: Object.fromEntries(
        [
          "github-copilot/live",
          "github-copilot/filtered",
          "github-copilot/dangling",
          "anthropic/inert",
        ].map((key) => [
          key,
          { capable: ["simple-qa"], tier: "capable", rationale: "128K context window." },
        ]),
      ),
    },
    diagnostics: [{ code: "stale", severity: "warning", message: "matrix freshness is stale" }],
  };
  const registry = [
    candidate("github-copilot", "live", 128_000),
    candidate("github-copilot", "filtered", 128_000),
    candidate("github-copilot", "unlisted-live", 128_000),
    candidate("github-copilot", "unlisted-filtered", 128_000),
  ];
  const live = [registry[0], registry[2]];
  const snapshot: AvailabilitySnapshot = {
    v: 1,
    generation: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    hash: `sha256:${"d".repeat(64)}`,
    registryCandidates: registry,
    candidates: live,
    filters: {
      copilot: { state: "verified", ids: ["live", "unlisted-live"] },
      anthropic: { state: "not-applicable" },
      omlx: { state: "not-applicable" },
    },
  };
  const payload = buildMatrixReviewPayload({ matrixLoad, snapshot, unavailable: new Set() });
  assert.deepEqual(payload.facts.danglingRows, ["github-copilot/dangling"]);
  assert.deepEqual(payload.facts.filteredRows, ["github-copilot/filtered"]);
  assert.deepEqual(payload.facts.inertRows, ["anthropic/inert"]);
  assert.deepEqual(payload.facts.unlistedLiveModels, ["github-copilot/unlisted-live"]);
  assert.deepEqual(payload.facts.unlistedFilteredModels, ["github-copilot/unlisted-filtered"]);
  assert.ok(payload.proposals.some((item) => item.action === "review-refresh"));
  assert.ok(payload.proposals.some((item) => item.action === "review-addition" && item.target === "github-copilot/unlisted-live"));
  assert.ok(!payload.proposals.some((item) => item.action === "review-addition" && item.target === "github-copilot/unlisted-filtered"));
});

test("inconclusive provider evidence fails open without filtered classifications", () => {
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: {
      v: 1,
      lastReviewed: "2026-07-12",
      staleAfterDays: 180,
      models: {
        "github-copilot/live": {
          capable: ["simple-qa"],
          tier: "capable",
          rationale: "128K context window.",
        },
      },
    },
    diagnostics: [],
  };
  const registry = [
    candidate("github-copilot", "live", 128_000),
    candidate("github-copilot", "unlisted", 128_000),
  ];
  const snapshot: AvailabilitySnapshot = {
    v: 1,
    generation: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    hash: `sha256:${"f".repeat(64)}`,
    registryCandidates: registry,
    candidates: registry,
    filters: {
      copilot: { state: "inconclusive" },
      anthropic: { state: "not-applicable" },
      omlx: { state: "not-applicable" },
    },
  };
  const payload = buildMatrixReviewPayload({ matrixLoad, snapshot, unavailable: new Set() });
  assert.deepEqual(payload.facts.filteredRows, []);
  assert.deepEqual(payload.facts.unlistedFilteredModels, []);
  assert.deepEqual(payload.facts.unlistedLiveModels, ["github-copilot/unlisted"]);
  assert.ok(payload.observations.some((item) => item.kind === "inconclusive-provider" && item.key === "copilot"));
});

test("report detail is bounded while counts and evidence hash cover the full input", () => {
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: {
      v: 1,
      lastReviewed: "2026-07-12",
      staleAfterDays: 180,
      models: {
        "p/live": {
          capable: ["simple-qa"],
          tier: "capable",
          rationale: `${"x".repeat(600)} 128K context window`,
        },
      },
    },
    diagnostics: [],
  };
  const registry = [
    candidate("p", "live", 128_000),
    ...Array.from({ length: 150 }, (_, index) => candidate("p", `unlisted-${index}`, 128_000)),
  ];
  const snapshot: AvailabilitySnapshot = {
    v: 1,
    generation: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    hash: `sha256:${"e".repeat(64)}`,
    registryCandidates: registry,
    candidates: registry,
    filters: {
      copilot: { state: "not-applicable" },
      anthropic: { state: "verified", ids: registry.map((model) => model.id) },
      omlx: { state: "not-applicable" },
    },
  };
  const payload = buildMatrixReviewPayload({ matrixLoad, snapshot, unavailable: new Set() });
  assert.equal(payload.counts.unlisted, 150);
  assert.equal(payload.facts.unlistedModels.length, 100);
  assert.equal(payload.facts.omitted.unlistedModels, 50);
  assert.equal(payload.facts.omitted.unlistedLiveModels, 50);
  assert.equal(payload.availability.state === "loaded" && payload.availability.filters.anthropic.ids?.length, 100);
  assert.equal(payload.availability.state === "loaded" && payload.availability.filterOmitted.anthropic, 51);
  assert.equal(payload.proposals.length, 100);
  assert.equal(payload.facts.omitted.proposals, 50);
  assert.equal(payload.facts.policyRows[0]?.rationale.length, 500);
  assert.equal(payload.facts.policyRows[0]?.rationaleTruncated, true);
  assert.match(formatMatrixReviewHuman(payload), /DETAIL LIMIT max=100 omitted=/);
});

test("policy-gap detail caps have explicit omission counters", () => {
  const rows = Object.fromEntries(
    Array.from({ length: 150 }, (_, index) => [
      `p/model-${index}`,
      { capable: ["simple-qa"], rationale: "reviewed evidence" },
    ]),
  );
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: { v: 1, lastReviewed: "2026-07-12", staleAfterDays: 180, models: rows },
    diagnostics: [],
  };
  const payload = buildMatrixReviewPayload({
    matrixLoad,
    snapshot: null,
    unavailable: new Set(),
  });
  assert.equal(payload.facts.policyRows.length, 100);
  assert.equal(payload.facts.omitted.policyRows, 50);
  assert.equal(payload.facts.policyGaps.tiers.length, 100);
  assert.equal(payload.facts.omitted.tierGaps, 50);
});

test("per-row context claim details are capped with an explicit omission count", () => {
  const rationale = Array.from({ length: 150 }, (_, index) => `${index + 1}K context window`).join("; ");
  const matrixLoad: MatrixLoadResult = {
    ok: true,
    path: "/fixture/routing-matrix.json",
    matrix: {
      v: 1,
      lastReviewed: "2026-07-12",
      staleAfterDays: 180,
      models: {
        "p/claims": { capable: ["simple-qa"], tier: "capable", rationale },
      },
    },
    diagnostics: [],
  };
  const model = candidate("p", "claims", 999_999);
  const snapshot: AvailabilitySnapshot = {
    v: 1,
    generation: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    hash: `sha256:${"9".repeat(64)}`,
    registryCandidates: [model],
    candidates: [model],
    filters: {
      copilot: { state: "not-applicable" },
      anthropic: { state: "not-applicable" },
      omlx: { state: "not-applicable" },
    },
  };
  const payload = buildMatrixReviewPayload({ matrixLoad, snapshot, unavailable: new Set() });
  assert.equal(payload.facts.policyRows[0]?.contextClaims.length, 100);
  assert.equal(payload.facts.policyRows[0]?.contextClaimsOmitted, 50);
  assert.match(
    payload.observations.find((item) => item.kind === "context-rationale-conflict")?.detail ?? "",
    /\(\+50 omitted\)$/,
  );
});

test("human output JSON-quotes custom identifiers with control characters", () => {
  const base = fixture();
  const hostile = candidate("github-copilot", "evil\n\u001b[31m", 128_000);
  const snapshot = {
    ...base.snapshot,
    registryCandidates: [...base.snapshot.registryCandidates, hostile],
    candidates: [...base.snapshot.candidates, hostile],
  } satisfies AvailabilitySnapshot;
  const human = formatMatrixReviewHuman(
    buildMatrixReviewPayload({ ...base, snapshot }),
  );
  assert.equal(human.includes("\u001b"), false);
  assert.equal(human.includes("github-copilot/evil\n"), false);
  assert.match(human, /github-copilot\/evil\\n\\u001b\[31m/);
});

test("context claim extraction requires context semantics and excludes output/training quantities", () => {
  assert.deepEqual(
    extractContextClaims("202K native window; caps contextWindow at 131072; 1M-window peer; 128K output; trained on 200K examples"),
    [131_072, 202_000, 1_000_000],
  );
  assert.deepEqual(
    extractContextClaims("128K output; trained on 200K examples for long-context tasks"),
    [],
  );
  assert.deepEqual(extractContextClaims("context window: 200K; context is 1M"), [200_000, 1_000_000]);
  assert.deepEqual(
    extractContextClaims(
      "contextWindow: 128000-output tokens; contextWindow: 200000_training examples; " +
      "contextWindow: 128000, output tokens; contextWindow: 200000; training examples; " +
      "contextWindow: 128K-output tokens; contextWindow: 200K_training examples",
    ),
    [],
  );
});

test("no-write invariant: review module has no filesystem, subprocess, or policy-write API", async () => {
  const source = await readFile(new URL("../matrix-review.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /node:fs|child_process|writeFile|appendFile|createWriteStream|registerTool|routing-matrix\.json/,
  );
});
