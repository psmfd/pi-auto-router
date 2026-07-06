/**
 * auto-router/recorder.ts — the #351 measurement pipeline: join one routing
 * decision's task-type label with the NEXT assistant turn's real token usage,
 * and append the pair to task-types.jsonl.
 *
 * Measurement only — nothing here influences routing. The join is a sticky
 * label: `before_agent_start` arms it with the route outcome's taskType, and
 * EVERY subsequent assistant `message_end` records under it until the next
 * routing attempt replaces it (or a non-routed turn clears it). Stickiness
 * matters because an agentic turn produces many assistant messages — labeling
 * only the first would understate agentic-loop cost, the number the #352
 * matrix is seeded from.
 *
 * Same posture as token-meter (ADR-0073): append-only JSONL (interleaving-safe
 * `fs.appendFile`), numeric usage + model/provider/taskType strings only —
 * never message content — and recording must never disturb a turn.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { PickSource, TaskType } from "./types.ts";

const NAMESPACE = "auto-router";
const LOG_FILE = "task-types.jsonl";

/** The per-turn usage slice pi exposes on an assistant message (as token-meter reads it). */
export interface UsageLike {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: { readonly total?: number };
}

/** The slice of an assistant message the recorder reads. */
export interface AssistantMessageLike {
  readonly role: string;
  readonly model?: string;
  readonly provider?: string;
  readonly usage?: UsageLike;
}

/** One JSONL line: a routed turn's task-type label joined with its real usage. */
export interface TaskTypeRecord {
  readonly ts: string;
  /** 1-based assistant-turn index within this process. */
  readonly turn: number;
  readonly taskType: TaskType;
  /**
   * Whether the matrix or the classifier picked the routed model (#352,
   * ADR-0078). Keeps matrix-influenced turns distinguishable from organic
   * classifier choices — without this, the very dataset the matrix was seeded
   * from becomes self-confirming once the override goes live. Records written
   * before #352 lack the field; consumers default it to "classifier".
   */
  readonly source: PickSource;
  readonly model: string;
  readonly provider: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  /** Realized cost for the turn, or null when the provider omits it. */
  readonly costTotal: number | null;
  /**
   * Routing-policy tag (#521): the operator's A/B label from
   * TOKEN_METER_POLICY_TAG, "untagged" when unset — same field and sentinel as
   * token-meter's TurnRecord, so task-type × policy joins need no ts/turn
   * correlation. Read at build time from the env the subagent tree inherits.
   */
  readonly policy: string;
}

/** Resolve the task-types log path (agentDir injectable for tests). */
export function taskTypesLogPath(agentDir?: string): string {
  const base = agentDir ?? join(homedir(), ".pi", "agent");
  return join(base, "extensions", NAMESPACE, LOG_FILE);
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Build a {@link TaskTypeRecord} from a pending task-type label and the
 * assistant message that completed the turn. Returns null for non-assistant
 * messages (only assistant turns carry usage).
 */
export function buildTaskRecord(
  taskType: TaskType,
  source: PickSource,
  message: AssistantMessageLike | undefined,
  ctx: {
    readonly ts: string;
    readonly turn: number;
    readonly providerFallback: string;
    /** Injectable for tests; defaults to the inherited env tag. */
    readonly policyTag?: string;
  },
): TaskTypeRecord | null {
  if (!message || message.role !== "assistant") return null;
  const usage = message.usage ?? {};
  // Same normalization + sentinel as token-meter (#521): missing/empty →
  // "untagged", never dropped. The env var is inherited by subagent children,
  // so a whole tree records one consistent label.
  const envTag = process.env["TOKEN_METER_POLICY_TAG"]?.trim();
  const policy = ctx.policyTag?.trim() || envTag || "untagged";
  return {
    ts: ctx.ts,
    turn: ctx.turn,
    taskType,
    source,
    model: message.model ?? "unknown",
    provider: message.provider ?? ctx.providerFallback,
    input: numberOr(usage.input, 0),
    cacheRead: numberOr(usage.cacheRead, 0),
    cacheWrite: numberOr(usage.cacheWrite, 0),
    output: numberOr(usage.output, 0),
    costTotal: typeof usage.cost?.total === "number" ? usage.cost.total : null,
    policy,
  };
}

/** Append one record as a JSONL line, creating the directory as needed. */
export async function appendTaskRecord(record: TaskTypeRecord, agentDir?: string): Promise<void> {
  const file = taskTypesLogPath(agentDir);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}
