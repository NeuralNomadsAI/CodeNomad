import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginControlsSnapshot } from "../api-types"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { NativeMutationUncertainError } from "./native-mutation-authority"
import { PluginPackages } from "./plugin-packages"

const location = { directory: "/host/checkout" }
const target = "@example/integration@^1"
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const snapshot: PluginControlsSnapshot = { location: { directory: "/canonical/checkout" },
    runtime: [{ key: "plugin", id: "example.integration", source: { type: "package", target }, features: {}, state: { status: "active" } }],
    configured: { rules: [], sources: [] }, controls: [], targets: [] }
  const calls: unknown[][] = []
  const hooks = { connect: async () => {}, read: async () => {}, owns: async () => {}, update: async () => {}, revalidate: async () => {} }
  let refusal = "", connectionChanged = false, owned = true
  const authority = { revalidate: async () => { await hooks.revalidate(); authority.assertCurrent() },
    assertCurrent: () => { if (refusal) throw new Error(refusal) } }
  const client = { plugin: { update: async (...args: unknown[]) => { calls.push(args); await hooks.update() } } }
  const connection = { client, assertCurrent: () => { if (connectionChanged) throw new Error("connection changed") } } as unknown as ServiceConnection
  const controls = { read: async () => { await hooks.read(); return snapshot } }
  const workspaceManager = {
    getSharedServiceConnection: async () => { await hooks.connect(); return connection },
    ownsLocation: async (_w: string, l: unknown, c: unknown) => {
      assert.deepEqual(l, snapshot.location); assert.equal(c, client); await hooks.owns(); return owned
    },
  }
  const service = new PluginPackages({ controls, workspaceManager })
  const controller = new AbortController()
  return { service, snapshot, calls, hooks, authority, controller,
    revoke: (reason: string) => { refusal = reason }, disconnect: () => { connectionChanged = true }, disown: () => { owned = false },
    update: (authorized = true, t = target, l = location) => service.update("workspace", l, t, controller.signal, authorized ? authority : undefined) }
}

for (const authorized of [true, false]) test(`exact runtime target dispatches once, authority=${authorized}`, async () => {
  const f = fixture(); await f.update(authorized)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], [{ location: f.snapshot.location, targets: [target] }, { signal: f.controller.signal }])
})

for (const invalid of ["unknown", "example.integration", "./local", "file:/local", "opencode.builtin", "-id", "*", "bad\nname", "", " https://example.com/x.tgz"])
  test(`refuses invalid or non-inventory target ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(); await assert.rejects(f.update(true, invalid)); assert.equal(f.calls.length, 0)
  })

test("refuses local/builtin sources, missing targets and private location selectors", async () => {
  for (const source of [{ type: "local", path: target }, { type: "builtin" }, { type: "sdk" }, { type: "package", target: "other" }] as const) {
    const f = fixture(); f.snapshot.runtime[0]!.source = source
    await assert.rejects(f.update()); assert.equal(f.calls.length, 0)
  }
  for (const l of [{ ...location, workspaceID: "private" }, { directory: "" }, { directory: "bad\0path" }]) {
    const f = fixture(); await assert.rejects(f.update(true, target, l)); assert.equal(f.calls.length, 0)
  }
  const f = fixture(); f.snapshot.location = { ...location, workspaceID: "private" }
  await assert.rejects(f.update()); assert.equal(f.calls.length, 0)
})

for (const reason of ["revoked", "expired", "session moved", "digest changed", "stale mount"])
  for (const stage of ["before", "connect", "read", "owns", "revalidate"] as const)
    test(`${reason} ${stage} refuses before dispatch`, async () => {
      const f = fixture()
      if (stage === "before") f.revoke(reason)
      else f.hooks[stage] = async () => { await Promise.resolve(); f.revoke(reason) }
      await assert.rejects(f.update(), new RegExp(reason)); assert.equal(f.calls.length, 0)
    })

for (const stage of ["connect", "read", "owns"] as const) test(`connection changes during ${stage}`, async () => {
  const f = fixture(); f.hooks[stage] = async () => { await Promise.resolve(); f.disconnect() }
  await assert.rejects(f.update()); assert.equal(f.calls.length, 0)
})

test("ownership refusal and final synchronous authority fence prevent dispatch", async () => {
  const f = fixture(); f.disown(); await assert.rejects(f.update()); assert.equal(f.calls.length, 0)
  const g = fixture(); let validations = 0
  g.hooks.revalidate = async () => { if (++validations === 4) queueMicrotask(() => g.revoke("stale mount")) }
  await assert.rejects(g.update()); assert.equal(g.calls.length, 0)
})

for (const stage of ["connect", "read", "owns", "revalidate"] as const) test(`abort bounds ignored ${stage} and prevents late dispatch`, async () => {
  const f = fixture(), gate = deferred(), entered = deferred()
  f.hooks[stage] = async () => { entered.resolve(); await gate.promise }
  const pending = f.update(); await entered.promise
  const rejected = assert.rejects(pending, error => !(error instanceof NativeMutationUncertainError))
  f.controller.abort(); await rejected; gate.resolve()
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0)
})

for (const mode of ["revoke", "abort", "failure", "connection"] as const) test(`post-dispatch ${mode} is uncertain without replay`, async () => {
  const f = fixture()
  f.hooks.update = async () => {
    if (mode === "revoke") f.revoke("revoked")
    if (mode === "connection") f.disconnect()
    if (mode === "abort") { f.controller.abort(); await new Promise(() => {}) }
    if (mode === "failure") throw new Error("native failed")
  }
  await assert.rejects(f.update(), NativeMutationUncertainError); assert.equal(f.calls.length, 1)
})

test("ordinary callers retain native failure and abort reasons", async () => {
  const f = fixture(), native = new Error("native failed")
  f.hooks.update = async () => { throw native }; await assert.rejects(f.update(false), error => error === native)
  const g = fixture(), aborted = new Error("cancelled")
  g.hooks.update = async () => { g.controller.abort(aborted); await new Promise(() => {}) }
  await assert.rejects(g.update(false), error => error === aborted)
  assert.equal(f.calls.length, 1); assert.equal(g.calls.length, 1)
})

test("ordinary call without signal or authority preserves the native contract", async () => {
  const f = fixture(); await f.service.update("workspace", location, target)
  assert.deepEqual(f.calls, [[{ location: f.snapshot.location, targets: [target] }, {}]])
})

test("already-aborted calls and malformed runtime inventories never dispatch", async () => {
  const f = fixture(); f.controller.abort(); await assert.rejects(f.update()); assert.equal(f.calls.length, 0)
  const g = fixture(); g.snapshot.runtime = [null as never]
  await assert.rejects(g.update()); assert.equal(g.calls.length, 0)
})

test("post-reply asynchronous authority refresh failure is uncertain", async () => {
  const f = fixture()
  f.hooks.update = async () => { f.hooks.revalidate = async () => { await Promise.resolve(); throw new Error("session moved") } }
  await assert.rejects(f.update(), NativeMutationUncertainError); assert.equal(f.calls.length, 1)
})
