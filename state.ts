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

const NAMESPACE = "auto-router";

export interface RouterState {
  /** Whether per-prompt routing is active (persisted toggle; `--auto` also enables). */
  readonly enabled: boolean;
  /** `provider/id` of the model used to run the classifier, or null for "cheapest available". */
  readonly classifierModel: string | null;
  /** Optional `provider/id` allowlist limiting routing targets. */
  readonly allowlist: readonly string[];
}

export const DEFAULT_STATE: RouterState = {
  enabled: false,
  classifierModel: null,
  allowlist: [],
};

export async function load(agentDir?: string): Promise<RouterState> {
  return loadState<RouterState>(NAMESPACE, DEFAULT_STATE, agentDir);
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

/** Bounded, insertion-ordered cache of `promptHash -> "provider/id"`. */
export class DecisionCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly maxSize = 200) {}

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
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
}
