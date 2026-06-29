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

import { clearCopilotCache } from "./copilot-discovery.ts";
import { route, type RouteContext, type RouteOutcome, type RoutePi } from "./route.ts";
import * as state from "./state.ts";

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
        `auto-router: routed → ${outcome.target}${outcome.cached ? " (cached)" : ""}` +
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

export default function autoRouter(pi: ExtensionAPI): void {
  let cfg: state.RouterState = state.DEFAULT_STATE;
  const cache = new state.DecisionCache();
  // `provider/id`s that returned a provider error (e.g. 429) this session — skipped
  // as both classifier and routing targets until the next session.
  const unavailable = new Set<string>();

  pi.registerFlag("auto", {
    description: "Enable per-prompt auto model routing for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = await state.load();
    unavailable.clear(); // give quota-recovered models a fresh chance each session
    clearCopilotCache(); // re-discover live Copilot availability each session
    if (ctx.model) showModel(ctx, ctx.model.provider, ctx.model.id);
  });

  pi.registerCommand("auto", {
    description: "Auto model routing: /auto [on|off|status]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      if (sub === "on" || sub === "off") {
        cfg = { ...cfg, enabled: sub === "on" };
        await state.save(cfg);
      }
      const flagOn = pi.getFlag("auto") === true;
      const active = cfg.enabled || flagOn;
      ctx.ui.notify(
        `auto-router: ${active ? "ON" : "OFF"}${flagOn && !cfg.enabled ? " (via --auto)" : ""}; ` +
          `classifier=${cfg.classifierModel ?? "cheapest-available"}`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!cfg.enabled && pi.getFlag("auto") !== true) return;
    try {
      const outcome = await route(
        pi as unknown as RoutePi,
        ctx as unknown as RouteContext,
        event.prompt,
        cfg,
        cache,
        unavailable,
      );
      feedback(ctx, outcome);
    } catch {
      // Routing must never block a turn.
    }
  });

  pi.on("model_select", (event, ctx) => {
    // Reflect the live model on every change (router `set`, manual `/model`, cycle, restore).
    showModel(ctx, event.model.provider, event.model.id);
  });
}
