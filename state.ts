/**
 * auto-router/state.ts — persisted on/off + classifier choice, plus an
 * in-memory per-session decision cache.
 *
 * Persistence delegates to `shared/state.ts` (schema-versioned JSON under
 * `~/.pi/agent/extensions/auto-router/state.json`, ADR-0019/ADR-0030). The
 * decision cache is intentionally in-memory only: it keys on a prompt hash so
 * identical prompts in one session skip re-classification, but it must not
 * persist routing decisions across sessions (models/credentials change).
 */

import { loadState, saveState } from "./shared/state.ts";
import type { PickSource, TaskType } from "./types.ts";

const NAMESPACE = "auto-router";

export interface RouterState {
  /** Whether per-prompt routing is active (persisted toggle; `--auto` also enables). */
  readonly enabled: boolean;
  /** `provider/id` of the model used to run the classifier, or null for "cheapest available". */
  readonly classifierModel: string | null;
  /** Optional `provider/id` allowlist limiting routing targets. */
  readonly allowlist: readonly string[];
  /**
   * Provider-level allowlist for primary/orchestrator routing. Empty means the
   * router may consider every credentialed provider. Subagent children remain
   * governed by their wrapper frontmatter pins and spawn-time gate.
   */
  readonly orchestratorAllowedProviders: readonly string[];
  /**
   * Whether the deterministic capability-matrix pick overrides the
   * classifier's choice (#352, ADR-0078). Default ON since #353 (ADR-0079).
   * `load()` merges the persisted state over DEFAULT_STATE, so a state.json
   * lacking the key gets the current default, while an explicitly persisted
   * `false` (a real `/auto matrix off`) survives.
   */
  readonly matrixEnabled: boolean;
}

export const DEFAULT_STATE: RouterState = {
  enabled: false,
  classifierModel: null,
  allowlist: [],
  orchestratorAllowedProviders: [],
  matrixEnabled: true,
};

export async function load(agentDir?: string): Promise<RouterState> {
  // Per-field default-merge (ADR-0079): loadState is a cast, not a merge, so
  // without the spread a persisted file written before a field existed would
  // pin that field to `undefined` forever — "flip the default" would only
  // ever reach zero-state fresh installs. Keys the file DOES carry win.
  const raw = await loadState<RouterState>(NAMESPACE, DEFAULT_STATE, agentDir);
  return { ...DEFAULT_STATE, ...raw };
}

export async function save(state: RouterState, agentDir?: string): Promise<void> {
  await saveState<RouterState>(NAMESPACE, state, agentDir);
}

/** Deterministic, dependency-free djb2 hash → unsigned hex. Stable across runs. */
export function hashPrompt(prompt: string): string {
  let h = 5381;
  for (let i = 0; i < prompt.length; i++) {
    h = ((h << 5) + h + prompt.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * One cached routing decision: the `provider/id` target plus the task-type
 * label from the classification that produced it, so a cache-hit turn still
 * records a task type (#351 measurement pipeline). `source` records whether
 * the matrix or the classifier produced the target (#352), so cache-hit turns
 * report the same source the original decision had.
 */
export interface CachedDecision {
  readonly target: string;
  readonly taskType: TaskType;
  readonly source: PickSource;
}

/** Bounded, insertion-ordered cache of `promptHash -> CachedDecision`. */
export class DecisionCache {
  private readonly map = new Map<string, CachedDecision>();

  constructor(private readonly maxSize = 200) {}

  get(key: string): CachedDecision | undefined {
    return this.map.get(key);
  }

  set(key: string, value: CachedDecision): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Drop every cached decision. Called when `/auto matrix on|off` flips the
   * flag (#352): a prompt hash carries no dependency on the flag, so an entry
   * cached under the other mode would otherwise replay a stale pick.
   */
  clear(): void {
    this.map.clear();
  }
}
