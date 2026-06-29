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

test("DecisionCache stores, updates, and reports size", () => {
  const c = new DecisionCache(3);
  c.set("a", "anthropic/opus");
  assert.equal(c.get("a"), "anthropic/opus");
  c.set("a", "anthropic/haiku");
  assert.equal(c.get("a"), "anthropic/haiku");
  assert.equal(c.size, 1);
  assert.equal(c.get("missing"), undefined);
});

test("DecisionCache evicts oldest entries past maxSize", () => {
  const c = new DecisionCache(2);
  c.set("a", "1");
  c.set("b", "2");
  c.set("c", "3"); // evicts "a"
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), "2");
  assert.equal(c.get("c"), "3");
  assert.equal(c.size, 2);
});

test("re-setting a key refreshes its recency", () => {
  const c = new DecisionCache(2);
  c.set("a", "1");
  c.set("b", "2");
  c.set("a", "1b"); // "a" now newest
  c.set("c", "3"); // evicts "b", not "a"
  assert.equal(c.get("a"), "1b");
  assert.equal(c.get("b"), undefined);
});

test("load returns DEFAULT_STATE when nothing is persisted", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  assert.deepEqual(await load(dir), DEFAULT_STATE);
});

test("save then load round-trips router state", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "auto-router-state-"));
  const value = { enabled: true, classifierModel: "anthropic/haiku", allowlist: ["anthropic/opus"] };
  await save(value, dir);
  assert.deepEqual(await load(dir), value);
});
