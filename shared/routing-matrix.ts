/**
 * shared/routing-matrix.ts — loader for the hand-authored task-type capability
 * floor (`routing-matrix.json`, seeded in #363; consulted by auto-router's
 * matrix routing since #352, ADR-0078).
 *
 * Same conventions as token-meter's `loadTierMap`: the committed JSON lives
 * next to this module and loading is fail-soft. Unlike the tier map, failure
 * yields `null` — NOT an empty object — because "absent" must be
 * distinguishable from "present but empty": `null` is exactly the signal
 * `resolveByTaskType` treats as "matrix unavailable → the classifier's pick
 * stands". Matrix routing degrades to classifier routing; it never breaks a
 * turn. Malformed individual rows are dropped, keeping the rest of the file
 * usable (mirrors loadTierMap's per-entry filtering).
 *
 * `capable[]` stays `readonly string[]` here rather than the TaskType union:
 * extensions import from shared, never the reverse, so this module cannot see
 * auto-router's taxonomy. Consumers match entries against their own TaskType.
 */

import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

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

export interface MatrixEntry {
  /** Task-type labels this model clears the capability bar for. */
  readonly capable: readonly string[];
  /** Quality tier for tier-requested selection (#656); absent = untiered. */
  readonly tier?: MatrixTier;
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

/**
 * Load and shape-check the routing matrix. Any failure — missing file,
 * unreadable, malformed JSON, `models` not an object — yields `null`.
 */
export async function loadRoutingMatrix(path?: string): Promise<RoutingMatrix | null> {
  try {
    const raw = await fs.readFile(path ?? defaultMatrixPath(), "utf8");
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      lastReviewed?: unknown;
      refresh?: unknown;
      models?: unknown;
    } | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof parsed.models !== "object" ||
      parsed.models === null ||
      Array.isArray(parsed.models)
    ) {
      return null;
    }
    const models: Record<string, MatrixEntry> = {};
    for (const [key, value] of Object.entries(parsed.models)) {
      const row = value as { capable?: unknown; tier?: unknown } | null;
      const capable = row?.capable;
      if (!Array.isArray(capable)) continue;
      const tier = parseMatrixTier(row?.tier);
      models[key] = {
        capable: capable.filter((t): t is string => typeof t === "string"),
        ...(tier ? { tier } : {}),
      };
    }
    // #660: the refresh audit block is optional and fail-soft — a malformed
    // block is dropped (matrix still loads) rather than failing the file.
    let refresh: RefreshMetadata | undefined;
    const rawRefresh = parsed.refresh as
      | { at?: unknown; tool?: unknown; source?: unknown; inputsHash?: unknown }
      | null
      | undefined;
    if (
      rawRefresh !== null &&
      typeof rawRefresh === "object" &&
      typeof rawRefresh.at === "string" &&
      typeof rawRefresh.tool === "string" &&
      typeof rawRefresh.source === "string"
    ) {
      refresh = {
        at: rawRefresh.at,
        tool: rawRefresh.tool,
        source: rawRefresh.source,
        ...(typeof rawRefresh.inputsHash === "string" ? { inputsHash: rawRefresh.inputsHash } : {}),
      };
    }

    return {
      v: typeof parsed.v === "number" ? parsed.v : 0,
      lastReviewed: typeof parsed.lastReviewed === "string" ? parsed.lastReviewed : "",
      ...(refresh ? { refresh } : {}),
      models,
    };
  } catch {
    return null;
  }
}
