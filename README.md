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

1. `before_agent_start` fires once per prompt. If routing is off, no-op (manual `/model` is untouched). If the process was launched with an explicit `--model`, routing is **inert for the whole session** (see [Explicit `--model` precedence](#explicit---model-precedence-519-adr-0076)).
2. `policy.ts` builds the **credentialed** candidate menu (`shared/candidates.ts` → `modelRegistry.getAvailable()`), each with a one-line cost/window hint, plus the current context-usage signal (`shared/signals.ts`) so high context pressure biases toward larger-window models. If a primary/orchestrator provider restriction is configured, the parent session's menu is first narrowed to those providers (for example, `github-copilot`) while subagent frontmatter pins remain unchanged. For `github-copilot`, `anthropic`, and `omlx`, the menu is also narrowed to live-available models (see [Copilot](#copilot-live-availability-adr-0035-343), [Anthropic](#anthropic-live-availability-538), and [oMLX](#omlx-live-availability-364) live availability).
3. `classifier.ts` calls a cheap model via pi-ai **`complete()`** (credentials resolved through `ctx.modelRegistry.getApiKeyAndHeaders()`), instructing it to return only `{"taskType":"<type>","model":"provider/id","reason":"…"}`. The task-type label is **measurement-only** (see [Task-type measurement](#task-type-measurement-351)); an invented or missing label degrades to `unknown` and never fails the parse.
4. When **matrix routing** is enabled (the default since #353/ADR-0079; `/auto matrix off` opts out), the classifier's task-type label consults the hand-authored capability floor and the cheapest capable available model deterministically overrides the classifier's model choice (see [Matrix routing](#matrix-routing-352-adr-0078)); a matrix miss leaves the classifier's pick standing.
5. The choice is resolved against the credentialed menu and applied via `pi.setModel(model)`.
6. A per-session **decision cache** (keyed on a prompt hash) skips re-classifying identical prompts.

**Routing never blocks a turn.** Any failure — no candidates, no credential, parse error, network error, abort, `setModel` returning `false`, or a hallucinated model not in the menu — falls back to the current model.

### Feedback

- **Status bar** (persistent): `🤖 provider/id` shows the model currently in use, refreshed after every routing attempt and on every model change (router `set`, manual `/model`, `Ctrl+P` cycle, session restore), seeded at `session_start`.
- **Toast** (transient): **every** routing outcome speaks, so a session is never silent — `auto-router: routed → provider/id — <reason>` on success, or an explicit cause on a fallback (`classifier returned no choice`, `no credentialed candidates`, `choice "…" unavailable`, `no credential for …`, all `; kept current`).

### Resilience (classifier failover)

The classifier call can fail — most commonly a **429 quota/rate error** from the provider. The router treats any provider error as "this model is unavailable", **fails over to the next candidate** (cheapest-first) until one returns a choice or the list is exhausted, and records the dead `provider/id` in a **session unavailable set**. That set is excluded from both the classifier rotation and the routing menu (so the real turn isn't sent to a quota-dead model either), and is **cleared at `session_start`** so a recovered quota gets a fresh chance.

When the cause is specifically a **429 / quota / rate-limit**, the message says so plainly instead of a generic "no choice": `all N candidate model(s) are rate-limited / quota-exhausted (429). Routing paused — use /model to pick a model, or wait for the quota to reset.` Once models are marked unavailable, subsequent prompts hit `no-candidates` (`all-unavailable`) and skip the classifier calls entirely — no further quota burn. Note the classifier and the turn share the same quota, so an exhausted provider fails the real turn too; that turn-level error is pi's, not the router's. The lasting fix for a single shared-quota provider is a genuinely separate model (e.g. a free local model, `track:local-llm`).

## Task-type measurement (#351)

Phase 1 of #350 — **measurement only, zero routing-behavior change**. The
classifier labels each prompt with one of a closed taxonomy (`simple-qa`,
`code-edit`, `code-review`, `long-context`, `agentic-loop`, `creative`; anything
else degrades to `unknown`), in the same single call that picks the model. On a
routed turn the label is held **sticky**: every assistant `message_end` until
the next routing attempt is joined with its real token usage and appended as
one JSONL line to `~/.pi/agent/extensions/auto-router/task-types.jsonl` — an
agentic turn produces many assistant messages, and labeling only the first
would understate agentic-loop cost. A non-routed turn (routing toggled off, a
fallback outcome, or a route error) clears the label, so unrouted usage is
never misattributed:

```jsonc
{ "ts":"2026-07-05T14:32:01Z","turn":5,"taskType":"code-edit","source":"classifier",
  "model":"claude-sonnet-5","provider":"anthropic","input":812,"cacheRead":4200,"cacheWrite":0,
  "output":340,"costTotal":0.0193,"policy":"mixed-local" }
```

The decision cache stores the label alongside the target, so cache-hit turns
still record their task type. Recording is observational (never blocks or
rewrites a turn, no message content logged — same posture as token-meter,
ADR-0073). Analyze with:

```sh
scripts/analyze-routing-matrix.sh              # default log location
scripts/analyze-routing-matrix.sh --log <f>    # explicit log(s)
```

which reports per `taskType × model × source` turn counts and average
input/output/cost (cost averages `n/a` when the provider reported none — never
a fabricated $0). Matrix-forced rows render with a `[matrix]` tag; records
written before #352 lack the `source` field and default to `classifier`. This
observed data seeded the Phase 2 routing matrix, and the `source` split is what
keeps it honestly re-evaluable now that #352 consults it (a dataset that can't
separate matrix-forced from organic choices would be self-confirming).

### Local workhorse in the rotation (#363, ADR-0084)

A registered **cost-0 local model** (`omlx/coding-workhorse`, #518) sorts first
in `orderClassifierModels()`, so the local model runs the classifier by default
when available. This is deliberate — the decision is recorded in
[ADR-0076](https://github.com/psmfd/pi-config/blob/main/adrs/0076-model-tier-policy-and-precedence-guard.md):
the call is free and burns no frontier quota, each *novel* prompt costs one of
oMLX's 8 sustained concurrency slots (local-llm ADR-010) and the decision cache
absorbs repeats, and a nominal fake cost would corrupt the #351/#520
observed-cost data.

As of [ADR-0084](https://github.com/psmfd/pi-config/blob/main/adrs/0084-auto-router-prefer-local-classifier.md)
(#589), the local-first preference is enforced explicitly by a strict
`provider === "omlx"` partition placed after the cost/window sort — a live
local candidate leads the classifier rotation even when a cost-0 Copilot model
has a smaller window. The previous accepted-tiebreak behavior (smallest window
first among cost-0 candidates) is preserved behind an opt-out.

Operators can override this per-user via `~/.pi/agent/settings.json`
(user-layer only, same trust boundary as `subagent.copilotFallbackModel` per
ADR-0080; project-layer `.pi/settings.json` is deliberately not consulted):

```json
{
  "extensionSettings": {
    "autoRouter": {
      "preferLocalOmlx": false
    }
  }
}
```

Default is `true`. Set `false` to restore pure cost/window ordering. Malformed
or missing values default to `true`. The value is read once on `session_start`.

An explicit `classifierModel` pin
(`"provider/id"`) in `~/.pi/agent/extensions/auto-router/state.json` still
wins over both this preference and the cost/window sort.

The hand-authored **capability floor** for task-type routing lives in
[`shared/routing-matrix.json`](https://github.com/psmfd/pi-config/blob/main/agent/extensions/shared/routing-matrix.json) — the workhorse's
seed row admits `simple-qa · code-edit · code-review · agentic-loop` and gates
`long-context`/`creative` to the frontier (concurrency is
prefill-activation-bound; quality-tier work is deliberately not local,
ADR-009/010). Consulted by [Matrix routing](#matrix-routing-352-adr-0078)
since #352.

## Matrix routing (#352, ADR-0078)

Phase 2 of #350 — feature-flagged, **on by default since #353 (ADR-0079)**
after the recorded burn-in (97.8% cost reduction, zero quality regressions;
see the #353 evidence comment). When enabled, the
classifier's task-type label consults the capability floor and
`resolveByTaskType` (`policy.ts`) deterministically overrides the classifier's
model choice with the **cheapest capable available window-adequate** candidate:

1. **Capability floor** — matrix membership only, never cost. Closed world for
   picks: a model absent from `routing-matrix.json` is never a *matrix* pick
   (the classifier may still choose it, so absence never removes a model from
   routing — the floor can only decline to override).
2. **Availability** — the pick draws from the same live-filtered menu the
   classifier saw (allowlist + Copilot/Anthropic/oMLX filters compose for
   free) and re-checks the session `unavailable` set *after* the classify
   loop, which can 429 a model mid-loop.
3. **Window adequacy** — a candidate already past `FORCE_COMPACT_AT` (90%,
   `shared/signals.ts`) on its *own* window at the current token count is
   excluded before cost-ranking (routing to it would force immediate
   compaction). Unknown usage fails open — the filter is skipped, never
   guessed.
4. **Cost-rank** — `input + k·output` with **k = 1** (per-Mtok prices; see
   ADR-0078 Q3 — recalibration from observed token ratios is #541).
   Deterministic tiebreak: smaller window, then `provider/id` order. This is
   deliberately NOT `orderClassifierModels`' input-only sort, which prices the
   classifier side-call, not the real turn.

Any empty stage → typed `null` → the classifier's pick stands (`source:
"classifier"`); a matrix pick that survives every gate routes with `source:
"matrix"` — the toast shows `routed → provider/id [matrix]`, and the source is
recorded on the cached decision and every task-type record. The matrix file is
loaded fail-soft once per session (`shared/routing-matrix.ts`): missing or
malformed ⇒ matrix routing silently degrades to classifier routing. Toggling
`/auto matrix on|off` clears the decision cache (a prompt hash carries no flag
dependency, so cross-mode cache replays would otherwise be stale).
`validate.sh` guards the committed matrix (structure FAILs; `lastReviewed`
staleness >180d and unpinned-key cross-reference WARN).

### Primary/orchestrator provider restriction (#552, ADR-0083)

Operators who want the parent/orchestrator session to stay on a provider tier
(for example Copilot) can restrict auto-router's **primary** candidate menu
without changing subagent behavior:

```text
/auto primary copilot
/auto primary providers set github-copilot anthropic
/auto primary clear
/auto primary status
```

`/auto primary copilot` is shorthand for `primary providers set
github-copilot`. When the restriction is non-empty, the classifier and matrix
routing only see candidates from those providers for the parent session. A
local-only matrix row such as `omlx/coding-workhorse` therefore cannot override
a primary Copilot restriction; if no allowed provider is credentialed, the
router keeps the current model and reports that the restriction left no
candidates instead of falling through to local.

This split is intentionally scoped to auto-router's parent-session
`pi.setModel()` path. Subagent children are still governed by
`agent/agents/*.md` frontmatter pins and the subagent spawn-time gate:
read-only specialists can run on `omlx/coding-workhorse`, the review trio can
run on `github-copilot/claude-opus-4.7`, and dropped local pins still take the
Copilot fallback rung before the session default. Unpinned child agents inherit
the active/default model as before.

### Explicit `--model` precedence (#519, ADR-0076)

An explicit `--model` on the command line **wins unconditionally**: routing is
inert for the entire process, even when `/auto on` is persisted or `--auto` is
also passed. The check (`argv-guard.ts`) short-circuits `before_agent_start`
*before* the classifier side-call and the Copilot/oMLX discovery probes, so a
pinned invocation pays none of the routing cost — this is what keeps the
subagent extension's frontmatter pins authoritative inside spawned children,
where the router's disk-global enable state would otherwise re-route over the
pin (and, via pi's `setModel`, rewrite the operator's saved default — #533).
Detection mirrors pi's parser exactly (two-token `--model <value>`; `--models`
never matches; a trailing valueless `--model` is ignored). One toast on the
first gated turn; `/auto status` reports `ON (inert: explicit --model)`.
Accepted gap: the guard is argv-anchored, so resumed sessions and mid-session
`/model` picks are not covered (pi persists no model-provenance) — see
ADR-0076.

## Controls

| Control | Effect |
|---|---|
| `/auto on` / `/auto off` | Toggle routing; persisted across sessions (`shared/state.ts`, namespace `auto-router`). |
| `/auto status` (or `/auto`) | Show ON/OFF + the configured classifier model + matrix on/off + primary provider restriction; appends `(inert: explicit --model)` when the precedence guard is active. |
| `/auto matrix on` / `/auto matrix off` | Toggle the deterministic capability-matrix override (#352); persisted; clears the decision cache. `/auto matrix` alone reports the state (and whether the matrix file loaded). |
| `/auto primary copilot` | Restrict parent/orchestrator routing candidates to `github-copilot/*`; subagent pins are unchanged. |
| `/auto primary providers set <provider> [...]` | Restrict parent/orchestrator routing to the listed providers. |
| `/auto primary providers add <provider> [...]` / `/auto primary providers remove <provider> [...]` | Edit the parent/orchestrator provider restriction. |
| `/auto primary clear` | Clear the parent/orchestrator provider restriction and restore the unrestricted candidate menu. |
| `--auto` | Enable routing for the current session (in addition to the persisted toggle). |

## State

`~/.pi/agent/extensions/auto-router/state.json`, schema-versioned (`{v:1}`):
`{ enabled, classifierModel, allowlist, orchestratorAllowedProviders,
matrixEnabled }`. `classifierModel` null ⇒ the cheapest credentialed candidate
runs the classifier. `allowlist` (empty ⇒ all) limits routing targets to
specific `provider/id` entries. `orchestratorAllowedProviders` (empty ⇒ all)
limits only the parent/orchestrator provider menu; it does not modify subagent
child pins. `matrixEnabled` (default true since #353/ADR-0079) gates matrix
routing. `load()` merges the persisted file over the defaults, so a state file
lacking a newer field gets the current default, while an explicitly persisted
`false` (a real `/auto matrix off`) always survives.

## Files

| File | Role |
|---|---|
| `index.ts` | Factory: wires `before_agent_start`, `/auto`, `--auto`, the `🤖 provider/id` status-bar segment (`ctx.ui.setStatus` on `model_select` + `session_start`), `session_start` state restore, and the `message_end` task-type recorder join. |
| `argv-guard.ts` | `hasExplicitModelFlag()` — the explicit `--model` precedence check (#519, ADR-0076). |
| `policy.ts` | Candidate menu + classifier prompt; resolve/validate the choice; pick the classifier model; `resolveByTaskType` — the deterministic matrix pick (#352). |
| `classifier.ts` | The `complete()` side-call + JSON parse; graceful `null` on any failure. |
| `route.ts` | Dispatch logic (structurally typed, unit-tested); returns a `RouteOutcome`. |
| `../shared/copilot-discovery.ts` | Live GitHub Copilot `/models` discovery — filters the menu to genuinely-usable copilot models (ADR-0035). In `shared/` since #536 (the subagent spawn gate reuses it); auto-router remains the session_start cache-clearer alongside subagent's own. |
| `anthropic-discovery.ts` | Live Anthropic `/v1/models` discovery — drops retired registry ids that 404 when routed (#538). |
| `../shared/omlx-discovery.ts` | Live oMLX `/v1/models` probe — drops the local candidate when the server is confirmed down or the model unloaded (#364). In `shared/` since #534 (the subagent spawn gate reuses it for liveness gating, ADR-0081); auto-router still clears its cache on `session_start`. |
| `recorder.ts` | #351 measurement pipeline: join a routed turn's task-type label with its real usage → `task-types.jsonl`. |
| `state.ts` | Persisted toggle/config (incl. `matrixEnabled`) + in-memory decision cache (`{target, taskType, source}` per prompt hash). |
| `types.ts` | `RouterModel` (= `complete()`'s model param), `Auth`, the closed `TASK_TYPES` taxonomy, and `PickSource` (#352). |

## Copilot live availability (ADR-0035, #343)

pi's `getAvailable()` reflects a **static** catalog filtered by credential, so it over-reports `github-copilot` models the subscription cannot serve (tier-gated or picker-disabled) — which then 400 when routed (e.g. `github-copilot/gpt-5.4-nano`). Before building the menu, `shared/copilot-discovery.ts` (relocated in #536) queries the live Copilot `/models` endpoint (auth + base both derived from the JWT pi already manages via `getApiKeyAndHeaders`) and keeps only `model_picker_enabled === true && policy.state !== "disabled"` models; copilot candidates absent from that set are dropped. Non-copilot providers are untouched.

**Fail-open:** any failure — no JWT, network error, non-2xx, malformed/empty body — leaves the static menu unchanged (routing never breaks). The result is cached per session (~20 min, model-ids only, never the JWT; host-pinned + no off-host redirect). When the live filter legitimately empties an all-Copilot menu, the `copilot-filtered` outcome explains it ("gated by your subscription tier — use /model") instead of the misleading "no credentialed models."

## Anthropic live availability (#538)

The third instance of the live-discovery pattern: pi's static registry keeps
**retired** Anthropic ids (e.g. `claude-3-haiku-20240307`), and with auth
configured they enter `getAvailable()` — the classifier then routes real turns
to models the API 404s (observed live: every simple-qa prompt on an
Anthropic-credentialed host picked the retired cheapest entry and failed).
Before building the menu, `anthropic-discovery.ts` queries the live
`GET /v1/models` endpoint (paginated; auth reuses whatever pi manages via
`getApiKeyAndHeaders` — `x-api-key` for API keys, `Bearer` + oauth beta header
for `sk-ant-oat…` tokens) and drops anthropic candidates absent from the
result. Non-anthropic providers are untouched.

**Fail-open (Copilot semantics, not the oMLX authoritative-empty):** any
failure — no credential, an auth grant `/v1/models` rejects, non-2xx,
malformed/oversized/empty body, network error — leaves the static menu
unchanged. Cached per session (~20 min, model-id strings only, never the
credential; host-pinned to `api.anthropic.com`, HTTPS-only, no off-host
redirect), cleared each `session_start`.

## oMLX live availability (#364)

The local-server analog of the Copilot filter: pi treats the registered omlx
model (#518) as available whenever its `!cat` apiKey is *configured* — the
command is never executed by the availability check — so a stopped server or
an unloaded model still looks routable. Before building the menu,
`shared/omlx-discovery.ts` (relocated in #534) probes `GET /v1/models` on the loopback base
(`OMLX_BASE_URL` override honored, non-loopback refused; bearer read at
request time from `OMLX_API_KEY` or `~/.omlx/api-key`, never stored or
logged; 60s TTL cache of model-id strings only, cleared each `session_start`).

Filtering happens **only on confirmed evidence**: a connection-level failure
(server down — the one case where, unlike the Copilot filter, an *empty* set
is authoritative and drops every omlx candidate) or a 200 response missing
the model's alias (not loaded). Everything ambiguous fails open — timeouts
(a saturated oMLX mid-prefill answers `/v1/models` slowly while being very
much alive), 401/5xx (the probe's key handling must never kill a candidate
pi's own request-time resolution might serve), malformed bodies. Non-omlx
candidates are never touched, and all filters (allowlist, Copilot, Anthropic,
oMLX) compose AND-wise.

## Deferred (post-v1)

- **Mid-loop escalation** (`turn_start` + `setModel`) — re-routing within a turn loop.
- **Indexing-bias policy** — lower the capability bar for prompts answerable via `search_codebase` retrieval (needs Workstream C / indexing live).

## Cost

One extra cheap-model round-trip per *novel* prompt (cached prompts cost nothing). Mitigated by a tight prompt, the cheap classifier model, and the decision cache.

## API provenance

Verified against **pi v0.80.2** (#573; originally validated against pi v0.79.0 in Phase 0 #328 and re-verified across the SDK bump): event lifecycle (`before_agent_start` → … → `before_provider_request`), `pi.setModel`/`registerCommand`/`registerFlag`, `ctx.modelRegistry.{getAvailable,getApiKeyAndHeaders,find}`, `model_select`, and pi-ai `complete()` (`examples/extensions/qna.ts`, `summarize.ts`, `handoff.ts`, `custom-compaction.ts`).

> **Note on pi-ai imports.** pi 0.80.x moved the request/response API (`complete`, `completeSimple`, `stream`, `getModel`, `getModels`, `getProviders`, `registerApiProvider`, `getEnvApiKey`, …) off the `@earendil-works/pi-ai` root entrypoint to `@earendil-works/pi-ai/compat`. Runtime is unaffected (the extension loader aliases root → compat as a strict superset), but source that typechecks against the published `.d.ts` must import from `/compat`. The compat entrypoint is officially supported; upstream has stated it will be removed in a future release with a migration guide — tracked as #577.

## Tests

```sh
./scripts/test-auto-router.sh          # node:test via tsx
VERBOSE=1 ./scripts/test-auto-router.sh
```

Unit tests use mocked `pi`/`ctx` and an injected `complete` so the parse/policy/fallback/cache logic runs offline. Live routing-quality validation is recorded in PR #342 via a probe run in a real pi session.
