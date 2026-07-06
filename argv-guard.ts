/**
 * auto-router/argv-guard.ts — explicit `--model` precedence guard (#519).
 *
 * The router's enable state is disk-global and extensions load in every pi
 * invocation, including subagent children spawned with an explicit frontmatter
 * pin as `--model` (ADR-0076). Without a guard, an enabled router inside such
 * a process would `pi.setModel()` straight over the operator's (or the
 * spawning extension's) explicit choice. An explicit argv `--model` therefore
 * wins unconditionally — over the persisted `/auto on` state AND over an
 * explicit same-invocation `--auto`. "A child spawned with --model is never
 * re-routed" admits no exception; carving one out for --auto would be the
 * loophole a future spawn-path change silently falls through.
 *
 * Detection mirrors pi's own parser exactly (cli/args.ts): the flag is the
 * literal two-token form `--model <value>` — no `=` form, no short alias —
 * and a trailing `--model` with no value is ignored by pi, so it is ignored
 * here too. `--models` (scoped Ctrl+P cycling) is a different exact token and
 * never matches. argv is immutable per process, so the result is computed
 * once at extension load; resumed sessions have no `--model` on argv and are
 * deliberately not guarded (pi persists no "how was the model chosen"
 * provenance — recorded as an accepted gap in ADR-0076).
 */

/** True when pi will consume an explicit `--model <value>` from this argv. */
export function hasExplicitModelFlag(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg, i) => arg === "--model" && i < argv.length - 1);
}
