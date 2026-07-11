import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DecisionCache, DEFAULT_STATE, hashPrompt, load, save } from "../state.ts";

test("hashPrompt is deterministic and varies by input", () => {
  assert.equal(hashPrompt("hello"), hashPrompt("hello"));
  assert.notEqual(hashPrompt("hello"), hashPrompt("world"));
  assert.match(hashPrompt("anything"), /^[0-9a-f]+$/);
});

// Decision values carry the task-type label alongside the target (#351).
const d = (target: string, taskType: "unknown" | "code-edit" = "unknown") => ({ target, taskType, source: "classifier" as const });

test("DecisionCache stores, updates, and reports size", () => {
  const c = new DecisionCache(3);
  c.set("a", d("anthropic/opus"));
  assert.deepEqual(c.get("a"), d("anthropic/opus"));
  c.set("a", d("anthropic/haiku", "code-edit"));
  assert.deepEqual(c.get("a"), d("anthropic/haiku", "code-edit"));
  assert.equal(c.size, 1);
  assert.equal(c.get("missing"), undefined);
});

test("DecisionCache evicts oldest entries past maxSize", () => {
  const c = new DecisionCache(2);
  c.set("a", d("1"));
  c.set("b", d("2"));
  c.set("c", d("3")); // evicts "a"
  assert.equal(c.get("a"), undefined);
  assert.deepEqual(c.get("b"), d("2"));
  assert.deepEqual(c.get("c"), d("3"));
  assert.equal(c.size, 2);
});

test("re-setting a key refreshes its recency", () => {
  const c = new DecisionCache(2);
  c.set("a", d("1"));
  c.set("b", d("2"));
  c.set("a", d("1b")); // "a" now newest
  c.set("c", d("3")); // evicts "b", not "a"
  assert.deepEqual(c.get("a"), d("1b"));
  assert.equal(c.get("b"), undefined);
});

test("load returns DEFAULT_STATE when nothing is persisted", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  assert.deepEqual(await load(dir), DEFAULT_STATE);
});

test("save then load round-trips router state", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  const value = {
    enabled: true,
    classifierModel: "anthropic/haiku",
    orchestratorModelLock: "github-copilot/gpt-5-mini",
    allowlist: ["anthropic/opus"],
    orchestratorAllowedProviders: ["github-copilot"],
    matrixEnabled: true,
  };
  await save(value, dir);
  assert.deepEqual(await load(dir), value);
});

test("matrix routing is on by default (#353, ADR-0079)", () => {
  assert.equal(DEFAULT_STATE.matrixEnabled, true);
});

test("a state.json lacking newer fields gets the current defaults via merge (ADR-0079)", async () => {
  // load() spreads the persisted file over DEFAULT_STATE, so an absent key
  // means "defer to whatever the code currently ships as default" — without
  // the merge, the #353 default flip and later primary-provider default would
  // only ever reach fresh installs.
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  const old = { enabled: true, classifierModel: null, allowlist: [] };
  await save(old as unknown as Parameters<typeof save>[0], dir);
  const loaded = await load(dir);
  assert.equal(loaded.matrixEnabled, true);
  assert.deepEqual(loaded.orchestratorAllowedProviders, []);
  assert.equal(loaded.orchestratorModelLock, null);
  assert.equal(loaded.enabled, true); // keys the file carries win over defaults
});

test("an explicitly persisted matrixEnabled false survives the default-merge", async () => {
  // A real `/auto matrix off` opt-out must not be overridden by the default.
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  await save({ ...DEFAULT_STATE, matrixEnabled: false }, dir);
  const loaded = await load(dir);
  assert.equal(loaded.matrixEnabled, false);
});

test("DecisionCache.clear drops every entry (#352 matrix-toggle invalidation)", () => {
  const c = new DecisionCache(3);
  c.set("a", d("1"));
  c.set("b", d("2"));
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), undefined);
});
