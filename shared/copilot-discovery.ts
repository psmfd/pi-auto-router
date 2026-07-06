/**
 * auto-router/copilot-discovery.ts — live GitHub Copilot model availability.
 *
 * pi's `getAvailable()` reflects a STATIC catalog filtered by credential, so it
 * over-reports: it lists `github-copilot` models the subscription cannot serve
 * (tier-gated / picker-disabled), which then 400/403 when routed. This module
 * queries the live Copilot `/models` endpoint and returns the set of genuinely
 * usable model ids, so the router can drop the phantoms. See ADR-0035 / #343.
 *
 * Security posture (ADR-0035, security review):
 *   - Reuses pi's managed short-lived Copilot JWT (via getApiKeyAndHeaders); the
 *     token is sent only to the exact `*.githubcopilot.com` hosts over HTTPS,
 *     never logged, never cached (only model-id strings are cached).
 *   - Host-pinned + `redirect: "error"` so a redirect can never carry the Bearer
 *     token off-host (the canonical SSRF credential-exfil vector).
 *   - The result only FILTERS a routing menu — model ids never enter model
 *     context — so this is not the ADR-046 injection vector (no-MCP compliant).
 *
 * Fail-open by contract: EVERY failure mode — including an empty/zero-enabled
 * result — returns `null`, which callers treat as "unknown, leave the static
 * menu unchanged." A non-null return is always a non-empty set. Routing never
 * breaks (#343 / ADR-0031).
 */

/** The Copilot API hosts the JWT may be sent to (exact-host match). */
export const COPILOT_API_HOSTS: ReadonlySet<string> = new Set([
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
]);

const FALLBACK_BASE = "https://api.individual.githubcopilot.com";
const MAX_BODY_BYTES = 256 * 1024;
const VALID_ID = /^[\w.\-/]{1,200}$/;
const CACHE_TTL_MS = 20 * 60 * 1000; // inside the ~25-min JWT lifecycle

/** Minimal response shape we depend on (global `fetch`'s Response satisfies it). */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** Injectable fetch (real `fetch` in production; a stub in tests — no network). */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: "error"; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export interface DiscoveryDeps {
  readonly fetchFn?: FetchLike;
  readonly now?: () => number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Derive the Copilot API base from the JWT's `proxy-ep=` field (the approach
 * pi itself uses): `proxy.individual.…` → `api.individual.…`. Returns null when
 * the token carries no recognizable endpoint.
 */
export function copilotBaseUrl(jwt: string): string | null {
  const m = /proxy-ep=([^;]+)/.exec(jwt);
  if (!m || !m[1]) return null;
  const host = m[1].trim().replace(/^proxy\./, "api.");
  return host ? `https://${host}` : null;
}

/** Parse the enabled-model id set from a `/models` body, or null if none qualify. */
export function parseEnabledModels(body: string): Set<string> | null {
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
    const e = entry as { id?: unknown; model_picker_enabled?: unknown; policy?: { state?: unknown } };
    if (e.model_picker_enabled !== true) continue;
    if (e.policy && e.policy.state === "disabled") continue;
    if (typeof e.id !== "string" || !VALID_ID.test(e.id)) continue;
    ids.add(e.id);
  }
  return ids.size > 0 ? ids : null; // empty set is a discovery failure, not a filter
}

/**
 * Fetch the live set of picker-enabled, non-disabled Copilot model ids. Returns
 * null on ANY failure (no token, bad base, non-2xx, oversized/malformed body,
 * redirect, zero enabled). Pure given an injected `fetchFn`.
 */
export async function fetchCopilotEnabledModels(
  auth: { readonly ok: boolean; readonly apiKey?: string | undefined; readonly headers?: Record<string, string> | undefined },
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  if (!auth.ok || !auth.apiKey) return null;
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchFn) return null;

  const base = copilotBaseUrl(auth.apiKey) ?? FALLBACK_BASE;
  let host: string;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:") return null;
    host = u.host;
  } catch {
    return null;
  }
  if (!COPILOT_API_HOSTS.has(host)) return null;

  try {
    const res = await fetchFn(`${base}/models`, {
      headers: { ...(auth.headers ?? {}), Authorization: `Bearer ${auth.apiKey}` },
      redirect: "error", // a redirect must never carry the Bearer token off-host
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return parseEnabledModels(text);
  } catch {
    return null; // network error, redirect, abort — fail open
  }
}

// Module-level cache: model-id sets only (NEVER the JWT), one Copilot account
// per process, expired on a wall-clock TTL inside the JWT lifetime.
let cache: { models: Set<string>; expiresAt: number } | undefined;

/** Clear the discovery cache (called on session_start; used in tests). */
export function clearCopilotCache(): void {
  cache = undefined;
}

/** Cached wrapper around {@link fetchCopilotEnabledModels} (20-min TTL). */
export async function getEnabledCopilotModels(
  auth: { readonly ok: boolean; readonly apiKey?: string | undefined; readonly headers?: Record<string, string> | undefined },
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  const now = (deps.now ?? Date.now)();
  if (cache && now < cache.expiresAt) return cache.models;
  const models = await fetchCopilotEnabledModels(auth, deps);
  if (models !== null) cache = { models, expiresAt: now + CACHE_TTL_MS };
  return models;
}

/** The registry slice {@link resolveCopilotFilter} needs. */
export interface CopilotAuthContext {
  readonly modelRegistry: {
    getAvailable(): Promise<readonly { provider: string; id: string }[]> | readonly { provider: string; id: string }[];
    find(provider: string, id: string): unknown;
    getApiKeyAndHeaders(model: unknown):
      | Promise<{ ok: boolean; apiKey?: string | undefined; headers?: Record<string, string> | undefined }>
      | { ok: boolean; apiKey?: string | undefined; headers?: Record<string, string> | undefined };
  };
}

/**
 * Resolve the live Copilot filter for the current login, or null when there is
 * nothing to filter (no copilot models available) or discovery is unavailable.
 * Authenticates with ANY available copilot model (never a hardcoded id).
 */
export async function resolveCopilotFilter(
  ctx: CopilotAuthContext,
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    const copilot = available.find((m) => m.provider === "github-copilot");
    if (!copilot) return null; // no copilot models → no filtering needed
    const model = ctx.modelRegistry.find(copilot.provider, copilot.id);
    if (!model) return null;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    return await getEnabledCopilotModels(auth, deps);
  } catch {
    return null;
  }
}
