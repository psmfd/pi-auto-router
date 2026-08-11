/**
 * shared/provider-headers.ts — pi `ProviderHeaders` normalization (#953).
 *
 * pi v0.84.0 changed `ctx.modelRegistry.getApiKeyAndHeaders()` to return
 * `ProviderHeaders` — `Record<string, string | null>` — where a `null` value is
 * a header-DELETION marker rather than a value. Upstream's migration note is
 * explicit that extensions forwarding the map into a pi-ai stream pass it
 * through unchanged, while extensions that INSPECT or REBUILD it must handle
 * the null themselves.
 *
 * Our live-discovery modules are the second case: `anthropic-discovery.ts` and
 * `copilot-discovery.ts` compose their own `fetch` init for a provider's
 * `/models` endpoint instead of handing the map to pi-ai. Spreading a raw
 * `ProviderHeaders` into that init would serialize a deletion marker as the
 * literal header value `null` and send it to api.anthropic.com / the Copilot
 * API — the exact failure upstream's change guards against (the marker exists
 * so placeholder credentials are NOT sent through a gateway).
 *
 * This module is the single place that collapses the marker, so the three call
 * sites cannot drift. It is deliberately tolerant of the pre-0.84.0 shape
 * (`Record<string, string>`, no nulls present), making it a no-op on the
 * current pin and correct after the bump — the runtime pin moves separately.
 *
 * Why this is not caught by `tsc`: the discovery modules declare their own
 * structural `AuthLike` interfaces rather than importing pi's type, so the
 * narrower `Record<string, string>` annotation kept typechecking cleanly while
 * the runtime shape widened underneath it. Widening those annotations to
 * `ProviderHeaders` (below) is what restores the compiler as a guard.
 */

/**
 * pi's post-0.84.0 header map. A `null` value is a deletion marker: the header
 * must not be sent, and any value accumulated earlier for that key is dropped.
 */
export type ProviderHeaders = Record<string, string | null>;

/**
 * The slice of pi's resolved auth our discovery modules read. Mirrors
 * `getApiKeyAndHeaders()`'s return shape at the fields we consume; `headers`
 * carries the nullable post-0.84.0 values.
 */
export interface ProviderAuthLike {
  readonly ok: boolean;
  readonly apiKey?: string | undefined;
  readonly headers?: ProviderHeaders | undefined;
}

/**
 * Apply pi's provider headers over a base map, honouring deletion markers.
 *
 * Precedence is overlay-over-base, with one extra rule: a `null` overlay value
 * REMOVES the key and is never itself emitted. An `undefined` value is not a
 * documented pi state — it is skipped without disturbing the base, since
 * dropping a header we set ourselves on an undocumented signal is the more
 * surprising of the two failure modes.
 *
 * The accumulator is null-prototype so a `__proto__` key is an ordinary data
 * property rather than a prototype mutation; the returned object is a plain
 * one (object spread defines own properties, so the guarantee survives) and
 * therefore compares cleanly under `assert.deepStrictEqual`.
 */
export function mergeProviderHeaders(
  base: Record<string, string>,
  overlay: ProviderHeaders | undefined,
): Record<string, string> {
  const acc: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(base)) acc[key] = value;
  if (overlay) {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null) {
        delete acc[key];
        continue;
      }
      if (value === undefined) continue;
      acc[key] = value;
    }
  }
  return { ...acc };
}
