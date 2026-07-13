/**
 * ephemeral-set-model.ts — route a model change WITHOUT persisting it as the
 * user's global default (#533, ADR-0096).
 *
 * pi's extension-facing `pi.setModel()` delegates to `AgentSession.setModel()`,
 * which unconditionally calls `settingsManager.setDefaultModelAndProvider()` —
 * writing the routed model into `~/.pi/agent/settings.json` as the persisted
 * global default. auto-router switches models on essentially every turn, so
 * every route silently clobbered the operator's deliberate `/model` choice.
 *
 * Upstream has agreed direction but no shipped fix (earendil-works/pi#5263;
 * PR #5270 auto-closed unmerged), and the psmfd/pi mirror's zero-divergence
 * policy (ADR-0041) restricts source patches to manifest-tracked SECURITY
 * fixes — a behavioral patch is out of policy. So the suppression lives here,
 * in the extension, and is surgical: `SettingsManager.prototype
 * .setDefaultModelAndProvider` is swapped for a no-op only for the duration of
 * the router's own `pi.setModel()` await, then restored in `finally`. The
 * user's manual `/model` picks keep persisting exactly as upstream intends.
 *
 * Why this works: pi's extension loader maps `@earendil-works/pi-coding-agent`
 * to the bundled live module (virtualModules in binary mode, jiti aliases in
 * dev — core/extensions/loader.ts), so the prototype this module patches IS
 * the one pi's own AgentSession uses.
 *
 * Known window: `AgentSession.setModel()` persists synchronously before its
 * awaited emit, but the RPC hop means a user `/model` landing inside the
 * router's await could have its persistence suppressed once (session model
 * still applies; only the settings.json write is skipped). Microtask-scale,
 * accepted in ADR-0096.
 *
 * Fail posture: if the import or method shape ever drifts (upstream rename),
 * fall OPEN to plain `pi.setModel()` — behavior is then no worse than before
 * this fix. The drift test in test/ephemeral-set-model.test.ts imports the
 * real pinned package so an extension-deps bump that breaks the shape fails
 * the suite instead of silently reverting to clobbering.
 *
 * RETIREMENT: when upstream ships the persist opt-out (earendil-works/pi#5263)
 * and the runtime pin advances past it, route through the first-class option
 * and delete this module. Tracked in pi_config (see ADR-0096).
 */

type PersistFn = (this: unknown, ...args: unknown[]) => unknown;
type SettingsProto = { setDefaultModelAndProvider?: PersistFn };

async function resolveSettingsProto(): Promise<SettingsProto | undefined> {
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as {
      SettingsManager?: { prototype?: SettingsProto };
    };
    return mod.SettingsManager?.prototype;
  } catch {
    return undefined;
  }
}

let protoResolver: () => Promise<SettingsProto | undefined> = resolveSettingsProto;

/** Test seam: substitute the prototype source. Returns the previous resolver. */
export function _setProtoResolverForTest(
  resolver: () => Promise<SettingsProto | undefined>,
): () => Promise<SettingsProto | undefined> {
  const prev = protoResolver;
  protoResolver = resolver;
  return prev;
}

/**
 * Call `pi.setModel(model)` with global-default persistence suppressed.
 * Falls open (persisting, as before #533) when the SettingsManager shape
 * cannot be resolved.
 */
export async function setModelEphemeral<M>(
  pi: { setModel(model: M): Promise<boolean> },
  model: M,
): Promise<boolean> {
  const proto = await protoResolver();
  const original = proto?.setDefaultModelAndProvider;
  if (proto === undefined || typeof original !== "function") {
    return pi.setModel(model);
  }
  proto.setDefaultModelAndProvider = function noopPersist() {};
  try {
    return await pi.setModel(model);
  } finally {
    proto.setDefaultModelAndProvider = original;
  }
}
