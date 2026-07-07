/**
 * auto-router — per-prompt model selection for pi.
 *
 * On `before_agent_start` (when enabled), a cheap classifier model picks the
 * best credentialed model for the user's prompt and `pi.setModel()` applies it
 * before the first provider request. Routing never blocks a turn: any failure
 * falls back to the current model. `/auto [on|off|status]` and `--auto` control
 * it; state persists across sessions via shared/state.
 *
 * Verified against pi v0.79.0 (Phase 0 #328): event lifecycle, `pi.setModel`,
 * `ctx.modelRegistry.{getAvailable,getApiKeyAndHeaders,find}`, and pi-ai
 * `complete()`. See ADR-0031.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadRoutingMatrix, type RoutingMatrix } from "./shared/routing-matrix.ts";
import { clearAnthropicCache } from "./anthropic-discovery.ts";
import { hasExplicitModelFlag } from "./argv-guard.ts";
import { clearCopilotCache } from "./shared/copilot-discovery.ts";
import { clearOmlxCache } from "./shared/omlx-discovery.ts";
import { appendTaskRecord, buildTaskRecord, type AssistantMessageLike } from "./recorder.ts";
import { route, type RouteContext, type RouteOutcome, type RoutePi } from "./route.ts";
import * as state from "./state.ts";
import type { PickSource, TaskType } from "./types.ts";

/** Persistent status-bar segment showing the model currently in use. */
function showModel(ctx: ExtensionContext, provider: string, id: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("auto-router", `🤖 ${provider}/${id}`);
}

/**
 * Surface every routing outcome so a live session is never silent: refresh the
 * status bar to the model now in use, and toast what happened (including the
 * classifier's reason on a successful route, and the cause on every fallback).
 */
function feedback(ctx: ExtensionContext, outcome: RouteOutcome): void {
  if (ctx.model) showModel(ctx, ctx.model.provider, ctx.model.id);
  if (!ctx.hasUI) return;
  switch (outcome.kind) {
    case "routed":
      ctx.ui.notify(
        `auto-router: routed → ${outcome.target} [${outcome.source}]${outcome.cached ? " (cached)" : ""}` +
          `${outcome.reason ? ` — ${outcome.reason}` : ""}`,
        "info",
      );
      break;
    case "no-credential":
      ctx.ui.notify(`auto-router: no credential for ${outcome.target}; kept current`, "warning");
      break;
    case "no-candidates": {
      let msg: string;
      if (outcome.reason === "all-unavailable") {
        msg =
          "auto-router: all candidate models are currently unavailable (rate-limited / quota). " +
          "Routing paused — use /model to pick one, or wait for the quota to reset.";
      } else if (outcome.reason === "copilot-filtered") {
        msg =
          "auto-router: all available Copilot models are gated by your subscription tier " +
          "(not picker-enabled). Routing paused — use /model to pick one, or check your Copilot plan.";
      } else {
        msg = "auto-router: no credentialed models to route. Configure a provider, or use /model.";
      }
      ctx.ui.notify(msg, "warning");
      break;
    }
    case "provider-restriction-empty":
      ctx.ui.notify(
        `auto-router: primary provider restriction (${outcome.providers.join(", ")}) left no credentialed candidates; kept current`,
        "warning",
      );
      break;
    case "classify-failed": {
      const atts = outcome.attempts;
      const allRateLimited = atts.length > 0 && atts.every((a) => a.detail === "rate-limited");
      ctx.ui.notify(
        allRateLimited
          ? `auto-router: all ${atts.length} candidate model(s) are rate-limited / quota-exhausted (429). ` +
              "Routing paused — use /model to pick a model, or wait for the quota to reset."
          : "auto-router: classifier returned no choice; kept current" +
              (atts.length ? ` (tried ${atts.map((a) => `${a.model}=${a.detail ?? a.status}`).join(", ")})` : ""),
        "warning",
      );
      break;
    }
    case "unresolved":
      ctx.ui.notify(`auto-router: choice "${outcome.choice}" unavailable; kept current`, "warning");
      break;
    case "no-registry-model":
      ctx.ui.notify(`auto-router: ${outcome.target} not in registry; kept current`, "warning");
      break;
  }
}

function normalizeProviders(values: readonly string[]): string[] {
  const providers = values
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0 && !/[\s/]/.test(p));
  return [...new Set(providers)].sort();
}

function hasRejectedProviders(values: readonly string[]): boolean {
  return values.some((p) => {
    const trimmed = p.trim().toLowerCase();
    return trimmed.length === 0 || /[\s/]/.test(trimmed);
  });
}

function formatProviders(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(",") : "all";
}

/**
 * Read the USER-layer `extensionSettings.autoRouter.preferLocalOmlx` override
 * (ADR-0084). Project-layer settings are deliberately not consulted — same
 * trust boundary as token-meter (ADR-0073) and the subagent Copilot fallback
 * (ADR-0080): a hostile repo must not be able to redirect parent-session
 * classifier traffic. Any read/parse error or non-boolean value falls back
 * to the built-in default (`true` — local-first).
 */
async function readPreferLocalOmlxSetting(): Promise<boolean> {
  try {
    const p = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const j = JSON.parse(await fs.promises.readFile(p, "utf8")) as {
      extensionSettings?: { autoRouter?: { preferLocalOmlx?: unknown } };
    };
    const v = j?.extensionSettings?.autoRouter?.preferLocalOmlx;
    // Strict boolean only — reject truthy strings/numbers so accidental
    // `"true"` or `1` cannot silently pass. Default to true on any mismatch.
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

export default function autoRouter(pi: ExtensionAPI): void {
  let cfg: state.RouterState = state.DEFAULT_STATE;
  const cache = new state.DecisionCache();
  // The hand-authored capability floor (#352, ADR-0078): loaded per session,
  // null when missing/malformed (matrix routing degrades to classifier picks).
  let matrix: RoutingMatrix | null = null;
  // `provider/id`s that returned a provider error (e.g. 429) this session — skipped
  // as both classifier and routing targets until the next session.
  const unavailable = new Set<string>();
  // #351 measurement pipeline: the routed prompt's task-type label (plus the
  // #352 matrix/classifier source), STICKY across every assistant
  // `message_end` until the next routing attempt — an agentic turn produces
  // many assistant messages, and labeling only the first would understate
  // exactly the task types the #352 matrix must cost honestly. Any non-routed
  // turn (routing off, fallback outcome, route error) clears the label so
  // unrouted usage is never misattributed.
  let pendingLabel: { readonly taskType: TaskType; readonly source: PickSource } | null = null;
  let turn = 0;
  // ADR-0084: user-layer preference for local-first classifier ordering.
  // Read once on session_start and passed to route() via RouteDeps.preferOmlx.
  // Default true; overridden by ~/.pi/agent/settings.json only.
  let preferLocalOmlx = true;
  // #519 precedence guard: an explicit argv --model wins over routing for the
  // whole process lifetime (argv never changes). Computed once; the notify is
  // one-time so an agentic session is not toasted every turn.
  const explicitModel = hasExplicitModelFlag();
  let explicitModelNotified = false;

  pi.registerFlag("auto", {
    description: "Enable per-prompt auto model routing for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = await state.load();
    matrix = await loadRoutingMatrix(); // per-session reload: edits apply next session (#352)
    unavailable.clear(); // give quota-recovered models a fresh chance each session
    clearCopilotCache(); // re-discover live Copilot availability each session
    clearAnthropicCache(); // re-discover live Anthropic availability each session (#538)
    clearOmlxCache(); // re-probe local oMLX availability each session (#364)
    pendingLabel = null;
    turn = 0;
    preferLocalOmlx = await readPreferLocalOmlxSetting();
    if (ctx.model) showModel(ctx, ctx.model.provider, ctx.model.id);
  });

  pi.registerCommand("auto", {
    description: "Auto model routing: /auto [on|off|status|matrix on|matrix off|primary copilot|primary clear]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (parts[0] === "matrix") {
        // #352 (ADR-0078): toggle the deterministic capability-matrix override.
        const sub = parts[1];
        if (sub === "on" || sub === "off") {
          cfg = { ...cfg, matrixEnabled: sub === "on" };
          await state.save(cfg);
          // A prompt hash carries no dependency on the flag — decisions cached
          // under the other mode would replay stale picks. Drop them all.
          cache.clear();
        }
        ctx.ui.notify(
          `auto-router: matrix ${cfg.matrixEnabled ? "ON" : "OFF"}` +
            (matrix ? "" : " (routing-matrix.json not loaded — classifier picks apply)"),
          "info",
        );
        return;
      }
      if (parts[0] === "primary" || parts[0] === "orchestrator") {
        const sub = parts[1] ?? "status";
        if (sub === "copilot") {
          cfg = { ...cfg, orchestratorAllowedProviders: ["github-copilot"] };
          await state.save(cfg);
          cache.clear();
        } else if (sub === "clear") {
          cfg = { ...cfg, orchestratorAllowedProviders: [] };
          await state.save(cfg);
          cache.clear();
        } else if (sub === "providers") {
          const action = parts[2] ?? "status";
          const providerArgs = parts.slice(3);
          if ((action === "set" || action === "add" || action === "remove") && providerArgs.length === 0) {
            ctx.ui.notify(
              "auto-router: no providers supplied; use /auto primary clear to remove the restriction",
              "warning",
            );
            return;
          }
          if ((action === "set" || action === "add" || action === "remove") && hasRejectedProviders(providerArgs)) {
            ctx.ui.notify(
              "auto-router: provider names only (for example github-copilot); use allowlist for provider/id entries",
              "warning",
            );
            return;
          }
          if (action === "set") {
            cfg = { ...cfg, orchestratorAllowedProviders: normalizeProviders(providerArgs) };
            await state.save(cfg);
            cache.clear();
          } else if (action === "add") {
            cfg = {
              ...cfg,
              orchestratorAllowedProviders: normalizeProviders([...cfg.orchestratorAllowedProviders, ...providerArgs]),
            };
            await state.save(cfg);
            cache.clear();
          } else if (action === "remove") {
            const remove = new Set(normalizeProviders(providerArgs));
            cfg = {
              ...cfg,
              orchestratorAllowedProviders: cfg.orchestratorAllowedProviders.filter((p) => !remove.has(p)),
            };
            await state.save(cfg);
            cache.clear();
          } else if (action === "clear") {
            cfg = { ...cfg, orchestratorAllowedProviders: [] };
            await state.save(cfg);
            cache.clear();
          } else if (action !== "status") {
            ctx.ui.notify("auto-router: unknown primary providers action", "warning");
            return;
          }
        }
        ctx.ui.notify(
          `auto-router: primary providers=${formatProviders(cfg.orchestratorAllowedProviders)}; ` +
            "subagent frontmatter pins are unchanged",
          "info",
        );
        return;
      }
      const sub = parts[0] ?? "";
      if (sub === "on" || sub === "off") {
        cfg = { ...cfg, enabled: sub === "on" };
        await state.save(cfg);
      }
      const flagOn = pi.getFlag("auto") === true;
      const active = cfg.enabled || flagOn;
      const inert = active && explicitModel ? " (inert: explicit --model)" : "";
      ctx.ui.notify(
        `auto-router: ${active ? "ON" : "OFF"}${flagOn && !cfg.enabled ? " (via --auto)" : ""}${inert}; ` +
          `classifier=${cfg.classifierModel ?? "cheapest-available"}; ` +
          `matrix=${cfg.matrixEnabled ? "on" : "off"}; ` +
          `primaryProviders=${formatProviders(cfg.orchestratorAllowedProviders)}`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!cfg.enabled && pi.getFlag("auto") !== true) {
      // Routing off ⇒ this turn is unrouted; drop any sticky label so its
      // usage is never attributed to a previous turn's task type.
      pendingLabel = null;
      return;
    }
    if (explicitModel) {
      // Explicit --model on argv (#519): routing is inert for this process —
      // short-circuit BEFORE the classifier side-call and discovery probes, so
      // a pinned subagent child pays none of the routing cost the pin exists
      // to avoid. The turn is unrouted for measurement purposes.
      pendingLabel = null;
      if (!explicitModelNotified && ctx.hasUI) {
        explicitModelNotified = true;
        ctx.ui.notify(
          "auto-router: explicit --model on the command line; routing is inert for this session",
          "info",
        );
      }
      return;
    }
    try {
      const outcome = await route(
        pi as unknown as RoutePi,
        ctx as unknown as RouteContext,
        event.prompt,
        cfg,
        matrix,
        cache,
        unavailable,
        { preferOmlx: preferLocalOmlx },
      );
      pendingLabel =
        outcome.kind === "routed"
          ? { taskType: outcome.taskType, source: outcome.source }
          : null;
      feedback(ctx, outcome);
    } catch {
      // Routing must never block a turn. The label is cleared too: a turn
      // whose route errored must not be recorded under the previous label.
      pendingLabel = null;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    // #351 recorder: observational only — always returns undefined, never a
    // replacement message, and never lets an I/O failure disturb the turn.
    try {
      const message = (event as unknown as { message?: AssistantMessageLike }).message;
      if (!message || message.role !== "assistant") return undefined;
      turn += 1;
      if (pendingLabel === null) return undefined;
      const record = buildTaskRecord(pendingLabel.taskType, pendingLabel.source, message, {
        ts: new Date().toISOString(),
        turn,
        providerFallback:
          (ctx as unknown as { model?: { provider?: string } }).model?.provider ?? "unknown",
      });
      // Deliberately NOT cleared: the label stays sticky so every assistant
      // message of an agentic turn is recorded; the next routing attempt
      // (or a non-routed turn) replaces or clears it.
      if (record) await appendTaskRecord(record);
    } catch {
      // Measurement must never disturb a turn.
    }
    return undefined;
  });

  pi.on("model_select", (event, ctx) => {
    // Reflect the live model on every change (router `set`, manual `/model`, cycle, restore).
    showModel(ctx, event.model.provider, event.model.id);
  });
}
