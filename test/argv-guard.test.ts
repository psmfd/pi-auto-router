import assert from "node:assert/strict";
import { test } from "node:test";

import { hasExplicitModelFlag } from "../argv-guard.ts";

test("detects the two-token --model form anywhere in argv", () => {
  assert.equal(hasExplicitModelFlag(["node", "pi", "--model", "omlx/coding-workhorse"]), true);
  assert.equal(
    hasExplicitModelFlag(["node", "pi", "--mode", "json", "-p", "--no-session", "--model", "x", "Task: y"]),
    true,
  );
});

test("--models (scoped cycling) never triggers the guard", () => {
  assert.equal(hasExplicitModelFlag(["node", "pi", "--models", "sonnet,haiku"]), false);
});

test("no --model, empty argv, and prompt text containing '--model ' stay unguarded", () => {
  assert.equal(hasExplicitModelFlag(["node", "pi", "-p", "hello"]), false);
  assert.equal(hasExplicitModelFlag([]), false);
  // A prompt that mentions the flag is ONE argv element, not the token itself.
  assert.equal(hasExplicitModelFlag(["node", "pi", "-p", "--model foo"]), false);
});

test("trailing --model with no value is ignored, mirroring pi's parser", () => {
  // pi's cli/args.ts only consumes `--model` when a following token exists.
  assert.equal(hasExplicitModelFlag(["node", "pi", "--model"]), false);
});

test("--model followed by another flag still counts (pi consumes it as the value)", () => {
  assert.equal(hasExplicitModelFlag(["node", "pi", "--model", "--auto"]), true);
});
