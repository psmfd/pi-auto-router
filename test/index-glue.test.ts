/**
 * index.ts glue tests (#791) — the command/lifecycle wiring route.test.ts and
 * policy.test.ts deliberately do not cover: the `/auto` command families
 * beyond `matrix`, the ADR-0094 lock write-site refusals, the point-of-use
 * lock bypass notify, and the model_select capture rules.
 *
 * The harness captures BOTH registerCommand handlers and pi.on registrations
 * (index-command.test.ts's harness discards the latter), and every test runs
 * under a temp $HOME so state.save/readLocalRole never touch the operator's
 * live ~/.pi (os.homedir() reads $HOME at call time).
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { clearAvailabilitySnapshot } from "../shared/availability-snapshot.ts";
import { clearAnthropicCache } from "../shared/anthropic-discovery.ts";
import { clearCopilotCache } from "../shared/copilot-discovery.ts";
import { clearOmlxCache } from "../shared/omlx-discovery.ts";
import autoRouter from "../index.ts";

type CommandHandler = (args: string | undefined, ctx: ExtensionContext) => Promise<void>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

interface HarnessModel {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow: number;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

function model(provider: string, id: string): HarnessModel {
  return { provider, id, contextWindow: 128_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
}

function harness(models: readonly HarnessModel[] = []): {
  handler: CommandHandler;
  events: Map<string, EventHandler>;
  ctx: ExtensionContext & { model: unknown };
  notices: string[];
} {
  let handler: CommandHandler | undefined;
  const events = new Map<string, EventHandler>();
  const notices: string[] = [];
  const pi = {
    registerFlag: () => undefined,
    on: (name: string, fn: EventHandler) => void events.set(name, fn),
    getFlag: () => false,
    setModel: () => Promise.resolve(true),
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      if (name === "auto") handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  autoRouter(pi);
  assert.ok(handler, "auto command was not registered");
  assert.ok(events.has("session_start"), "session_start was not registered");
  assert.ok(events.has("before_agent_start"), "before_agent_start was not registered");
  assert.ok(events.has("model_select"), "model_select was not registered");

  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => void notices.push(message), setStatus: () => undefined },
    model: undefined as unknown,
    getContextUsage: () => undefined,
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((m) => m.provider === provider && m.id === id),
      getApiKeyAndHeaders: () => ({ ok: false }),
    },
  } as unknown as ExtensionContext & { model: unknown };
  return { handler, events, ctx, notices };
}

/** Run fn under a temp $HOME (with optional localLlm.role written), restoring after. */
async function withTempHome(
  role: string | null,
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "auto-router-glue-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    if (role !== null) await writeRole(home, role);
    await fn(home);
  } finally {
    process.env.HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeRole(home: string, role: string): Promise<void> {
  const dir = path.join(home, ".pi", "agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify({ extensionSettings: { localLlm: { role } } }),
  );
}

beforeEach(() => {
  clearAvailabilitySnapshot();
  clearCopilotCache();
  clearAnthropicCache();
  clearOmlxCache();
});

test("/auto primary: unknown subcommand warns instead of printing status", async () => {
  await withTempHome(null, async () => {
    const { handler, events, ctx, notices } = harness();
    await events.get("session_start")!({}, ctx);
    await handler("primary bogus", ctx);
    assert.equal(notices.at(-1), "auto-router: unknown primary action");
    // The valid default still prints status.
    await handler("primary", ctx);
    assert.match(notices.at(-1) ?? "", /primary providers=all/);
  });
});

test("/auto on captures the current model as the lock under role=full", async () => {
  await withTempHome("full", async () => {
    const { handler, events, ctx, notices } = harness([model("anthropic", "big")]);
    await events.get("session_start")!({}, ctx);
    (ctx as { model: unknown }).model = model("anthropic", "big");
    await handler("on", ctx);
    assert.match(notices.at(-1) ?? "", /ON/);
    await handler("lock status", ctx);
    assert.match(notices.at(-1) ?? "", /orchestratorModelLock=anthropic\/big/);
    await handler("off", ctx);
    assert.match(notices.at(-1) ?? "", /OFF/);
  });
});

test("ADR-0094 write-site refusals: lock current/set and /auto on skip local under a restricted lever", async () => {
  await withTempHome("classifier-only", async () => {
    const { handler, events, ctx, notices } = harness([model("omlx", "work")]);
    await events.get("session_start")!({}, ctx);
    (ctx as { model: unknown }).model = model("omlx", "work");

    await handler("lock current", ctx);
    assert.match(notices.at(-1) ?? "", /refusing to lock omlx\/work/);
    await handler("lock set omlx/work", ctx);
    assert.match(notices.at(-1) ?? "", /refusing to lock omlx\/work/);

    await handler("on", ctx);
    assert.ok(
      notices.some((n) => n.includes("not captured as the lock (localLlm.role=classifier-only)")),
      notices.join("\n"),
    );
    await handler("lock status", ctx);
    assert.match(notices.at(-1) ?? "", /orchestratorModelLock=none/);
  });
});

test("model_select capture: non-local captured, local honored-but-not-captured under restricted lever", async () => {
  await withTempHome("classifier-only", async () => {
    const { handler, events, ctx, notices } = harness([
      model("anthropic", "big"),
      model("omlx", "work"),
    ]);
    await events.get("session_start")!({}, ctx);
    ctx.model = undefined; // enable without capturing
    await handler("on", ctx);

    await events.get("model_select")!({ model: model("omlx", "work") }, ctx);
    assert.ok(
      notices.some((n) => n.includes("omlx/work honored for this session but not captured")),
      notices.join("\n"),
    );
    await handler("lock status", ctx);
    assert.match(notices.at(-1) ?? "", /orchestratorModelLock=none/);

    await events.get("model_select")!({ model: model("anthropic", "big") }, ctx);
    await handler("lock status", ctx);
    assert.match(notices.at(-1) ?? "", /orchestratorModelLock=anthropic\/big/);
  });
});

test("point-of-use bypass: a persisted local lock is not applied under a restricted lever, with one notice", async () => {
  await withTempHome("full", async (home) => {
    const { handler, events, ctx, notices } = harness([model("omlx", "work")]);
    await events.get("session_start")!({}, ctx);
    ctx.model = undefined;
    await handler("on", ctx); // enable, no capture
    await handler("lock set omlx/work", ctx); // legal under role=full
    assert.match(notices.at(-1) ?? "", /orchestratorModelLock=omlx\/work/);

    // Lever restricted after the lock was persisted (the ADR-0094 scenario).
    await writeRole(home, "classifier-only");
    await events.get("session_start")!({}, ctx); // re-reads lever + persisted cfg
    await events.get("before_agent_start")!({ prompt: "do a thing" }, ctx);
    const bypass = notices.filter((n) => n.includes("not applied — localLlm.role=classifier-only"));
    assert.equal(bypass.length, 1, notices.join("\n"));

    // One notice per session: a second turn must not re-toast.
    await events.get("before_agent_start")!({ prompt: "again" }, ctx);
    assert.equal(
      notices.filter((n) => n.includes("not applied — localLlm.role=classifier-only")).length,
      1,
    );
  });
});
