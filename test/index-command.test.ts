import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { clearAvailabilitySnapshot } from "../shared/availability-snapshot.ts";
import { clearAnthropicCache } from "../shared/anthropic-discovery.ts";
import { clearCopilotCache } from "../shared/copilot-discovery.ts";
import { clearOmlxCache } from "../shared/omlx-discovery.ts";
import {
  clearSessionUnavailable,
  markSessionUnavailable,
} from "../shared/session-unavailable.ts";
import autoRouter, { AUTO_COMMAND_DESCRIPTION } from "../index.ts";

type CommandHandler = (args: string | undefined, ctx: ExtensionContext) => Promise<void>;

interface HarnessModel {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function harness(models: readonly HarnessModel[] = []): {
  handler: CommandHandler;
  ctx: ExtensionContext;
  notices: string[];
  authCalls: { value: number };
  registryReads: { value: number };
} {
  let handler: CommandHandler | undefined;
  const notices: string[] = [];
  const authCalls = { value: 0 };
  const registryReads = { value: 0 };
  const pi = {
    registerFlag: () => undefined,
    on: () => undefined,
    getFlag: () => false,
    setModel: () => Promise.resolve(true),
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      if (name === "auto") handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  autoRouter(pi);
  assert.ok(handler, "auto command was not registered");

  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => void notices.push(message) },
    model: undefined,
    getContextUsage: () => undefined,
    modelRegistry: {
      getAvailable: () => {
        registryReads.value += 1;
        return models;
      },
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getApiKeyAndHeaders: () => {
        authCalls.value += 1;
        return { ok: false };
      },
    },
  } as unknown as ExtensionContext;
  return { handler, ctx, notices, authCalls, registryReads };
}

beforeEach(() => {
  clearAvailabilitySnapshot();
  clearCopilotCache();
  clearAnthropicCache();
  clearOmlxCache();
  clearSessionUnavailable();
});

test("command description matches the supported lifecycle and policy grammar", () => {
  assert.doesNotMatch(AUTO_COMMAND_DESCRIPTION, /\btoggle\b/);
  assert.match(AUTO_COMMAND_DESCRIPTION, /settings \[status\]/);
  assert.match(AUTO_COMMAND_DESCRIPTION, /matrix \[status \[--json\]\|review \[--json\]\|refresh \[--retry-unavailable\]/);
  assert.match(AUTO_COMMAND_DESCRIPTION, /lock \[status\|current\|set provider\/id\|clear\]/);
  assert.match(AUTO_COMMAND_DESCRIPTION, /\(primary\|orchestrator\) \[/);
  assert.match(AUTO_COMMAND_DESCRIPTION, /providers \[status\|clear\|set provider\.\.\.\|add provider\.\.\.\|remove provider\.\.\.\]/);
});

test("status, review, and refresh share then replace one frozen generation", async () => {
  const model: HarnessModel = {
    provider: "openai-codex",
    id: "fixture",
    contextWindow: 128_000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  const { handler, ctx, notices, authCalls, registryReads } = harness([model]);

  await handler("matrix status --json", ctx);
  const status = JSON.parse(notices.at(-1) ?? "") as {
    availability: { state: string; generation: number; hash: string };
  };
  assert.equal(status.availability.state, "loaded");
  assert.equal(registryReads.value, 1);

  await handler("matrix review --json", ctx);
  const review = JSON.parse(notices.at(-1) ?? "") as {
    availability: { state: string; generation: number; hash: string };
  };
  assert.equal(review.availability.generation, status.availability.generation);
  assert.equal(review.availability.hash, status.availability.hash);
  assert.equal(registryReads.value, 1, "review must reuse and never rebuild the snapshot");
  assert.equal(authCalls.value, 0);

  await handler("matrix refresh", ctx);
  assert.equal(registryReads.value, 2);
  await handler("matrix review --json", ctx);
  const refreshed = JSON.parse(notices.at(-1) ?? "") as {
    availability: { generation: number; hash: string };
  };
  assert.ok(refreshed.availability.generation > review.availability.generation);
  assert.equal(refreshed.availability.hash, review.availability.hash);
  assert.equal(registryReads.value, 2);
});

test("matrix refresh and JSON status are user-invokable through the registered command", async () => {
  const { handler, ctx, notices } = harness();
  await handler("matrix refresh", ctx);
  assert.match(notices.at(-1) ?? "", /matrix refresh/);
  assert.match(notices.at(-1) ?? "", /session-unavailable set preserved/);
  assert.match(notices.at(-1) ?? "", /open \/model before refresh/);

  await handler("matrix status --json", ctx);
  const parsed = JSON.parse(notices.at(-1) ?? "") as {
    v: number;
    matrix: { state: string };
    availability: { state: string; generation: number };
  };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.matrix.state, "loaded");
  assert.equal(parsed.availability.state, "loaded");
  assert.equal(typeof parsed.availability.generation, "number");
});

test("matrix review does not initiate credential resolution when no snapshot exists", async () => {
  const { handler, ctx, notices, authCalls } = harness();
  await handler("matrix review --json", ctx);
  const parsed = JSON.parse(notices.at(-1) ?? "") as {
    availability: { state: string };
  };
  assert.equal(parsed.availability.state, "not-built");
  assert.equal(authCalls.value, 0);
});

test("matrix review is user-invokable as stable JSON and has no apply mode", async () => {
  const { handler, ctx, notices } = harness();
  await handler("matrix refresh", ctx);
  await handler("matrix review --json", ctx);
  const parsed = JSON.parse(notices.at(-1) ?? "") as {
    v: number;
    kind: string;
    evidenceHash: string;
    policyNotice: string;
  };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.kind, "routing-matrix-review");
  assert.match(parsed.evidenceHash, /^sha256:/);
  assert.match(parsed.policyNotice, /never writes or grants capability policy/);

  await handler("matrix review --apply", ctx);
  assert.equal(notices.at(-1), "auto-router: use /auto matrix review [--json]");
  await handler("matrix review --json extra", ctx);
  assert.equal(notices.at(-1), "auto-router: use /auto matrix review [--json]");
});

test("status observes child-written shared deny state and refresh clears it only explicitly", async () => {
  const { handler, ctx, notices } = harness();
  markSessionUnavailable("github-copilot/quota-dead");

  await handler("matrix status --json", ctx);
  let parsed = JSON.parse(notices.at(-1) ?? "") as { policy: { unavailable: string[] } };
  assert.deepEqual(parsed.policy.unavailable, ["github-copilot/quota-dead"]);

  await handler("matrix refresh", ctx);
  await handler("matrix status --json", ctx);
  parsed = JSON.parse(notices.at(-1) ?? "") as { policy: { unavailable: string[] } };
  assert.deepEqual(parsed.policy.unavailable, ["github-copilot/quota-dead"]);

  await handler("matrix refresh --retry-unavailable", ctx);
  await handler("matrix status --json", ctx);
  parsed = JSON.parse(notices.at(-1) ?? "") as { policy: { unavailable: string[] } };
  assert.deepEqual(parsed.policy.unavailable, []);
});

test("retry-unavailable is explicit and extra command arguments are refused", async () => {
  const { handler, ctx, notices } = harness();
  await handler("matrix refresh --retry-unavailable", ctx);
  assert.match(notices.at(-1) ?? "", /session-unavailable set cleared/);

  await handler("matrix status --json extra", ctx);
  assert.equal(notices.at(-1), "auto-router: use /auto matrix status [--json]");
  await handler("matrix refresh --retry-unavailable extra", ctx);
  assert.equal(notices.at(-1), "auto-router: use /auto matrix refresh [--retry-unavailable]");
});
