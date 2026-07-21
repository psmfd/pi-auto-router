import { createHash } from "node:crypto";

import type {
  AvailabilitySnapshot,
  ProviderAvailabilityEvidence,
} from "./shared/availability-snapshot.ts";
import {
  gardenMatrix,
  type MatrixLoadResult,
  type MatrixTier,
  type RefreshMetadata,
} from "./shared/routing-matrix.ts";

export interface MatrixReviewInput {
  readonly matrixLoad: MatrixLoadResult | null;
  readonly snapshot: AvailabilitySnapshot | null;
  readonly snapshotError?: string;
  readonly unavailable: ReadonlySet<string>;
}

export interface MatrixReviewObservation {
  readonly kind:
    | "availability-error"
    | "availability-not-built"
    | "capability-gap"
    | "context-rationale-conflict"
    | "dangling-row"
    | "filtered-row"
    | "inconclusive-provider"
    | "inert-row"
    | "matrix-diagnostic"
    | "matrix-not-loaded"
    | "rationale-gap"
    | "session-unavailable"
    | "tier-gap"
    | "unlisted-filtered-model"
    | "unlisted-model";
  readonly key: string;
  readonly detail: string;
}

export interface MatrixReviewProposal {
  readonly action:
    | "collect-evidence"
    | "review-addition"
    | "review-change"
    | "review-change-or-removal"
    | "review-refresh";
  readonly target: string;
  readonly reason: string;
  readonly requiredEvidence: readonly string[];
}

export interface MatrixReviewPayload {
  readonly v: 1;
  readonly kind: "routing-matrix-review";
  readonly evidenceHash: string;
  readonly matrix:
    | { readonly state: "not-loaded" }
    | {
        readonly state: "error";
        readonly diagnostics: readonly {
          code: string;
          severity: string;
          row?: string;
          field?: string;
        }[];
      }
    | {
        readonly state: "loaded";
        readonly version: number;
        readonly lastReviewed: string;
        readonly staleAfterDays: number;
        readonly refresh: RefreshMetadata | null;
        readonly diagnostics: readonly {
          code: string;
          severity: string;
          row?: string;
          field?: string;
        }[];
      };
  readonly availability:
    | { readonly state: "not-built" }
    | { readonly state: "error"; readonly code: "snapshot-build-failed" }
    | {
        readonly state: "loaded";
        readonly generation: number;
        readonly hash: string;
        readonly createdAt: string;
        readonly filters: {
          readonly copilot: ProviderAvailabilityEvidence;
          readonly anthropic: ProviderAvailabilityEvidence;
          readonly omlx: ProviderAvailabilityEvidence;
        };
        readonly filterOmitted: {
          readonly copilot: number;
          readonly anthropic: number;
          readonly omlx: number;
        };
      };
  readonly counts: {
    readonly catalog: number | null;
    readonly matrix: number | null;
    readonly intersection: number | null;
    readonly live: number | null;
    readonly unlisted: number | null;
    readonly unlistedLive: number | null;
    readonly unlistedFiltered: number | null;
    readonly inert: number | null;
    readonly dangling: number | null;
    readonly filtered: number | null;
    readonly sessionUnavailable: number;
  };
  readonly facts: {
    readonly policyRows: readonly {
      readonly key: string;
      readonly capable: readonly string[];
      readonly tier: MatrixTier | null;
      readonly rationale: string;
      readonly rationaleTruncated: boolean;
      readonly contextClaims: readonly number[];
      readonly contextClaimsOmitted: number;
    }[];
    readonly registryModels: readonly {
      readonly key: string;
      readonly contextWindow: number;
    }[];
    readonly liveModels: readonly string[];
    readonly unlistedModels: readonly string[];
    readonly unlistedLiveModels: readonly string[];
    readonly unlistedFilteredModels: readonly string[];
    readonly sessionUnavailable: readonly string[];
    readonly inertRows: readonly string[];
    readonly danglingRows: readonly string[];
    readonly filteredRows: readonly string[];
    readonly policyGaps: {
      readonly capabilities: readonly string[];
      readonly rationales: readonly string[];
      readonly tiers: readonly string[];
    };
    readonly omitted: {
      readonly policyRows: number;
      readonly registryModels: number;
      readonly liveModels: number;
      readonly unlistedModels: number;
      readonly unlistedLiveModels: number;
      readonly unlistedFilteredModels: number;
      readonly inertRows: number;
      readonly danglingRows: number;
      readonly filteredRows: number;
      readonly sessionUnavailable: number;
      readonly capabilityGaps: number;
      readonly rationaleGaps: number;
      readonly tierGaps: number;
      readonly observations: number;
      readonly proposals: number;
    };
  };
  readonly observations: readonly MatrixReviewObservation[];
  readonly proposals: readonly MatrixReviewProposal[];
  readonly policyNotice: "observations and proposals are advisory; this command never writes or grants capability policy";
}

const MAX_DETAIL_ROWS = 100;
const MAX_RATIONALE_CHARS = 500;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function modelKey(candidate: { readonly provider: string; readonly id: string }): string {
  return `${candidate.provider}/${candidate.id}`;
}

function providerOf(key: string): string {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : key;
}

function canonicalFilter(value: ProviderAvailabilityEvidence): ProviderAvailabilityEvidence {
  return value.state === "verified"
    ? { state: "verified", ids: bounded([...(value.ids ?? [])].sort(compareText)) }
    : { state: value.state };
}

function filterOmitted(value: ProviderAvailabilityEvidence): number {
  return value.state === "verified" ? omitted(value.ids ?? []) : 0;
}

function isEvidenceSeparator(char: string | undefined): boolean {
  return char === undefined || char.trim() === "" || "-_:,;=/()[]{}".includes(char);
}

function trimLeadingEvidenceSeparators(value: string): string {
  let index = 0;
  while (index < value.length && isEvidenceSeparator(value[index])) index += 1;
  return value.slice(index);
}

function trimTrailingEvidenceSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && isEvidenceSeparator(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

/** Extract only quantities explicitly associated with context/window semantics. */
export function extractContextClaims(rationale: string): number[] {
  const claims = new Set<number>();
  const lower = rationale.toLowerCase();
  for (let start = 0; start < rationale.length; start++) {
    if (rationale[start] === undefined || rationale[start] < "0" || rationale[start] > "9") continue;
    let end = start;
    while (end < rationale.length) {
      const char = rationale[end];
      if (char === undefined || ((char < "0" || char > "9") && char !== ".")) break;
      end += 1;
    }
    let unitAt = end;
    while (rationale[unitAt] === " ") unitAt += 1;
    const unit = rationale[unitAt]?.toUpperCase();
    if (unit !== "K" && unit !== "M") {
      start = Math.max(start, end - 1);
      continue;
    }
    const before = trimTrailingEvidenceSeparators(
      lower.slice(Math.max(0, start - 32), start),
    );
    const after = lower.slice(unitAt + 1, unitAt + 33);
    const immediateAfter = trimLeadingEvidenceSeparators(after);
    const describesOtherQuantity = ["out", "output", "training", "examples"]
      .some((prefix) => immediateAfter.startsWith(prefix));
    const isContextAfter = ["window", "context", "token window", "token context", "native window", "native context"]
      .some((prefix) => immediateAfter.startsWith(prefix));
    const isContextBefore = ["window", "context", "contextwindow", "window is", "context is", "window of", "context of"]
      .some((suffix) => before.endsWith(suffix));
    const isContext = isContextAfter || isContextBefore;
    const value = Number(rationale.slice(start, end));
    if (!describesOtherQuantity && isContext && Number.isFinite(value)) {
      claims.add(Math.round(value * (unit === "M" ? 1_000_000 : 1_000)));
    }
    start = unitAt;
  }

  const marker = "contextwindow";
  let markerAt = lower.indexOf(marker);
  while (markerAt >= 0) {
    let digitAt = markerAt + marker.length;
    while (lower[digitAt] === " " || lower[digitAt] === "\t" || lower[digitAt] === ":" || lower[digitAt] === "=") digitAt += 1;
    for (const prefix of ["at ", "to ", "is ", "of "]) {
      if (lower.slice(digitAt).startsWith(prefix)) {
        digitAt += prefix.length;
        break;
      }
    }
    let end = digitAt;
    while (end < rationale.length && rationale[end] >= "0" && rationale[end] <= "9") end += 1;
    let unitAt = end;
    while (lower[unitAt]?.trim() === "") unitAt += 1;
    const hasScaledUnit = lower[unitAt]?.toUpperCase() === "K" || lower[unitAt]?.toUpperCase() === "M";
    const suffix = trimLeadingEvidenceSeparators(lower.slice(end));
    const describesOtherQuantity = ["out", "output", "training", "examples"]
      .some((prefix) => suffix.startsWith(prefix));
    const value = Number(rationale.slice(digitAt, end));
    if (!hasScaledUnit && !describesOtherQuantity && end > digitAt && Number.isInteger(value) && value > 0) {
      claims.add(value);
    }
    markerAt = lower.indexOf(marker, markerAt + marker.length);
  }
  return [...claims].sort((a, b) => a - b);
}

function bounded<T>(values: readonly T[]): T[] {
  return values.slice(0, MAX_DETAIL_ROWS);
}

function omitted(values: readonly unknown[]): number {
  return Math.max(0, values.length - MAX_DETAIL_ROWS);
}

function reviewHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function observation(
  kind: MatrixReviewObservation["kind"],
  key: string,
  detail: string,
): MatrixReviewObservation {
  return { kind, key, detail };
}

function proposal(
  action: MatrixReviewProposal["action"],
  target: string,
  reason: string,
  requiredEvidence: readonly string[],
): MatrixReviewProposal {
  return { action, target, reason, requiredEvidence };
}

export function buildMatrixReviewPayload(input: MatrixReviewInput): MatrixReviewPayload {
  const load = input.matrixLoad;
  const matrix = load?.ok ? load.matrix : null;
  const fullPolicyRows = matrix
    ? Object.entries(matrix.models)
        .sort(([a], [b]) => compareText(a, b))
        .map(([key, row]) => {
          const rationale = row.rationale ?? "";
          return {
            key,
            capable: [...row.capable].sort(compareText),
            tier: row.tier ?? null,
            rationale,
            contextClaims: extractContextClaims(rationale),
          };
        })
    : [];
  const policyRows = bounded(fullPolicyRows).map((row) => ({
    ...row,
    rationale: row.rationale.slice(0, MAX_RATIONALE_CHARS),
    rationaleTruncated: row.rationale.length > MAX_RATIONALE_CHARS,
    contextClaims: bounded(row.contextClaims),
    contextClaimsOmitted: omitted(row.contextClaims),
  }));
  const matrixKeys = fullPolicyRows.map((row) => row.key);
  const matrixSet = new Set(matrixKeys);

  const registryModels = input.snapshot
    ? input.snapshot.registryCandidates
        .map((candidate) => ({ key: modelKey(candidate), contextWindow: candidate.contextWindow }))
        .sort((a, b) => compareText(a.key, b.key))
    : [];
  const registryKeys = registryModels.map((candidate) => candidate.key);
  const registrySet = new Set(registryKeys);
  const registryProviders = new Set(registryKeys.map(providerOf));
  const registryByKey = new Map(registryModels.map((candidate) => [candidate.key, candidate] as const));
  const liveModels = input.snapshot
    ? input.snapshot.candidates.map(modelKey).sort(compareText)
    : [];
  const liveSet = new Set(liveModels);
  const unavailable = [...input.unavailable].sort(compareText);

  const unlistedModels = matrix ? registryKeys.filter((key) => !matrixSet.has(key)) : [];
  const unlistedLiveModels = unlistedModels.filter((key) => liveSet.has(key));
  const unlistedFilteredModels = unlistedModels.filter((key) => !liveSet.has(key));
  const inertRows = input.snapshot
    ? matrixKeys.filter((key) => !registryProviders.has(providerOf(key)))
    : [];
  // Same predicate as matrix-status.ts's coverage report — one shared
  // implementation so the two reports cannot drift (#791).
  const danglingRows =
    input.snapshot && matrix
      ? [...gardenMatrix(matrix, registrySet).danglingRows].sort(compareText)
      : [];
  const filteredRows = input.snapshot
    ? matrixKeys.filter((key) => registrySet.has(key) && !liveSet.has(key))
    : [];
  const capabilityGaps = fullPolicyRows.filter((row) => row.capable.length === 0).map((row) => row.key);
  const rationaleGaps = fullPolicyRows.filter((row) => row.rationale.trim().length === 0).map((row) => row.key);
  const tierGaps = fullPolicyRows.filter((row) => row.tier === null).map((row) => row.key);

  const observations: MatrixReviewObservation[] = [];
  const proposals: MatrixReviewProposal[] = [];
  if (load === null) {
    observations.push(observation("matrix-not-loaded", "matrix", "matrix policy has not been loaded"));
    proposals.push(proposal("collect-evidence", "matrix", "load the reviewed matrix before proposing policy work", ["strict loader result"]));
  } else {
    for (const diagnostic of load.diagnostics) {
      observations.push(observation("matrix-diagnostic", diagnostic.code, diagnostic.message));
      if (diagnostic.row && diagnostic.field) {
        const gapKind = diagnostic.field === "capable"
          ? "capability-gap"
          : diagnostic.field === "rationale"
            ? "rationale-gap"
            : "tier-gap";
        observations.push(observation(gapKind, diagnostic.row, diagnostic.message));
        const target = diagnostic.field === "capable"
          ? capabilityGaps
          : diagnostic.field === "rationale"
            ? rationaleGaps
            : tierGaps;
        if (!target.includes(diagnostic.row)) target.push(diagnostic.row);
        proposals.push(proposal("review-change", diagnostic.row, `repair the reviewed ${diagnostic.field} policy gap`, ["loader diagnostic", "source evidence", "reviewed source-control change"]));
      }
      if (diagnostic.code === "stale") {
        proposals.push(proposal("review-refresh", "matrix", "matrix freshness exceeded its reviewed threshold", ["current registry snapshot", "provider evidence", "reviewed source-control change"]));
      }
    }
    if (!load.ok) {
      proposals.push(proposal("collect-evidence", "matrix", "repair the typed matrix load failure before row review", ["loader diagnostic", "reviewed source-control change"]));
    }
  }

  if (input.snapshotError) {
    observations.push(observation("availability-error", "snapshot-build-failed", "availability snapshot build failed"));
    proposals.push(proposal("collect-evidence", "availability", "rebuild availability evidence before row proposals", ["successful frozen snapshot"]));
  } else if (!input.snapshot) {
    observations.push(observation("availability-not-built", "snapshot", "availability snapshot has not been built"));
    proposals.push(proposal("collect-evidence", "availability", "build or refresh a frozen snapshot before row proposals", ["successful frozen snapshot"]));
  }

  if (input.snapshot) {
    const filters = [
      ["anthropic", input.snapshot.filters.anthropic],
      ["copilot", input.snapshot.filters.copilot],
      ["omlx", input.snapshot.filters.omlx],
    ] as const;
    for (const [provider, filter] of filters) {
      if (filter.state === "inconclusive") {
        observations.push(observation("inconclusive-provider", provider, "live provider evidence is inconclusive and failed open"));
      }
    }
  }

  for (const key of unlistedLiveModels) {
    observations.push(observation("unlisted-model", key, "live registry model has no reviewed matrix row"));
    proposals.push(proposal("review-addition", key, "evaluate whether this live registry model warrants a reviewed row", ["provider identity evidence", "task capability evaluation", "quality tier evaluation", "human-authored rationale"]));
  }
  for (const key of unlistedFilteredModels) {
    observations.push(observation("unlisted-filtered-model", key, "static registry model has no row and is excluded by live provider evidence"));
    proposals.push(proposal("collect-evidence", key, "do not evaluate an addition until live provider availability is resolved", ["live provider evidence", "provider model catalog"]));
  }
  for (const key of inertRows) {
    observations.push(observation("inert-row", key, "row provider is absent from this host registry and cannot participate"));
    proposals.push(proposal("review-change-or-removal", key, "verify that the forward-declared or unavailable-provider row remains intentional", ["official provider model evidence", "cross-host registry evidence", "reviewed rationale"]));
  }
  for (const key of danglingRows) {
    observations.push(observation("dangling-row", key, "row provider is present but the exact model id is absent"));
    proposals.push(proposal("review-change-or-removal", key, "confirm, replace, or remove the non-resolving row", ["current provider model catalog", "replacement capability evidence", "reviewed rationale"]));
  }
  for (const key of filteredRows) {
    observations.push(observation("filtered-row", key, "static registry row is excluded by live provider evidence"));
    proposals.push(proposal("review-change", key, "verify whether live filtering is transient or the reviewed row is obsolete", ["live provider evidence", "provider documentation", "reviewed source-control change"]));
  }
  for (const key of unavailable) {
    observations.push(observation("session-unavailable", key, "session provider error deny state is transient and separate from capability policy"));
  }
  for (const key of capabilityGaps) {
    if (!observations.some((item) => item.kind === "capability-gap" && item.key === key)) {
      observations.push(observation("capability-gap", key, "row has no valid capability labels"));
      proposals.push(proposal("review-change", key, "supply reviewed capability evidence or remove the row", ["task capability evaluation", "reviewed source-control change"]));
    }
  }
  for (const key of rationaleGaps) {
    if (!observations.some((item) => item.kind === "rationale-gap" && item.key === key)) {
      observations.push(observation("rationale-gap", key, "row has no retained human rationale"));
      proposals.push(proposal("review-change", key, "supply a human-reviewed rationale", ["source evidence", "human-authored rationale"]));
    }
  }
  for (const key of tierGaps) {
    if (!observations.some((item) => item.kind === "tier-gap" && item.key === key)) {
      observations.push(observation("tier-gap", key, "row is valid for un-tiered routing but has no quality tier"));
      proposals.push(proposal("review-change", key, "evaluate whether the row needs an explicit quality tier", ["quality evaluation", "reviewed rationale"]));
    }
  }

  for (const row of fullPolicyRows) {
    const registry = registryByKey.get(row.key);
    if (!registry || row.contextClaims.length === 0 || row.contextClaims.includes(registry.contextWindow)) continue;
    const visibleClaims = bounded(row.contextClaims);
    const omittedClaims = omitted(row.contextClaims);
    const omission = omittedClaims > 0 ? ` (+${omittedClaims} omitted)` : "";
    observations.push(observation("context-rationale-conflict", row.key, `registry contextWindow=${registry.contextWindow}; rationale claims=${visibleClaims.join(",")}${omission}`));
    proposals.push(proposal("review-change", row.key, "verify the reviewed rationale and capability scope against current registry context metadata", ["current registry contextWindow", "provider context documentation", "human-reviewed rationale"]));
  }

  observations.sort((a, b) => compareText(a.kind, b.kind) || compareText(a.key, b.key));
  proposals.sort((a, b) => compareText(a.action, b.action) || compareText(a.target, b.target));
  capabilityGaps.sort(compareText);
  rationaleGaps.sort(compareText);
  tierGaps.sort(compareText);

  const diagnostics = load
    ? load.diagnostics
        .map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          ...(diagnostic.row ? { row: diagnostic.row } : {}),
          ...(diagnostic.field ? { field: diagnostic.field } : {}),
        }))
        .sort(
          (a, b) =>
            compareText(a.code, b.code) ||
            compareText(a.row ?? "", b.row ?? "") ||
            compareText(a.field ?? "", b.field ?? ""),
        )
    : [];
  const matrixStatus: MatrixReviewPayload["matrix"] =
    load === null
      ? { state: "not-loaded" }
      : !load.ok
        ? { state: "error", diagnostics }
        : {
            state: "loaded",
            version: load.matrix.v,
            lastReviewed: load.matrix.lastReviewed,
            staleAfterDays: load.matrix.staleAfterDays ?? 180,
            refresh: load.matrix.refresh ? { ...load.matrix.refresh } : null,
            diagnostics,
          };
  const availability: MatrixReviewPayload["availability"] = input.snapshotError
    ? { state: "error", code: "snapshot-build-failed" }
    : input.snapshot
      ? {
          state: "loaded",
          generation: input.snapshot.generation,
          hash: input.snapshot.hash,
          createdAt: input.snapshot.createdAt,
          filters: {
            copilot: canonicalFilter(input.snapshot.filters.copilot),
            anthropic: canonicalFilter(input.snapshot.filters.anthropic),
            omlx: canonicalFilter(input.snapshot.filters.omlx),
          },
          filterOmitted: {
            copilot: filterOmitted(input.snapshot.filters.copilot),
            anthropic: filterOmitted(input.snapshot.filters.anthropic),
            omlx: filterOmitted(input.snapshot.filters.omlx),
          },
        }
      : { state: "not-built" };

  const canonicalEvidence = {
    v: 1,
    matrix:
      load === null
        ? { state: "not-loaded" }
        : !load.ok
          ? { state: "error", diagnostics }
          : {
              state: "loaded",
              version: load.matrix.v,
              lastReviewed: load.matrix.lastReviewed,
              staleAfterDays: load.matrix.staleAfterDays ?? 180,
              refresh: load.matrix.refresh ? { ...load.matrix.refresh } : null,
              rows: fullPolicyRows,
              diagnostics,
            },
    availability: input.snapshot
      ? { state: "loaded", hash: input.snapshot.hash }
      : input.snapshotError
        ? { state: "error", code: "snapshot-build-failed" }
        : { state: "not-built" },
    unavailable,
  };

  return {
    v: 1,
    kind: "routing-matrix-review",
    evidenceHash: reviewHash(canonicalEvidence),
    matrix: matrixStatus,
    availability,
    counts: {
      catalog: input.snapshot ? registryKeys.length : null,
      matrix: matrix ? matrixKeys.length : null,
      intersection: matrix && input.snapshot ? registryKeys.filter((key) => matrixSet.has(key)).length : null,
      live: input.snapshot ? liveModels.length : null,
      unlisted: matrix && input.snapshot ? unlistedModels.length : null,
      unlistedLive: matrix && input.snapshot ? unlistedLiveModels.length : null,
      unlistedFiltered: matrix && input.snapshot ? unlistedFilteredModels.length : null,
      inert: matrix && input.snapshot ? inertRows.length : null,
      dangling: matrix && input.snapshot ? danglingRows.length : null,
      filtered: matrix && input.snapshot ? filteredRows.length : null,
      sessionUnavailable: unavailable.length,
    },
    facts: {
      policyRows,
      registryModels: bounded(registryModels),
      liveModels: bounded(liveModels),
      unlistedModels: bounded(unlistedModels),
      unlistedLiveModels: bounded(unlistedLiveModels),
      unlistedFilteredModels: bounded(unlistedFilteredModels),
      sessionUnavailable: bounded(unavailable),
      inertRows: bounded(inertRows),
      danglingRows: bounded(danglingRows),
      filteredRows: bounded(filteredRows),
      policyGaps: {
        capabilities: bounded(capabilityGaps),
        rationales: bounded(rationaleGaps),
        tiers: bounded(tierGaps),
      },
      omitted: {
        policyRows: omitted(fullPolicyRows),
        registryModels: omitted(registryModels),
        liveModels: omitted(liveModels),
        unlistedModels: omitted(unlistedModels),
        unlistedLiveModels: omitted(unlistedLiveModels),
        unlistedFilteredModels: omitted(unlistedFilteredModels),
        inertRows: omitted(inertRows),
        danglingRows: omitted(danglingRows),
        filteredRows: omitted(filteredRows),
        sessionUnavailable: omitted(unavailable),
        capabilityGaps: omitted(capabilityGaps),
        rationaleGaps: omitted(rationaleGaps),
        tierGaps: omitted(tierGaps),
        observations: omitted(observations),
        proposals: omitted(proposals),
      },
    },
    observations: bounded(observations),
    proposals: bounded(proposals),
    policyNotice: "observations and proposals are advisory; this command never writes or grants capability policy",
  };
}

export function formatMatrixReviewJson(payload: MatrixReviewPayload): string {
  return JSON.stringify(payload, null, 2);
}

function count(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatMatrixReviewHuman(payload: MatrixReviewPayload): string {
  const observationTotal = payload.observations.length + payload.facts.omitted.observations;
  const proposalTotal = payload.proposals.length + payload.facts.omitted.proposals;
  const filterOmittedTotal = payload.availability.state === "loaded"
    ? Object.values(payload.availability.filterOmitted).reduce((sum, value) => sum + value, 0)
    : 0;
  const omittedTotal =
    Object.values(payload.facts.omitted).reduce((sum, value) => sum + value, 0) +
    filterOmittedTotal;
  const lines = [
    `MATRIX REVIEW v${payload.v} evidence=${payload.evidenceHash}`,
    `FACTS catalog=${count(payload.counts.catalog)} matrix=${count(payload.counts.matrix)} intersection=${count(payload.counts.intersection)} live=${count(payload.counts.live)} unlisted=${count(payload.counts.unlisted)} unlistedLive=${count(payload.counts.unlistedLive)} unlistedFiltered=${count(payload.counts.unlistedFiltered)} inert=${count(payload.counts.inert)} dangling=${count(payload.counts.dangling)} filtered=${count(payload.counts.filtered)} sessionUnavailable=${payload.counts.sessionUnavailable}`,
    `DETAIL LIMIT max=${MAX_DETAIL_ROWS} omitted=${omittedTotal}`,
    `OBSERVATIONS (${payload.observations.length}/${observationTotal})`,
    ...(payload.observations.length > 0
      ? payload.observations.map((item) => `- ${item.kind} ${quote(item.key)}: ${item.detail}`)
      : ["- none"]),
    `HUMAN-ACTION PROPOSALS (${payload.proposals.length}/${proposalTotal})`,
    ...(payload.proposals.length > 0
      ? payload.proposals.map((item) => `- ${item.action} ${quote(item.target)}: ${item.reason}; evidence=${item.requiredEvidence.join(" | ")}`)
      : ["- none"]),
    `POLICY: ${payload.policyNotice}`,
  ];
  return lines.join("\n");
}
