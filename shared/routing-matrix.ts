/**
 * shared/routing-matrix.ts — loader for the hand-authored task-type capability
 * floor (`routing-matrix.json`, seeded in #363; consulted by auto-router's
 * matrix routing since #352, ADR-0078).
 *
 * The committed JSON lives next to this module. Loading is strict and
 * diagnosable: malformed policy yields a typed failure, while the legacy
 * `loadRoutingMatrix()` adapter preserves fail-soft `null` semantics for
 * routing callers. Matrix routing therefore still degrades to classifier
 * routing and never breaks a turn, but status/review surfaces can explain why.
 *
 * `capable[]` remains `readonly string[]` in the public matrix shape for
 * compatibility with synthetic callers; the strict loader validates every
 * entry against the shared `MATRIX_TASK_TYPES` source of truth.
 */

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { MATRIX_TASK_TYPES } from "./task-types.ts";

export { MATRIX_TASK_TYPES } from "./task-types.ts";

/**
 * Quality tier of a matrix row (#656, ADR-0094 layer 3 follow-on). Coarse by
 * design — three values review cleanly; numeric scores invite false
 * precision. Rows without a tier participate only in cheapest-capable
 * (untiered) selection.
 */
export type MatrixTier = "frontier" | "capable" | "fast";

export function parseMatrixTier(value: unknown): MatrixTier | undefined {
  return value === "frontier" || value === "capable" || value === "fast" ? value : undefined;
}

/** Current on-disk matrix schema version. */
export const MATRIX_VERSION = 1;

export type MatrixDiagnosticCode =
  | "missing"
  | "unreadable"
  | "invalid-json"
  | "unsupported-version"
  | "invalid-schema"
  | "stale";

export interface MatrixDiagnostic {
  readonly code: MatrixDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  /** Structured row/field context for read-only review proposals. */
  readonly row?: string;
  readonly field?: "capable" | "rationale" | "tier";
}

export type MatrixLoadResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly matrix: RoutingMatrix;
      readonly diagnostics: readonly MatrixDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly matrix: null;
      readonly diagnostics: readonly MatrixDiagnostic[];
    };

export interface MatrixEntry {
  /** Task-type labels this model clears the capability bar for. */
  readonly capable: readonly string[];
  /** Quality tier for tier-requested selection (#656); absent = untiered. */
  readonly tier?: MatrixTier;
  /** Human-reviewed evidence. Strict file loads always retain it; synthetic routing callers may omit it. */
  readonly rationale?: string;
}

/**
 * Audit metadata for the last human-performed matrix refresh (#660). Written
 * ONLY by the human editing the file (the analyze script can print a snippet
 * to paste via --suggest-refresh-metadata, but no code path ever writes this
 * file). Deliberately carries no identity field — authorship belongs to git
 * blame / PR metadata; this block answers "when, with what tool, from what
 * inputs".
 */
export interface RefreshMetadata {
  /** ISO timestamp of the refresh. */
  readonly at: string;
  /** Tool/command that produced the data the refresh was based on. */
  readonly tool: string;
  /** Human-readable description of the inputs (log, turn count, date range). */
  readonly source: string;
  /** Hash of the input data, e.g. "sha256:…" (optional). */
  readonly inputsHash?: string;
}

export interface RoutingMatrix {
  readonly v: number;
  readonly lastReviewed: string;
  /**
   * Staleness threshold in days for the review-age WARN surfaces (#686).
   * The committed matrix is the single source of this value — validate.sh's
   * 9b gate and auto-router's `(stale)` flag both read it from here.
   * Optional only for externally-supplied matrices; consumers fall back
   * to 180.
   */
  readonly staleAfterDays?: number;
  /** Present only when a refresh has recorded its audit block (#660). */
  readonly refresh?: RefreshMetadata;
  /**
   * Key: `provider/id`. Closed-world for matrix picks (ADR-0078): a model
   * absent here is never a matrix pick — though the classifier remains free
   * to choose it, so absence never removes a model from routing entirely.
   */
  readonly models: Readonly<Record<string, MatrixEntry>>;
}

/** Default location of the committed matrix: next to this module. */
export function defaultMatrixPath(): string {
  return fileURLToPath(new URL("routing-matrix.json", import.meta.url));
}

/**
 * Matrix gardening report (#656 follow-through): the tier change made the
 * matrix load-bearing for every agent, so an untended matrix silently
 * degrades selection. This pure comparison feeds the read-only surfaces
 * (`/auto matrix status|review`); nothing here mutates anything.
 */
export interface MatrixGardening {
  /**
   * Rows whose provider IS credentialed/onboarded but whose exact id is not
   * in the live registry — e.g. a vendor retired the id. Actionable: the row
   * can never be picked; fix or remove it. Rows for providers with no
   * credentialed models at all are deliberately NOT flagged (forward-declared
   * rows are inert by design).
   */
  readonly danglingRows: readonly string[];
  /** Count of credentialed models with no matrix row, per provider (informational). */
  readonly unlistedByProvider: Readonly<Record<string, number>>;
}

export function gardenMatrix(
  matrix: RoutingMatrix,
  availableKeys: ReadonlySet<string>,
): MatrixGardening {
  const providers = new Set<string>();
  for (const key of availableKeys) {
    const slash = key.indexOf("/");
    if (slash > 0) providers.add(key.slice(0, slash));
  }
  const danglingRows = Object.keys(matrix.models).filter((k) => {
    const slash = k.indexOf("/");
    if (slash <= 0) return false;
    return providers.has(k.slice(0, slash)) && !availableKeys.has(k);
  });
  const unlistedByProvider: Record<string, number> = {};
  for (const key of availableKeys) {
    if (matrix.models[key]) continue;
    const provider = key.slice(0, key.indexOf("/"));
    unlistedByProvider[provider] = (unlistedByProvider[provider] ?? 0) + 1;
  }
  return { danglingRows, unlistedByProvider };
}

const MODEL_KEY_PATTERN = /^[a-z0-9-]+\/[A-Za-z0-9._/-]+$/;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TASK_TYPE_SET: ReadonlySet<string> = new Set(MATRIX_TASK_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function failure(
  path: string,
  code: Exclude<MatrixDiagnosticCode, "stale">,
  message: string,
  context: Pick<MatrixDiagnostic, "row" | "field"> = {},
): MatrixLoadResult {
  return {
    ok: false,
    path,
    matrix: null,
    diagnostics: [{ code, severity: "error", message, ...context }],
  };
}

function schemaFailure(
  path: string,
  message: string,
  context: Pick<MatrixDiagnostic, "row" | "field"> = {},
): MatrixLoadResult {
  return failure(path, "invalid-schema", message, context);
}

function freshnessAgeDays(value: string, now: Date): number | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 86_400_000));
}

/**
 * Strictly load and validate the routing matrix, preserving typed diagnostics.
 * Staleness is a warning and leaves the matrix usable; structural failures are
 * errors with `matrix: null`. `now` is injectable for deterministic tests.
 */
export async function loadRoutingMatrixResult(
  path = defaultMatrixPath(),
  now = new Date(),
): Promise<MatrixLoadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    return failure(path, code, code === "missing" ? "matrix file is missing" : "matrix file is unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return failure(path, "invalid-json", "matrix file is not valid JSON");
  }

  if (!isRecord(parsed)) return schemaFailure(path, "matrix root must be an object");
  if (parsed.v !== MATRIX_VERSION) {
    return failure(path, "unsupported-version", `matrix version must be ${MATRIX_VERSION}`);
  }
  if (!isValidDateOnly(parsed.lastReviewed)) {
    return schemaFailure(path, "lastReviewed must be a real YYYY-MM-DD date");
  }
  if (Date.parse(`${parsed.lastReviewed}T00:00:00Z`) > now.getTime()) {
    return schemaFailure(path, "lastReviewed must not be in the future");
  }
  if (!Number.isInteger(parsed.staleAfterDays) || (parsed.staleAfterDays as number) <= 0) {
    return schemaFailure(path, "staleAfterDays must be a positive integer");
  }
  if (!isRecord(parsed.models) || Object.keys(parsed.models).length === 0) {
    return schemaFailure(path, "models must be a non-empty object");
  }

  const models: Record<string, MatrixEntry> = {};
  for (const [key, value] of Object.entries(parsed.models).sort(([a], [b]) => a.localeCompare(b))) {
    if (!MODEL_KEY_PATTERN.test(key)) {
      return schemaFailure(path, `model key ${JSON.stringify(key)} must be provider/id`);
    }
    if (!isRecord(value)) return schemaFailure(path, `matrix row ${key} must be an object`);
    const rawCapable = value.capable;
    if (!Array.isArray(rawCapable) || rawCapable.length === 0) {
      return schemaFailure(
        path,
        `matrix row ${key} must have a non-empty capable array`,
        { row: key, field: "capable" },
      );
    }
    if (!rawCapable.every((task) => typeof task === "string" && TASK_TYPE_SET.has(task))) {
      return schemaFailure(
        path,
        `matrix row ${key} contains an unknown task type`,
        { row: key, field: "capable" },
      );
    }
    if (new Set(rawCapable).size !== rawCapable.length) {
      return schemaFailure(
        path,
        `matrix row ${key} contains duplicate task types`,
        { row: key, field: "capable" },
      );
    }
    if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
      return schemaFailure(
        path,
        `matrix row ${key} must have a non-empty rationale`,
        { row: key, field: "rationale" },
      );
    }
    const tier = value.tier === undefined ? undefined : parseMatrixTier(value.tier);
    if (value.tier !== undefined && tier === undefined) {
      return schemaFailure(
        path,
        `matrix row ${key} has an invalid tier`,
        { row: key, field: "tier" },
      );
    }
    const capable = MATRIX_TASK_TYPES.filter((task) => rawCapable.includes(task));
    models[key] = {
      capable,
      ...(tier ? { tier } : {}),
      rationale: value.rationale,
    };
  }

  let refresh: RefreshMetadata | undefined;
  if (parsed.refresh !== undefined) {
    if (!isRecord(parsed.refresh)) return schemaFailure(path, "refresh must be an object");
    const { at, tool, source, inputsHash } = parsed.refresh;
    if (
      typeof at !== "string" ||
      !ISO_UTC_TIMESTAMP_PATTERN.test(at) ||
      !Number.isFinite(Date.parse(at))
    ) {
      return schemaFailure(path, "refresh.at must be an ISO 8601 UTC timestamp");
    }
    if (Date.parse(at) > now.getTime()) {
      return schemaFailure(path, "refresh.at must not be in the future");
    }
    if (typeof tool !== "string" || tool.trim().length === 0) {
      return schemaFailure(path, "refresh.tool must be a non-empty string");
    }
    if (typeof source !== "string" || source.trim().length === 0) {
      return schemaFailure(path, "refresh.source must be a non-empty string");
    }
    if (inputsHash !== undefined && (typeof inputsHash !== "string" || inputsHash.trim().length === 0)) {
      return schemaFailure(path, "refresh.inputsHash must be a non-empty string when present");
    }
    refresh = { at, tool, source, ...(typeof inputsHash === "string" ? { inputsHash } : {}) };
  }

  const staleAfterDays = parsed.staleAfterDays as number;
  const matrix: RoutingMatrix = {
    v: MATRIX_VERSION,
    lastReviewed: parsed.lastReviewed,
    staleAfterDays,
    ...(refresh ? { refresh } : {}),
    models,
  };
  const freshness = refresh?.at ?? matrix.lastReviewed;
  const age = freshnessAgeDays(freshness, now);
  const diagnostics: MatrixDiagnostic[] = [];
  if (age !== null && age > staleAfterDays) {
    diagnostics.push({
      code: "stale",
      severity: "warning",
      message: `matrix freshness is ${age} days old (threshold ${matrix.staleAfterDays} days)`,
    });
  }
  return { ok: true, path, matrix, diagnostics };
}

/** Fail-soft compatibility adapter used by routing paths that need only policy. */
export async function loadRoutingMatrix(path?: string): Promise<RoutingMatrix | null> {
  return (await loadRoutingMatrixResult(path)).matrix;
}
