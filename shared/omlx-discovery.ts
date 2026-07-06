/**
 * shared/omlx-discovery.ts — live oMLX server/model availability (#364).
 * Moved from auto-router/ to shared/ in #534 so the subagent spawn gate can
 * reuse the probe for spawn-time liveness gating (ADR-0081).
 *
 * The local-server analog of copilot-discovery.ts (ADR-0035): pi's
 * `getAvailable()` treats the registered omlx model as available whenever its
 * apiKey is *configured* (the `!cat` command is never executed by the check),
 * so a stopped server or an unloaded model still shows as routable and the
 * router could select a dead backend. This module probes `GET /v1/models` on
 * the local server and returns the set of served model ids.
 *
 * Contract — deliberately different from the Copilot filter in one way:
 *   - `null`  = unknown / ambiguous → no filtering (fail open, menu unchanged).
 *   - `Set`   = authoritative served set, INCLUDING the empty set: a confirmed
 *     connection failure returns `Set()` so every omlx candidate is dropped.
 *     (Copilot's empty result means discovery failure; here a dead localhost
 *     socket is a confirmed fact, and dropping only ever affects omlx models.)
 *
 * Filter only on confirmed evidence; fail open on ambiguity (#364):
 *   - connection-level fetch failure → confirmed down → empty set
 *   - 200 with the alias absent from data[] → model not loaded → filtered set
 *   - timeout/abort → fail open: a saturated oMLX mid-prefill can be slow to
 *     answer /v1/models while being very much alive (sustained mark 8,
 *     local-llm ADR-010) — filtering here would drop a live candidate exactly
 *     under load
 *   - 401/5xx/malformed body → fail open: the server is up; the probe's key
 *     handling must never kill a candidate that pi's own request-time key
 *     resolution might serve fine
 *
 * Security posture (matches ADR-0035): host-pinned to loopback (a non-loopback
 * OMLX_BASE_URL refuses to probe), the bearer is read at request time from
 * OMLX_API_KEY or ~/.omlx/api-key and never stored or logged (only model-id
 * strings are cached), and the result only FILTERS a routing menu — nothing
 * enters model context (no-MCP compliant).
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "./copilot-discovery.ts";

const DEFAULT_BASE = "http://localhost:8000/v1";
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 256 * 1024;
const VALID_ID = /^[\w.\-/:]{1,200}$/;
const CACHE_TTL_MS = 60 * 1000; // short: a local server stops/starts far more often than a JWT rotates
const PROBE_TIMEOUT_MS = 1500;

export interface OmlxDiscoveryDeps {
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
  readonly signal?: AbortSignal | undefined;
  /** Injectable key reader (real env+file lookup in production). */
  readonly readKey?: () => Promise<string | null>;
  /** Injectable base override (defaults to OMLX_BASE_URL or localhost:8000). */
  readonly baseUrl?: string | undefined;
}

/** Resolve the probe base URL; null when it is not loopback (never probed). */
export function omlxBaseUrl(override?: string): string | null {
  const base = (override ?? process.env["OMLX_BASE_URL"] ?? DEFAULT_BASE).replace(/\/+$/, "");
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return LOOPBACK_HOSTS.has(u.hostname) || LOOPBACK_HOSTS.has(`[${u.hostname}]`) ? base : null;
  } catch {
    return null;
  }
}

/** Read the bearer key at request time: OMLX_API_KEY, else ~/.omlx/api-key. */
async function readOmlxKey(): Promise<string | null> {
  const env = process.env["OMLX_API_KEY"]?.trim();
  if (env) return env;
  try {
    const key = (await fs.readFile(join(homedir(), ".omlx", "api-key"), "utf8")).trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** Parse the served-model id set from a `/v1/models` body; null when malformed. */
export function parseServedModels(body: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && VALID_ID.test(id)) ids.add(id);
  }
  // An empty 200 list is authoritative: the server is up and serves nothing.
  return ids;
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Probe the local oMLX server for its served model ids. See the module header
 * for the null-vs-empty-set contract. Pure given injected deps.
 */
export async function fetchServedOmlxModels(deps: OmlxDiscoveryDeps = {}): Promise<Set<string> | null> {
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchFn) return null;
  const base = omlxBaseUrl(deps.baseUrl);
  if (!base) return null;

  const key = await (deps.readKey ?? readOmlxKey)();
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: "error", // loopback should never redirect; a redirect must not carry the key
      signal,
    });
  } catch (err) {
    // Timeout/abort is ambiguous (a saturated server answers slowly) → fail
    // open. Any other rejection on a loopback socket is a confirmed-down
    // signal → authoritative empty set.
    return isAbortLike(err) ? null : new Set<string>();
  }
  if (!res.ok) return null; // 401/5xx: server up, probe inconclusive → fail open
  try {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return parseServedModels(text);
  } catch {
    return null;
  }
}

// Module-level cache: model-id strings only (never the key), short TTL so a
// stopped/restarted server is noticed within a minute.
let cache: { models: Set<string>; expiresAt: number } | undefined;

/** Clear the discovery cache (called on session_start; used in tests). */
export function clearOmlxCache(): void {
  cache = undefined;
}

/** Cached wrapper around {@link fetchServedOmlxModels} (60s TTL; null uncached). */
export async function getServedOmlxModels(deps: OmlxDiscoveryDeps = {}): Promise<Set<string> | null> {
  const now = (deps.now ?? Date.now)();
  if (cache && now < cache.expiresAt) return cache.models;
  const models = await fetchServedOmlxModels(deps);
  if (models !== null) cache = { models, expiresAt: now + CACHE_TTL_MS };
  return models;
}

/** The registry slice {@link resolveOmlxFilter} needs. */
export interface OmlxFilterContext {
  readonly modelRegistry: {
    getAvailable(): Promise<readonly { provider: string; id: string }[]> | readonly { provider: string; id: string }[];
  };
}

/**
 * Resolve the live omlx filter: null when no omlx model is registered (nothing
 * to filter) or the probe is inconclusive; otherwise the authoritative served
 * set (possibly empty — see the module header).
 */
export async function resolveOmlxFilter(
  ctx: OmlxFilterContext,
  deps: OmlxDiscoveryDeps = {},
): Promise<Set<string> | null> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    if (!available.some((m) => m.provider === "omlx")) return null;
    return await getServedOmlxModels(deps);
  } catch {
    return null;
  }
}
