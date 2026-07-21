/**
 * shared/local-role.ts — the global local-LLM role lever (pi_config #685,
 * ADR-0094).
 *
 * One user-layer setting governs where local (`omlx/*`) models may be used:
 *
 *   extensionSettings.localLlm.role: "full" | "classifier-only" | "off"
 *
 *   - "full" (default)      — local models participate everywhere today's
 *                             policy allows: the auto-router classifier
 *                             side-call, main-session routing targets, and
 *                             local-eligible subagents (ADR-0090 composition).
 *   - "classifier-only"     — local models may RUN the auto-router's cheap
 *                             classifier side-call, but can never be the
 *                             routed target of a real turn nor a subagent
 *                             model.
 *   - "off"                 — no local model anywhere, classifier included.
 *
 * Read from USER-layer `~/.pi/agent/settings.json` ONLY — project-layer
 * settings are deliberately not consulted (same trust boundary as ADR-0073/
 * ADR-0080/ADR-0084: a hostile repo must not steer local-model usage).
 * Because spawned subagent children are independent pi processes reading the
 * same user-layer file, the lever crosses the parent→child process boundary
 * with no extra plumbing — an unpinned child re-running auto-router applies
 * the identical restriction.
 *
 * This is the shared reader both auto-router and subagent consume, rather
 * than two hand-rolled per-extension parsers (the preferLocalOmlx /
 * copilotFallbackModel pattern), so the two extensions cannot drift on the
 * lever's semantics.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type LocalRole = "full" | "classifier-only" | "off";

export const DEFAULT_LOCAL_ROLE: LocalRole = "full";

/**
 * Providers considered "local". Strict provider equality everywhere this is
 * consumed (never substring/startsWith — a hypothetical `omlx-cloud` must not
 * be swept into the local rung; same rule as orderClassifierModels).
 */
export const LOCAL_PROVIDERS: readonly string[] = ["omlx"];

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.includes(provider);
}

/** `provider/id` string form of {@link isLocalProvider}. */
export function isLocalModelKey(key: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && isLocalProvider(key.slice(0, slash));
}

/**
 * Parse a raw settings value into a LocalRole. Only the three exact strings
 * are recognized — anything else (typos, booleans, numbers) falls back to the
 * default. Fail-safe direction note: the default is "full" (today's
 * behavior), so a typo'd value does not silently *disable* local — the lever
 * is an operator restriction the operator must spell correctly, surfaced via
 * /auto status.
 */
export function parseLocalRole(value: unknown): LocalRole {
  return value === "full" || value === "classifier-only" || value === "off" ? value : DEFAULT_LOCAL_ROLE;
}

/**
 * Read the lever from user-layer settings. Any read/parse error yields the
 * default. Callers read once per session (auto-router) or once per tool call
 * (subagent) — changes apply on the next session/call, same posture as
 * preferLocalOmlx.
 *
 * `agentDir` overrides the `~/.pi/agent` directory for tests only (same
 * injection seam as state.ts); production callers pass nothing.
 */
export async function readLocalRole(agentDir?: string): Promise<LocalRole> {
  try {
    const p = path.join(agentDir ?? path.join(os.homedir(), ".pi", "agent"), "settings.json");
    const j = JSON.parse(await fs.readFile(p, "utf8")) as {
      extensionSettings?: { localLlm?: { role?: unknown } };
    };
    return parseLocalRole(j?.extensionSettings?.localLlm?.role);
  } catch {
    return DEFAULT_LOCAL_ROLE;
  }
}

/**
 * Filter a candidate pool for one of the two consumption contexts:
 *
 *   - "classifier" — the pool of models eligible to RUN the auto-router
 *     classifier side-call. Local stays in under "full" and
 *     "classifier-only"; stripped under "off".
 *   - "target" — the pool a real turn or a subagent child may actually be
 *     routed to. Local stays in only under "full".
 *
 * A hard filter, deliberately NOT a ranking preference: `preferLocal: false`
 * in model-ranking only reorders, and a zero-cost local candidate wins on
 * cost-rank anyway — exclusion must remove it from the array (the same
 * pattern the subagent local-forbidden path uses).
 */
export function filterLocalCandidates<T extends { readonly provider: string }>(
  candidates: readonly T[],
  role: LocalRole,
  context: "classifier" | "target",
): readonly T[] {
  const allowLocal = role === "full" || (role === "classifier-only" && context === "classifier");
  if (allowLocal) return candidates;
  return candidates.filter((c) => !isLocalProvider(c.provider));
}
