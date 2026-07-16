/**
 * shared/anthropic-discovery.ts — live Anthropic model availability (#538).
 * Moved to shared in #748 so parent routing and subagent policy consume the
 * same retirement filter through the canonical availability snapshot.
 *
 * pi's static registry keeps retired Anthropic ids (e.g.
 * `claude-3-haiku-20240307`), and with auth configured they land in
 * `getAvailable()` — so the classifier can route a turn to a model the API
 * 404s. This module queries the live `GET /v1/models` endpoint and returns the
 * set of ids the account can actually serve, the third instance of the
 * live-discovery pattern (copilot: ADR-0035/#343; oMLX: #364).
 *
 * Security posture (mirrors copilot-discovery.ts):
 *   - Reuses pi's managed Anthropic credential via getApiKeyAndHeaders; sent
 *     only to the pinned `api.anthropic.com` host over HTTPS, never logged,
 *     never cached (only model-id strings are cached).
 *   - `redirect: "error"` so a redirect can never carry the credential
 *     off-host.
 *   - The result only FILTERS a routing menu — ids never enter model context.
 *
 * Fail-open by contract (copilot semantics, NOT the omlx authoritative-empty
 * semantics): EVERY failure — no credential, an auth type `/v1/models` rejects
 * (e.g. some OAuth grants), non-2xx, oversized/malformed body, network error,
 * zero ids — returns `null`, which callers treat as "unknown, leave the static
 * menu unchanged." A non-null return is always a non-empty set. api.anthropic.com
 * confirming an EMPTY account model list is not a real state worth trusting,
 * and routing must never break (ADR-0031).
 */

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_BODY_BYTES = 256 * 1024;
const VALID_ID = /^[\w.\-/]{1,200}$/;
const CACHE_TTL_MS = 20 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 5_000;
/** `/v1/models` pages at ≤100 entries; the catalog is tens of models. */
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

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
  /** Internal deadline override for deterministic tests. */
  readonly timeoutMs?: number;
}

export interface AuthLike {
  readonly ok: boolean;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
}

/**
 * Build the request headers for `/v1/models` from pi's Auth shape, mirroring
 * pi-ai's own anthropic client: an OAuth token (`sk-ant-oat…`) authenticates
 * as `Authorization: Bearer` with the oauth beta header; an API key as
 * `x-api-key`. Returns null when there is nothing to authenticate with.
 */
export function buildAnthropicHeaders(auth: AuthLike): Record<string, string> | null {
  if (!auth.ok || !auth.apiKey) return null;
  const credential: Record<string, string> = auth.apiKey.includes("sk-ant-oat")
    ? { authorization: `Bearer ${auth.apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
    : { "x-api-key": auth.apiKey };
  return {
    accept: "application/json",
    ...(auth.headers ?? {}),
    ...credential,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

export interface ModelsPage {
  readonly ids: readonly string[];
  readonly hasMore: boolean;
  readonly lastId: string | null;
}

/** Parse one `/v1/models` page, or null when the body is not a models list. */
export function parseModelsPage(body: string): ModelsPage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const page = parsed as { data?: unknown; has_more?: unknown; last_id?: unknown };
  if (!Array.isArray(page.data)) return null;

  const ids: string[] = [];
  for (const entry of page.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && VALID_ID.test(id)) ids.push(id);
  }
  return {
    ids,
    hasMore: page.has_more === true,
    lastId: typeof page.last_id === "string" ? page.last_id : null,
  };
}

/**
 * Fetch the live set of servable Anthropic model ids, following pagination up
 * to MAX_PAGES. Returns null on ANY failure or an empty result (fail open).
 * Pure given an injected `fetchFn`.
 */
function boundedSignal(signal?: AbortSignal, timeoutMs = DISCOVERY_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("discovery aborted");
}

async function awaitWithSignal<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function fetchAnthropicModels(
  auth: AuthLike,
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  const headers = buildAnthropicHeaders(auth);
  if (!headers) return null;
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchFn) return null;

  const ids = new Set<string>();
  let afterId: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `limit=${PAGE_LIMIT}${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
      const res = await fetchFn(`${ANTHROPIC_BASE}/v1/models?${query}`, {
        headers,
        redirect: "error", // a redirect must never carry the credential off-host
        signal: boundedSignal(deps.signal, deps.timeoutMs),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) return null;
      const parsed = parseModelsPage(text);
      if (!parsed) return null;
      for (const id of parsed.ids) ids.add(id);
      if (!parsed.hasMore || !parsed.lastId) break;
      afterId = parsed.lastId;
    }
  } catch {
    return null; // network error, redirect, abort — fail open
  }
  return ids.size > 0 ? ids : null; // empty set is a discovery failure, not a filter
}

// Module-level cache: model-id sets only (NEVER the credential), expired on a
// wall-clock TTL. One Anthropic account per process.
let cache: { models: Set<string>; expiresAt: number } | undefined;
let cacheEpoch = 0;

/** Clear the discovery cache and invalidate every older in-flight write. */
export function clearAnthropicCache(): void {
  cache = undefined;
  cacheEpoch += 1;
}

/** Cached wrapper around {@link fetchAnthropicModels} (20-min TTL). */
export async function getServedAnthropicModels(
  auth: AuthLike,
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  const now = (deps.now ?? Date.now)();
  if (cache && now < cache.expiresAt) return cache.models;
  const epoch = ++cacheEpoch;
  const models = await fetchAnthropicModels(auth, deps);
  if (models !== null && epoch === cacheEpoch) {
    cache = { models, expiresAt: now + CACHE_TTL_MS };
  }
  return models;
}

/** The registry slice {@link resolveAnthropicFilter} needs. */
export interface AnthropicAuthContext {
  readonly modelRegistry: {
    getAvailable(): Promise<readonly { provider: string; id: string }[]> | readonly { provider: string; id: string }[];
    find(provider: string, id: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<AuthLike> | AuthLike;
  };
}

/**
 * Resolve the live Anthropic filter for the current credential, or null when
 * there is nothing to filter (no anthropic models available) or discovery is
 * unavailable. Authenticates with ANY available anthropic model.
 */
export async function resolveAnthropicFilter(
  ctx: AnthropicAuthContext,
  deps: DiscoveryDeps = {},
): Promise<Set<string> | null> {
  try {
    const signal = boundedSignal(deps.signal, deps.timeoutMs);
    const available = await awaitWithSignal(ctx.modelRegistry.getAvailable(), signal);
    const anthropic = available.find((m) => m.provider === "anthropic");
    if (!anthropic) return null; // no anthropic models → no filtering needed
    const model = ctx.modelRegistry.find(anthropic.provider, anthropic.id);
    if (!model) return null;
    const auth = await awaitWithSignal(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
    return await getServedAnthropicModels(auth, { ...deps, signal });
  } catch {
    return null;
  }
}
