# Routing matrix lifecycle and JSON v1 reference

This is the operator contract for the capability matrix used by auto-router and
subagent policy. It applies both in this source repository and in the standalone
`pi-auto-router` mirror.

## Policy versus availability

`routing-matrix.json` is reviewed capability policy. Registry presence, live
provider responses, context size, price, and session errors are availability
evidence; none can grant capability or a quality tier.

The canonical policy path is:

- source repository: `agent/extensions/shared/routing-matrix.json`
- standalone mirror: `shared/routing-matrix.json` (a synchronized distribution
  copy)

No status, review, refresh, routing, or subagent path writes this file. A human
edits policy through source control and validation.

## Policy file v1

```jsonc
{
  "v": 1,
  "description": "optional informational prose ignored by routing",
  "lastReviewed": "YYYY-MM-DD",
  "staleAfterDays": 180,
  "refresh": { // optional human-authored audit metadata
    "at": "YYYY-MM-DDTHH:mm:ssZ",
    "tool": "tool or workflow name",
    "source": "evidence description",
    "inputsHash": "sha256:..." // optional
  },
  "models": {
    "provider/id": {
      "capable": ["simple-qa", "code-edit"],
      "tier": "frontier", // optional: frontier | capable | fast
      "rationale": "non-empty human-reviewed evidence"
    }
  }
}
```

The strict loader canonicalizes model and capability order. Structural failures
return no usable matrix; routing fails soft to non-matrix behavior. Diagnostics
use these stable codes:

| Code | Severity | Meaning |
|---|---|---|
| `missing` | error | Policy file is absent. |
| `unreadable` | error | Policy file cannot be read. |
| `invalid-json` | error | Contents are not JSON. |
| `unsupported-version` | error | `v` is not supported. |
| `invalid-schema` | error | Metadata or a row violates v1; row/field context is included where available. |
| `stale` | warning | Freshness age exceeds `staleAfterDays`; policy remains usable. |

Freshness uses `refresh.at` when present, otherwise `lastReviewed`.

## Commands and side effects

| Command | Registry/snapshot behavior | Mutation behavior |
|---|---|---|
| `/auto matrix status [--json]` | Builds the canonical snapshot on first use, then reuses it. | No policy write. It may resolve configured provider credentials while building evidence. |
| `/auto matrix review [--json]` | Peeks only at an existing frozen snapshot. If none exists, reports `not-built`; it never starts discovery. | No policy write, patch, apply mode, capability grant, or setting change. |
| `/auto matrix refresh [--retry-unavailable]` | Explicitly clears provider/snapshot/decision caches, reloads policy, and builds one replacement generation. Like first status, provider discovery may resolve configured credentials (including operator-defined `!command` resolvers). | Memory-only. Preserves session-unavailable models unless `--retry-unavailable` is supplied. Never writes policy. |
| `/auto matrix on` / `/auto matrix off` | Does not clear/replace evidence; the returned status may build the first snapshot. | Persists only the router's matrix-enabled setting and clears decision cache. |

Pi v0.80.6 has no documented extension API for a registry-only reload. After
editing `models.json`, open `/model` first, then run `/auto matrix refresh`.
Restarting the session also clears the process-local generation.

## Snapshot generation and hash

A snapshot records one registry read plus identical Copilot, Anthropic, and oMLX
filter evidence for parent and subagent policy.

- `generation` is a monotonically increasing process-local identity. It changes
  after an explicit clear even when evidence is unchanged.
- `hash` is SHA-256 over canonical registry candidates, provider filter states,
  and live candidates. It excludes creation time and generation, so equivalent
  evidence has the same hash.
- `createdAt` is audit display metadata, not part of the hash.
- Session-unavailable models (for example a routed 429) are a separate dynamic
  deny set and never mutate the snapshot or matrix.

## Status JSON v1

`/auto matrix status --json` emits an object with fixed root fields:

| Field | Contract |
|---|---|
| `v` | `1` |
| `enabled` | Whether matrix routing is enabled. |
| `matrix` | Discriminated by `state`: `not-loaded`, `error`, or `loaded`. Loaded includes version, row count, freshness source/age/threshold, optional refresh metadata, and diagnostics. |
| `availability` | Discriminated by `state`: `not-built`, `error`, or `loaded`. Loaded includes generation, hash, creation time, registry/live counts, and provider filters. Error uses only `snapshot-build-failed`. |
| `coverage` | `null` without both policy and snapshot; otherwise intersection/unlisted counts plus inert, dangling, and filtered rows. |
| `policy` | Effective local role, local preference, model/provider allowlists, and sorted session-unavailable IDs. |
| `registryReload` | Stable `/model`-before-refresh guidance. |

Coverage terms:

- **inert row:** its provider is absent from this host registry; it may be an
  intentional forward declaration.
- **dangling row:** its provider is present but the exact model ID is absent.
- **filtered row:** it exists in the static registry but verified live evidence
  excludes it.
- **unlisted model:** it exists in the registry but has no reviewed matrix row.

## Review JSON v1

`/auto matrix review --json` emits:

| Field | Contract |
|---|---|
| `v`, `kind` | `1`, `routing-matrix-review` |
| `evidenceHash` | SHA-256 over normalized policy rows (including full rationales), typed diagnostics, snapshot hash/state, and sorted session-unavailable IDs. It is an evidence identity, not a signature of rendered bytes. |
| `matrix`, `availability` | Typed states analogous to status. Review uses cached availability only. |
| `counts` | Full-input catalog, matrix, intersection, live, unlisted, inert, dangling, filtered, and unavailable counts. |
| `facts` | Canonically ordered bounded policy/registry/live/coverage/gap details and explicit omission counters. |
| `observations` | Deterministic classifications; observations are not policy decisions. |
| `proposals` | Human-action additions/changes/removals with required evidence; never an inferred patch. |
| `policyNotice` | Stable reminder that output is advisory and non-writing. |

Displayed detail arrays and verified provider ID lists are capped at 100 entries;
every capped collection has an omission count. Displayed rationales are capped
at 500 characters and per-row context claims at 100 values, each with explicit
truncation/omission metadata. Full normalized inputs still participate in the
snapshot/evidence hashes.

## Source-control review workflow

1. Open `/model` first if `models.json` changed.
2. Run explicit refresh when new evidence is desired.
3. Capture status/review JSON and its hashes.
4. Investigate proposals with provider identity, task-capability, quality, and
   rationale evidence.
5. Edit policy manually in a topic branch and submit a reviewed PR.
6. In the source repository, run:

   ```bash
   ./scripts/test-shared.sh
   ./scripts/test-auto-router.sh
   ./scripts/test-subagent.sh
   ./scripts/sync-mirror.sh --target pi-auto-router --dry-run
   ./scripts/validate.sh
   ```

Standalone users run the mirror package's own test/type-check scripts and should
report durable policy changes upstream because the mirror copy is replaced on
synchronization.
