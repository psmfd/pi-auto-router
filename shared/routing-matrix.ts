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

export interface MatrixEntry {
  /** Task-type labels this model clears the capability bar for. */
  readonly capable: readonly string[];
}

export interface RoutingMatrix {
  readonly v: number;
  readonly lastReviewed: string;
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
 * Load and shape-check the routing matrix. Any failure — missing file,
 * unreadable, malformed JSON, `models` not an object — yields `null`.
 */
export async function loadRoutingMatrix(path?: string): Promise<RoutingMatrix | null> {
  try {
    const raw = await fs.readFile(path ?? defaultMatrixPath(), "utf8");
    const parsed = JSON.parse(raw) as {
      v?: unknown;
      lastReviewed?: unknown;
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
      const capable = (value as { capable?: unknown } | null)?.capable;
      if (!Array.isArray(capable)) continue;
      models[key] = { capable: capable.filter((t): t is string => typeof t === "string") };
    }
    return {
      v: typeof parsed.v === "number" ? parsed.v : 0,
      lastReviewed: typeof parsed.lastReviewed === "string" ? parsed.lastReviewed : "",
      models,
    };
  } catch {
    return null;
  }
}
