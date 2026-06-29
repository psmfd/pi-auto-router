# auto-router

Per-prompt model selection for pi. When enabled, a cheap **classifier** model
picks the best credentialed model for each user prompt and applies it with
`pi.setModel()` before the first provider request. Part of the Pi Extension
Suite (#327); consumes the [`shared/`](https://github.com/psmfd/pi-config/blob/main/agent/extensions/shared/README.md) foundation. See
[ADR-0031](https://github.com/psmfd/pi-config/blob/main/adrs/0031-auto-router.md).

## Install

```sh
pi install git:github.com/psmfd/pi-auto-router
```

Try it first without installing: `pi -e git:github.com/psmfd/pi-auto-router`.

## Flow

1. `before_agent_start` fires once per prompt. If routing is off, no-op (manual `/model` is untouched).
2. `policy.ts` builds the **credentialed** candidate menu (`shared/candidates.ts` → `modelRegistry.getAvailable()`), each with a one-line cost/window hint, plus the current context-usage signal (`shared/signals.ts`) so high context pressure biases toward larger-window models. For `github-copilot`, the menu is first narrowed to live-available models (see [Copilot live availability](#copilot-live-availability-adr-0035-343)).
3. `classifier.ts` calls a cheap model via pi-ai **`complete()`** (credentials resolved through `ctx.modelRegistry.getApiKeyAndHeaders()`), instructing it to return only `{"model":"provider/id","reason":"…"}`.
4. The choice is resolved against the credentialed menu and applied via `pi.setModel(model)`.
5. A per-session **decision cache** (keyed on a prompt hash) skips re-classifying identical prompts.

**Routing never blocks a turn.** Any failure — no candidates, no credential, parse error, network error, abort, `setModel` returning `false`, or a hallucinated model not in the menu — falls back to the current model.

### Feedback

- **Status bar** (persistent): `🤖 provider/id` shows the model currently in use, refreshed after every routing attempt and on every model change (router `set`, manual `/model`, `Ctrl+P` cycle, session restore), seeded at `session_start`.
- **Toast** (transient): **every** routing outcome speaks, so a session is never silent — `auto-router: routed → provider/id — <reason>` on success, or an explicit cause on a fallback (`classifier returned no choice`, `no credentialed candidates`, `choice "…" unavailable`, `no credential for …`, all `; kept current`).

### Resilience (classifier failover)

The classifier call can fail — most commonly a **429 quota/rate error** from the provider. The router treats any provider error as "this model is unavailable", **fails over to the next candidate** (cheapest-first) until one returns a choice or the list is exhausted, and records the dead `provider/id` in a **session unavailable set**. That set is excluded from both the classifier rotation and the routing menu (so the real turn isn't sent to a quota-dead model either), and is **cleared at `session_start`** so a recovered quota gets a fresh chance.

When the cause is specifically a **429 / quota / rate-limit**, the message says so plainly instead of a generic "no choice": `all N candidate model(s) are rate-limited / quota-exhausted (429). Routing paused — use /model to pick a model, or wait for the quota to reset.` Once models are marked unavailable, subsequent prompts hit `no-candidates` (`all-unavailable`) and skip the classifier calls entirely — no further quota burn. Note the classifier and the turn share the same quota, so an exhausted provider fails the real turn too; that turn-level error is pi's, not the router's. The lasting fix for a single shared-quota provider is a genuinely separate model (e.g. a free local model, `track:local-llm`).

## Controls

| Control | Effect |
|---|---|
| `/auto on` / `/auto off` | Toggle routing; persisted across sessions (`shared/state.ts`, namespace `auto-router`). |
| `/auto status` (or `/auto`) | Show ON/OFF + the configured classifier model. |
| `--auto` | Enable routing for the current session (in addition to the persisted toggle). |

## State

`~/.pi/agent/extensions/auto-router/state.json`, schema-versioned (`{v:1}`):
`{ enabled, classifierModel, allowlist }`. `classifierModel` null ⇒ the cheapest
credentialed candidate runs the classifier. `allowlist` (empty ⇒ all) limits
routing targets to specific `provider/id` entries.

## Files

| File | Role |
|---|---|
| `index.ts` | Factory: wires `before_agent_start`, `/auto`, `--auto`, the `🤖 provider/id` status-bar segment (`ctx.ui.setStatus` on `model_select` + `session_start`), and `session_start` state restore. |
| `policy.ts` | Candidate menu + classifier prompt; resolve/validate the choice; pick the classifier model. |
| `classifier.ts` | The `complete()` side-call + JSON parse; graceful `null` on any failure. |
| `route.ts` | Dispatch logic (structurally typed, unit-tested); returns a `RouteOutcome`. |
| `copilot-discovery.ts` | Live GitHub Copilot `/models` discovery — filters the menu to genuinely-usable copilot models (ADR-0035). |
| `state.ts` | Persisted toggle/config + in-memory decision cache. |
| `types.ts` | `RouterModel` (= `complete()`'s model param) and `Auth`. |

## Copilot live availability (ADR-0035, #343)

pi's `getAvailable()` reflects a **static** catalog filtered by credential, so it over-reports `github-copilot` models the subscription cannot serve (tier-gated or picker-disabled) — which then 400 when routed (e.g. `github-copilot/gpt-5.4-nano`). Before building the menu, `copilot-discovery.ts` queries the live Copilot `/models` endpoint (auth + base both derived from the JWT pi already manages via `getApiKeyAndHeaders`) and keeps only `model_picker_enabled === true && policy.state !== "disabled"` models; copilot candidates absent from that set are dropped. Non-copilot providers are untouched.

**Fail-open:** any failure — no JWT, network error, non-2xx, malformed/empty body — leaves the static menu unchanged (routing never breaks). The result is cached per session (~20 min, model-ids only, never the JWT; host-pinned + no off-host redirect). When the live filter legitimately empties an all-Copilot menu, the `copilot-filtered` outcome explains it ("gated by your subscription tier — use /model") instead of the misleading "no credentialed models."

## Deferred (post-v1)

- **Mid-loop escalation** (`turn_start` + `setModel`) — re-routing within a turn loop.
- **Indexing-bias policy** — lower the capability bar for prompts answerable via `search_codebase` retrieval (needs Workstream C / indexing live).

## Cost

One extra cheap-model round-trip per *novel* prompt (cached prompts cost nothing). Mitigated by a tight prompt, the cheap classifier model, and the decision cache.

## API provenance

Verified against **pi v0.79.0** (Phase 0, #328): event lifecycle (`before_agent_start` → … → `before_provider_request`), `pi.setModel`/`registerCommand`/`registerFlag`, `ctx.modelRegistry.{getAvailable,getApiKeyAndHeaders,find}`, `model_select`, and pi-ai `complete()` (`examples/extensions/qna.ts`).

## Tests

```sh
./scripts/test-auto-router.sh          # node:test via tsx
VERBOSE=1 ./scripts/test-auto-router.sh
```

Unit tests use mocked `pi`/`ctx` and an injected `complete` so the parse/policy/fallback/cache logic runs offline. Live routing-quality validation is recorded in PR #342 via a probe run in a real pi session.
