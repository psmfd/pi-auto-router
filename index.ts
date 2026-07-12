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

import { DEFAULT_LOCAL_ROLE, isLocalModelKey, readLocalRole, type LocalRole } from "./shared/local-role.ts";
import { defaultMatrixPath, gardenMatrix, loadRoutingMatrix, type RoutingMatrix } from "./shared/routing-matrix.ts";
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
      } else if (outcome.reason === "local-restricted") {
        msg =
          "auto-router: only local models are available and extensionSettings.localLlm.role " +
          "restricts them to the classifier. Configure a provider, or set localLlm.role to full.";
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

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function validModelKey(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 && !/\s/.test(value);
}

function splitModelKey(value: string): { provider: string; id: string } {
  const slash = value.indexOf("/");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function matrixAgeDays(lastReviewed: string, now = new Date()): number | null {
  const t = Date.parse(lastReviewed);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

function formatMatrixStatus(matrix: RoutingMatrix | null): string {
  if (!matrix) return "routing-matrix.json not loaded — classifier picks apply";
  const rows = Object.keys(matrix.models).length;
  // #660: freshness is judged by the most recent human touch — the refresh
  // audit block when present, else lastReviewed. Refresh metadata is only
  // ever written by the human editing the file (tooling prints a snippet to
  // paste; nothing programmatic writes the matrix).
  const freshness = matrix.refresh?.at ?? matrix.lastReviewed;
  const age = matrixAgeDays(freshness);
  const ageText = age === null ? "unknown age" : `${age}d old${age > 180 ? " (stale)" : ""}`;
  const refreshText = matrix.refresh
    ? `; refreshed=${matrix.refresh.at} via ${matrix.refresh.tool} (${matrix.refresh.source})`
    : "; refresh metadata absent (see scripts/analyze-routing-matrix.sh --suggest-refresh-metadata)";
  return `path=${defaultMatrixPath()}; rows=${rows}; lastReviewed=${matrix.lastReviewed || "<missing>"}; ${ageText}${refreshText}`;
}

/**
 * Matrix gardening surface (#656 follow-through): compare the live registry
 * against the matrix rows on the read-only status/review commands. Dangling
 * rows (provider onboarded, exact id gone) are actionable and named;
 * unlisted credentialed models are summarized as per-provider counts (the
 * registry lists dozens of ids — enumerating them would be noise). Runtime
 * only — CI cannot see this host's credentials, so validate.sh carries just
 * the static schema checks. Fails soft to an empty string: gardening must
 * never break a status command.
 */
async function formatMatrixGardening(
  matrix: RoutingMatrix | null,
  ctx: ExtensionContext,
): Promise<string> {
  if (!matrix) return "";
  try {
    const available = await Promise.resolve(
      (ctx.modelRegistry as { getAvailable(): { provider: string; id: string }[] }).getAvailable(),
    );
    const keys = new Set(available.map((m) => `${m.provider}/${m.id}`));
    const g = gardenMatrix(matrix, keys);
    const parts: string[] = [];
    if (g.danglingRows.length > 0) {
      parts.push(`DANGLING rows (provider onboarded, id not in registry — fix or remove): ${g.danglingRows.join(", ")}`);
    }
    const unlisted = Object.entries(g.unlistedByProvider)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, n]) => `${p}:${n}`)
      .join(" ");
    if (unlisted) parts.push(`credentialed models without a matrix row: ${unlisted}`);
    return parts.length > 0 ? `; gardening — ${parts.join("; ")}` : "";
  } catch {
    return "";
  }
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
  // ADR-0094 (#685): global local-LLM role lever. Read once on session_start
  // from user-layer settings (shared/local-role.ts); threaded into route()
  // and enforced on /auto lock + model_select capture below.
  let localRole: LocalRole = DEFAULT_LOCAL_ROLE;
  // #519 precedence guard: an explicit argv --model wins over routing for the
  // whole process lifetime (argv never changes). Computed once; the notify is
  // one-time so an agentic session is not toasted every turn.
  const explicitModel = hasExplicitModelFlag();
  let explicitModelNotified = false;
  // ADR-0094 review fix: one notice per session when a persisted local lock
  // is bypassed at its point of use (see the before_agent_start handler).
  let localLockNotified = false;
  // ADR-0090 exact orchestrator model lock: suppress model_select feedback loops
  // when this extension is re-applying the saved lock itself.
  let applyingModelLock = false;
  let applyingRouteModelChange = false;

  pi.registerFlag("auto", {
    description: "Enable per-prompt auto model routing for this session",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    cfg = await state.load();
    matrix = await loadRoutingMatrix(); // per-session reload: edits apply next session (#352)
    unavailable.clear(); // give quota-recovered models a fresh chance each session
    // ADR-0094 review fix: routing decisions cache the resolved TARGET, and a
    // cache hit bypasses the two-pool lever filtering in buildRoutingPrompt —
    // a decision cached under a permissive lever must not replay after the
    // lever (read once per session, next line block) has been restricted.
    // route() also re-checks hits defensively; this is the session boundary.
    cache.clear();
    clearCopilotCache(); // re-discover live Copilot availability each session
    clearAnthropicCache(); // re-discover live Anthropic availability each session (#538)
    clearOmlxCache(); // re-probe local oMLX availability each session (#364)
    pendingLabel = null;
    turn = 0;
    preferLocalOmlx = await readPreferLocalOmlxSetting();
    localRole = await readLocalRole();
    localLockNotified = false;
    if (ctx.model) showModel(ctx, ctx.model.provider, ctx.model.id);
  });

  pi.registerCommand("auto", {
    description: "Auto model routing: /auto [on|off|status|matrix on|matrix off|lock current|lock set provider/id|lock clear|primary copilot|primary clear]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (parts[0] === "matrix") {
        // #352 (ADR-0078): toggle the deterministic capability-matrix override.
        // ADR-0090/#660: status/review are user-invoked and never mutate the
        // matrix file; routing itself never silently refreshes this policy.
        const sub = parts[1] ?? "status";
        if (sub === "on" || sub === "off") {
          cfg = { ...cfg, matrixEnabled: sub === "on" };
          await state.save(cfg);
          // A prompt hash carries no dependency on the flag — decisions cached
          // under the other mode would replay stale picks. Drop them all.
          cache.clear();
        } else if (sub === "review") {
          ctx.ui.notify(
            `auto-router: matrix review — ${formatMatrixStatus(matrix)}${await formatMatrixGardening(matrix, ctx)}. ` +
              "Run scripts/analyze-routing-matrix.sh (--suggest-refresh-metadata for the audit block) and update routing-matrix.json in a reviewed PR; routing never auto-refreshes it.",
            "info",
          );
          return;
        } else if (sub !== "status") {
          ctx.ui.notify("auto-router: unknown matrix action", "warning");
          return;
        }
        ctx.ui.notify(
          `auto-router: matrix ${cfg.matrixEnabled ? "ON" : "OFF"}; ${formatMatrixStatus(matrix)}${await formatMatrixGardening(matrix, ctx)}`,
          "info",
        );
        return;
      }
      if (parts[0] === "lock") {
        const sub = parts[1] ?? "status";
        if (sub === "current") {
          if (!ctx.model) {
            ctx.ui.notify("auto-router: no current model is available to lock", "warning");
            return;
          }
          // ADR-0094: a persisted lock re-applies every turn — locking a local
          // model would keep local in effect indefinitely against the lever.
          // Refuse visibly; two conflicting operator directives must surface.
          if (localRole !== "full" && isLocalModelKey(modelKey(ctx.model))) {
            ctx.ui.notify(
              `auto-router: refusing to lock ${modelKey(ctx.model)} — localLlm.role=${localRole} restricts local models; change the setting first`,
              "warning",
            );
            return;
          }
          cfg = { ...cfg, orchestratorModelLock: modelKey(ctx.model) };
          await state.save(cfg);
          cache.clear();
        } else if (sub === "set") {
          const target = parts[2] ?? "";
          if (!validModelKey(target)) {
            ctx.ui.notify("auto-router: use /auto lock set provider/id", "warning");
            return;
          }
          // ADR-0094: see the lock-current refusal above.
          if (localRole !== "full" && isLocalModelKey(target)) {
            ctx.ui.notify(
              `auto-router: refusing to lock ${target} — localLlm.role=${localRole} restricts local models; change the setting first`,
              "warning",
            );
            return;
          }
          const { provider, id } = splitModelKey(target);
          if (!ctx.modelRegistry.find(provider, id)) {
            ctx.ui.notify(`auto-router: ${target} is not in the available model registry`, "warning");
            return;
          }
          cfg = { ...cfg, orchestratorModelLock: target };
          await state.save(cfg);
          cache.clear();
        } else if (sub === "clear") {
          cfg = { ...cfg, orchestratorModelLock: null };
          await state.save(cfg);
          cache.clear();
        } else if (sub !== "status") {
          ctx.ui.notify("auto-router: unknown lock action", "warning");
          return;
        }
        ctx.ui.notify(
          `auto-router: orchestratorModelLock=${cfg.orchestratorModelLock ?? "none"}`,
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
        if (sub === "on" && cfg.orchestratorModelLock === null && ctx.model) {
          // ADR-0094 review fix: /auto on is a lock-WRITE site like
          // lock current/set and the model_select capture — a live local
          // model must not be persisted while the lever restricts local.
          if (localRole !== "full" && isLocalModelKey(modelKey(ctx.model))) {
            ctx.ui.notify(
              `auto-router: current model ${modelKey(ctx.model)} not captured as the lock (localLlm.role=${localRole})`,
              "info",
            );
          } else {
            cfg = { ...cfg, orchestratorModelLock: modelKey(ctx.model) };
          }
        }
        await state.save(cfg);
      }
      const flagOn = pi.getFlag("auto") === true;
      const active = cfg.enabled || flagOn;
      const inert = active && explicitModel ? " (inert: explicit --model)" : "";
      ctx.ui.notify(
        `auto-router: ${active ? "ON" : "OFF"}${flagOn && !cfg.enabled ? " (via --auto)" : ""}${inert}; ` +
          `classifier=${cfg.classifierModel ?? "cheapest-available"}; ` +
          `matrix=${cfg.matrixEnabled ? "on" : "off"}; ` +
          `localRole=${localRole}; ` +
          `orchestratorLock=${cfg.orchestratorModelLock ?? "none"}; ` +
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
    // ADR-0094 review fix: enforce the lever at the point of USE, not just at
    // the write sites — a local lock already resident in state.json (persisted
    // pre-lever, hand-edited, or via the pre-fix /auto on capture) must not
    // keep routing the orchestrator to a local model under a restricted lever.
    // The lock is deliberately NOT auto-cleared (surfaced, never silently
    // mutated); the turn falls through to routing, whose two-pool split keeps
    // local out of the targets.
    const lockBypassedByLever =
      cfg.orchestratorModelLock !== null &&
      localRole !== "full" &&
      isLocalModelKey(cfg.orchestratorModelLock);
    if (lockBypassedByLever && !localLockNotified && ctx.hasUI) {
      localLockNotified = true;
      ctx.ui.notify(
        `auto-router: locked orchestrator model ${cfg.orchestratorModelLock} not applied — localLlm.role=${localRole} restricts local models; ` +
          "routing proceeds without the lock (use /auto lock clear to drop it, or change the setting)",
        "warning",
      );
    }
    if (cfg.orchestratorModelLock !== null && !lockBypassedByLever) {
      pendingLabel = null;
      const { provider, id } = splitModelKey(cfg.orchestratorModelLock);
      const locked = ctx.modelRegistry.find(provider, id);
      if (!locked) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `auto-router: locked orchestrator model ${cfg.orchestratorModelLock} is not available; kept current`,
            "warning",
          );
        }
        return;
      }
      if (!ctx.model || modelKey(ctx.model) !== cfg.orchestratorModelLock) {
        applyingModelLock = true;
        try {
          const ok = await pi.setModel(locked);
          if (!ok && ctx.hasUI) {
            ctx.ui.notify(
              `auto-router: no credential for locked orchestrator model ${cfg.orchestratorModelLock}; kept current`,
              "warning",
            );
          }
        } finally {
          applyingModelLock = false;
        }
      }
      if (ctx.model) showModel(ctx, ctx.model.provider, ctx.model.id);
      return;
    }
    try {
      applyingRouteModelChange = true;
      const outcome = await route(
        pi as unknown as RoutePi,
        ctx as unknown as RouteContext,
        event.prompt,
        cfg,
        matrix,
        cache,
        unavailable,
        { preferOmlx: preferLocalOmlx, localRole },
      );
      applyingRouteModelChange = false;
      pendingLabel =
        outcome.kind === "routed"
          ? { taskType: outcome.taskType, source: outcome.source }
          : null;
      feedback(ctx, outcome);
    } catch {
      applyingRouteModelChange = false;
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

  pi.on("model_select", async (event, ctx) => {
    // Reflect the live model on every change (router `set`, manual `/model`, cycle, restore).
    showModel(ctx, event.model.provider, event.model.id);
    const active = cfg.enabled || pi.getFlag("auto") === true;
    if (active && !explicitModel && !applyingModelLock && !applyingRouteModelChange) {
      const next = modelKey(event.model);
      // ADR-0094: a manual `/model omlx/…` is honored for the live session
      // (operator's in-the-moment call), but is NOT auto-captured into the
      // persisted lock while the lever restricts local — capture would extend
      // a momentary choice indefinitely, re-applied on every future turn.
      if (localRole !== "full" && isLocalModelKey(next)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `auto-router: ${next} honored for this session but not captured as the lock (localLlm.role=${localRole})`,
            "info",
          );
        }
        return;
      }
      if (cfg.orchestratorModelLock !== next) {
        cfg = { ...cfg, orchestratorModelLock: next };
        await state.save(cfg).catch(() => undefined);
        cache.clear();
      }
    }
  });
}
