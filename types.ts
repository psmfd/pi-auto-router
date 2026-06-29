/**
 * auto-router/types.ts — shared type aliases for the router.
 *
 * `RouterModel` is the exact pi-ai model object that `complete()` and
 * `pi.setModel()` accept (derived from the published signature, so it tracks
 * the SDK without hand-maintenance). `Auth` mirrors the shape returned by
 * `ctx.modelRegistry.getApiKeyAndHeaders()` (verified against pi v0.79.0
 * example `examples/extensions/qna.ts`).
 */

import type { complete } from "@earendil-works/pi-ai";

/** The pi-ai model object accepted by `complete()` and `pi.setModel()`. */
export type RouterModel = Parameters<typeof complete>[0];

/** Credentials + headers for a model, from `modelRegistry.getApiKeyAndHeaders()`. */
export interface Auth {
  readonly ok: boolean;
  readonly apiKey?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly error?: string | undefined;
}
