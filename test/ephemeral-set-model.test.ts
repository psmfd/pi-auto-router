/**
 * Tests for ephemeral-set-model.ts (#533, ADR-0096).
 *
 * Behavior tests use the _setProtoResolverForTest seam with a fake prototype
 * standing in for SettingsManager.prototype. The final test imports the REAL
 * pinned @earendil-works/pi-coding-agent so an extension-deps bump that
 * renames/removes setDefaultModelAndProvider fails the suite (the helper
 * would otherwise silently fall open and resume clobbering the default).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { _setProtoResolverForTest, setModelEphemeral } from "../ephemeral-set-model.ts";

type PersistFn = (this: unknown, ...args: unknown[]) => unknown;
type FakeProto = { setDefaultModelAndProvider?: PersistFn };

/** A fake pi whose setModel invokes the persist hook the way AgentSession does. */
function fakePi(proto: FakeProto, opts?: { result?: boolean; throwOnSet?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    pi: {
      async setModel(model: string): Promise<boolean> {
        calls.push(model);
        if (opts?.throwOnSet) throw new Error("setModel exploded");
        proto.setDefaultModelAndProvider?.("provider", model);
        return opts?.result ?? true;
      },
    },
  };
}

test("suppresses persistence during setModel and restores the method after", async () => {
  const persisted: string[] = [];
  const original: PersistFn = (...args) => {
    persisted.push(String(args[1]));
  };
  const proto: FakeProto = { setDefaultModelAndProvider: original };
  const restore = _setProtoResolverForTest(async () => proto);
  try {
    const { pi, calls } = fakePi(proto);
    const ok = await setModelEphemeral(pi, "routed-model");
    assert.equal(ok, true);
    assert.deepEqual(calls, ["routed-model"]);
    assert.deepEqual(persisted, [], "routed setModel must not persist the default");
    assert.equal(proto.setDefaultModelAndProvider, original, "method restored after the call");
    // A direct call after restoration persists again (manual /model path).
    proto.setDefaultModelAndProvider?.("provider", "manual-model");
    assert.deepEqual(persisted, ["manual-model"]);
  } finally {
    _setProtoResolverForTest(restore);
  }
});

test("restores the method even when setModel throws", async () => {
  const original: PersistFn = () => {};
  const proto: FakeProto = { setDefaultModelAndProvider: original };
  const restore = _setProtoResolverForTest(async () => proto);
  try {
    const { pi } = fakePi(proto, { throwOnSet: true });
    await assert.rejects(() => setModelEphemeral(pi, "boom"), /setModel exploded/);
    assert.equal(proto.setDefaultModelAndProvider, original);
  } finally {
    _setProtoResolverForTest(restore);
  }
});

test("propagates a false (no-credential) result", async () => {
  const proto: FakeProto = { setDefaultModelAndProvider: () => {} };
  const restore = _setProtoResolverForTest(async () => proto);
  try {
    const { pi } = fakePi(proto, { result: false });
    assert.equal(await setModelEphemeral(pi, "m"), false);
  } finally {
    _setProtoResolverForTest(restore);
  }
});

test("falls open to plain setModel when the prototype cannot be resolved", async () => {
  const restore = _setProtoResolverForTest(async () => undefined);
  try {
    const calls: string[] = [];
    const pi = {
      async setModel(model: string): Promise<boolean> {
        calls.push(model);
        return true;
      },
    };
    assert.equal(await setModelEphemeral(pi, "m"), true);
    assert.deepEqual(calls, ["m"]);
  } finally {
    _setProtoResolverForTest(restore);
  }
});

test("falls open when the persist method is missing from the prototype", async () => {
  const restore = _setProtoResolverForTest(async () => ({}));
  try {
    const { pi, calls } = fakePi({});
    assert.equal(await setModelEphemeral(pi, "m"), true);
    assert.deepEqual(calls, ["m"]);
  } finally {
    _setProtoResolverForTest(restore);
  }
});

test("drift alarm: pinned pi-coding-agent still exposes SettingsManager.prototype.setDefaultModelAndProvider", async () => {
  const mod = (await import("@earendil-works/pi-coding-agent")) as {
    SettingsManager?: { prototype?: FakeProto };
  };
  assert.equal(
    typeof mod.SettingsManager?.prototype?.setDefaultModelAndProvider,
    "function",
    "upstream shape drifted — ephemeral-set-model.ts would silently fall open; re-verify #533 against the new pin (see ADR-0096 retirement trigger)",
  );
});
