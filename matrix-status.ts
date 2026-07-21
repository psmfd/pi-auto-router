import type { AvailabilitySnapshot } from "./shared/availability-snapshot.ts";
import type { LocalRole } from "./shared/local-role.ts";
import {
  gardenMatrix,
  type MatrixLoadResult,
  type RefreshMetadata,
} from "./shared/routing-matrix.ts";

export interface MatrixStatusInput {
  readonly enabled: boolean;
  readonly matrixLoad: MatrixLoadResult | null;
  readonly snapshot: AvailabilitySnapshot | null;
  readonly snapshotError?: string;
  readonly localRole: LocalRole;
  readonly preferLocalOmlx: boolean;
  readonly allowlist: readonly string[];
  readonly providerAllowlist: readonly string[];
  readonly unavailable: ReadonlySet<string>;
  readonly now?: Date;
}

export interface MatrixStatusPayload {
  readonly v: 1;
  readonly enabled: boolean;
  readonly matrix:
    | { readonly state: "not-loaded" }
    | {
        readonly state: "error";
        readonly path: string;
        readonly diagnostics: readonly {
          code: string;
          severity: string;
          message: string;
          row?: string;
          field?: string;
        }[];
      }
    | {
        readonly state: "loaded";
        readonly path: string;
        readonly version: number;
        readonly rows: number;
        readonly lastReviewed: string;
        readonly staleAfterDays: number;
        readonly freshnessAt: string;
        readonly freshnessSource: "review" | "refresh";
        readonly freshnessAgeDays: number | null;
        readonly stale: boolean | null;
        readonly refresh: RefreshMetadata | null;
        readonly diagnostics: readonly {
          code: string;
          severity: string;
          message: string;
          row?: string;
          field?: string;
        }[];
      };
  readonly availability:
    | {
        readonly state: "error";
        readonly code: "snapshot-build-failed";
        readonly message: "availability snapshot build failed";
      }
    | {
        readonly state: "not-built";
      }
    | {
        readonly state: "loaded";
        readonly generation: number;
        readonly hash: string;
        readonly createdAt: string;
        readonly registryModels: number;
        readonly liveModels: number;
        readonly filters: AvailabilitySnapshot["filters"];
      };
  readonly coverage: null | {
    readonly intersection: number;
    readonly unlisted: number;
    readonly inertRows: readonly string[];
    readonly danglingRows: readonly string[];
    readonly filteredRows: readonly string[];
    readonly unlistedByProvider: Readonly<Record<string, number>>;
  };
  readonly policy: {
    readonly localRole: LocalRole;
    readonly preferLocalOmlx: boolean;
    readonly allowlist: readonly string[];
    readonly providerAllowlist: readonly string[];
    readonly unavailable: readonly string[];
  };
  readonly registryReload: "current-process; open /model before refresh after editing models.json";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function candidateKeys(snapshot: AvailabilitySnapshot, kind: "registry" | "live"): string[] {
  const candidates = kind === "registry" ? snapshot.registryCandidates : snapshot.candidates;
  return candidates.map((candidate) => `${candidate.provider}/${candidate.id}`).sort(compareText);
}

function ageDays(value: string, now: Date): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000));
}

export function buildMatrixStatusPayload(input: MatrixStatusInput): MatrixStatusPayload {
  const load = input.matrixLoad;
  const matrixStatus: MatrixStatusPayload["matrix"] =
    load === null
      ? { state: "not-loaded" }
      : !load.ok
        ? { state: "error", path: load.path, diagnostics: load.diagnostics.map((d) => ({ ...d })) }
        : {
            state: "loaded",
            path: load.path,
            version: load.matrix.v,
            rows: Object.keys(load.matrix.models).length,
            lastReviewed: load.matrix.lastReviewed,
            staleAfterDays: load.matrix.staleAfterDays ?? 180,
            freshnessAt: load.matrix.refresh?.at ?? load.matrix.lastReviewed,
            freshnessSource: load.matrix.refresh ? "refresh" : "review",
            ...(() => {
              const age = ageDays(
                load.matrix.refresh?.at ?? load.matrix.lastReviewed,
                input.now ?? new Date(),
              );
              return {
                freshnessAgeDays: age,
                stale: age === null ? null : age > (load.matrix.staleAfterDays ?? 180),
              };
            })(),
            refresh: load.matrix.refresh ? { ...load.matrix.refresh } : null,
            diagnostics: load.diagnostics.map((d) => ({ ...d })),
          };

  const availability: MatrixStatusPayload["availability"] = input.snapshotError
    ? {
        state: "error",
        code: "snapshot-build-failed",
        message: "availability snapshot build failed",
      }
    : input.snapshot === null
      ? { state: "not-built" }
      : {
          state: "loaded",
          generation: input.snapshot.generation,
          hash: input.snapshot.hash,
          createdAt: input.snapshot.createdAt,
          registryModels: input.snapshot.registryCandidates.length,
          liveModels: input.snapshot.candidates.length,
          filters: input.snapshot.filters,
        };

  let coverage: MatrixStatusPayload["coverage"] = null;
  if (load?.ok && input.snapshot) {
    const matrix = load.matrix;
    const registryKeys = candidateKeys(input.snapshot, "registry");
    const liveKeys = candidateKeys(input.snapshot, "live");
    const registrySet = new Set(registryKeys);
    const liveSet = new Set(liveKeys);
    const registryProviders = new Set(input.snapshot.registryCandidates.map((candidate) => candidate.provider));
    const matrixKeys = Object.keys(matrix.models).sort(compareText);
    const gardening = gardenMatrix(matrix, registrySet);
    coverage = {
      intersection: liveKeys.filter((key) => matrix.models[key] !== undefined).length,
      unlisted: registryKeys.filter((key) => matrix.models[key] === undefined).length,
      inertRows: matrixKeys.filter((key) => !registryProviders.has(key.slice(0, key.indexOf("/")))),
      danglingRows: [...gardening.danglingRows].sort(compareText),
      filteredRows: matrixKeys.filter((key) => registrySet.has(key) && !liveSet.has(key)),
      unlistedByProvider: Object.fromEntries(
        Object.entries(gardening.unlistedByProvider).sort(([a], [b]) => compareText(a, b)),
      ),
    };
  }

  return {
    v: 1,
    enabled: input.enabled,
    matrix: matrixStatus,
    availability,
    coverage,
    policy: {
      localRole: input.localRole,
      preferLocalOmlx: input.preferLocalOmlx,
      allowlist: [...input.allowlist].sort(compareText),
      providerAllowlist: [...input.providerAllowlist].sort(compareText),
      unavailable: [...input.unavailable].sort(compareText),
    },
    registryReload: "current-process; open /model before refresh after editing models.json",
  };
}

export function formatMatrixStatusJson(payload: MatrixStatusPayload): string {
  return JSON.stringify(payload, null, 2);
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

export function formatMatrixStatusHuman(payload: MatrixStatusPayload): string {
  const matrixDiagnostics =
    payload.matrix.state === "loaded" && payload.matrix.diagnostics.length > 0
      ? ` diagnostics=${payload.matrix.diagnostics.map((diagnostic) => diagnostic.code).join(",")}`
      : "";
  const matrix =
    payload.matrix.state === "loaded"
      ? `matrix=${payload.enabled ? "ON" : "OFF"} loaded v${payload.matrix.version} rows=${payload.matrix.rows} path=${payload.matrix.path} reviewed=${payload.matrix.lastReviewed} freshness=${payload.matrix.freshnessSource}@${payload.matrix.freshnessAt} age=${payload.matrix.freshnessAgeDays === null ? "unknown" : `${payload.matrix.freshnessAgeDays}d`} staleAfter=${payload.matrix.staleAfterDays}d stale=${payload.matrix.stale === null ? "unknown" : payload.matrix.stale ? "yes" : "no"}${matrixDiagnostics}`
      : payload.matrix.state === "error"
        ? `matrix=${payload.enabled ? "ON" : "OFF"} error=${payload.matrix.diagnostics.map((d) => d.code).join(",")} path=${payload.matrix.path}`
        : `matrix=${payload.enabled ? "ON" : "OFF"} not-loaded`;
  const availability =
    payload.availability.state === "loaded"
      ? `snapshot=g${payload.availability.generation} ${payload.availability.hash} registry=${payload.availability.registryModels} live=${payload.availability.liveModels}`
      : payload.availability.state === "error"
        ? `snapshot=error:${payload.availability.code}`
        : `snapshot=${payload.availability.state}`;
  const coverage = payload.coverage
    ? `intersection=${payload.coverage.intersection} unlisted=${payload.coverage.unlisted} inert=${payload.coverage.inertRows.length}[${formatList(payload.coverage.inertRows)}] dangling=${payload.coverage.danglingRows.length}[${formatList(payload.coverage.danglingRows)}] filtered=${payload.coverage.filteredRows.length}[${formatList(payload.coverage.filteredRows)}] unlistedByProvider=[${formatList(Object.entries(payload.coverage.unlistedByProvider).map(([provider, count]) => `${provider}:${count}`))}]`
    : "coverage=unavailable";
  const filters =
    payload.availability.state === "loaded"
      ? `filters=copilot:${payload.availability.filters.copilot.state},anthropic:${payload.availability.filters.anthropic.state},omlx:${payload.availability.filters.omlx.state}`
      : "";
  const policy =
    `localRole=${payload.policy.localRole} preferLocalOmlx=${payload.policy.preferLocalOmlx ? "on" : "off"} ` +
    `allowlist=${payload.policy.allowlist.length}[${formatList(payload.policy.allowlist)}] ` +
    `providers=${payload.policy.providerAllowlist.length}[${formatList(payload.policy.providerAllowlist)}] ` +
    `unavailable=${payload.policy.unavailable.length}[${formatList(payload.policy.unavailable)}]`;
  const registry = `registryReload=${payload.registryReload}`;
  return [matrix, availability, coverage, filters, policy, registry]
    .filter(Boolean)
    .join("; ");
}
