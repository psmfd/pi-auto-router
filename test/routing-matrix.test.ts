import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { TASK_TYPES } from "../types.ts";

// Schema sanity for the hand-authored capability floor (#363, consumed by
// #352). The file lives in shared/ (it will be read by shared's
// resolveByTaskType in #352), but the taxonomy source of truth is
// auto-router/types.ts — extensions import from shared, never the reverse, so
// the membership check lives here.
const MATRIX_URL = new URL("../../shared/routing-matrix.json", import.meta.url);

interface MatrixRow {
  readonly capable: readonly string[];
  readonly rationale: string;
}
interface Matrix {
  readonly v: number;
  readonly lastReviewed: string;
  readonly models: Readonly<Record<string, MatrixRow>>;
}

async function loadMatrix(): Promise<Matrix> {
  return JSON.parse(await readFile(MATRIX_URL, "utf8")) as Matrix;
}

test("routing-matrix.json parses with the v1 shape", async () => {
  const m = await loadMatrix();
  assert.equal(m.v, 1);
  assert.match(m.lastReviewed, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.keys(m.models).length >= 1);
});

test("every capable entry is a member of the closed task-type taxonomy", async () => {
  const m = await loadMatrix();
  for (const [key, row] of Object.entries(m.models)) {
    assert.match(key, /^[^/]+\/.+$/, `model key "${key}" must be provider/id`);
    assert.ok(row.capable.length > 0, `${key} has an empty capable set`);
    assert.ok(row.rationale.length > 0, `${key} is missing a rationale`);
    for (const t of row.capable) {
      assert.ok(
        (TASK_TYPES as readonly string[]).includes(t),
        `${key} capable entry "${t}" is not in TASK_TYPES`,
      );
    }
    // "unknown" is the degradation bucket, never a capability.
    assert.ok(!row.capable.includes("unknown"), `${key} must not claim "unknown"`);
  }
});

test("the omlx workhorse seed row gates long-context and creative to the frontier (#363)", async () => {
  const m = await loadMatrix();
  const row = m.models["omlx/coding-workhorse"];
  assert.ok(row, "omlx/coding-workhorse seed row missing");
  assert.deepEqual([...row.capable].sort(), ["agentic-loop", "code-edit", "code-review", "simple-qa"]);
  assert.ok(!row.capable.includes("long-context"));
  assert.ok(!row.capable.includes("creative"));
});
