import assert from "node:assert/strict"
import test from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { MISSION_AUTHORITY_POLICY } from "../authority-protocol"
import { assembleCanonicalDurableMissionsHost } from "./factory"
import { fixture } from "./test-fixture"

// Real protected files/core/plugin/transport; injected native capability remains
// UNIT evidence, not proof of independent launch or cold OpenCode discovery.
async function running() {
  const f = await fixture()
  try {
    await f.create(); await f.action("adopt", {}); await f.action("lifecycle", { action: "start" })
    return f
  } catch (error) { await f.cleanup(); throw error }
}
const reload = (f: Awaited<ReturnType<typeof fixture>>) => assembleCanonicalDurableMissionsHost(f.deps, f.channel, f.files).authority

test("explicit restart restoration preserves accepted key/epoch/grant without a cookie, Play or native effect", async t => {
  const f = await running(); t.after(f.cleanup)
  const before = (await f.authority.read())!, raw = await f.files.read(), counts = { ...f.counts }
  let acquisitions = 0
  f.manager.getSharedServiceConnection = async () => { acquisitions++; throw new Error("restoration cannot acquire/start/provision") }
  f.expireHumanSession()
  const restored = reload(f)
  assert.equal((await restored.read())!.state, "staged")
  assert.deepEqual(await restored.readSigners(), [])
  const after = await restored.restore()
  assert.equal(after.state, "qualified"); assert.equal(after.revision, before.revision + 1)
  assert.deepEqual(after.binding, before.binding); assert.deepEqual(after.mirror, before.mirror)
  assert.equal(after.epoch, before.epoch); assert.equal(after.generation, before.generation)
  const changed = await f.files.read()
  assert.equal(changed!.privateKey, raw!.privateKey); assert.equal(changed!.publicKey, raw!.publicKey)
  assert.deepEqual({ ...changed, anchor: raw!.anchor, revision: raw!.revision }, raw)
  await restored.assertHostGrant(after.mirror!)
  assert.equal((await restored.readSigners()).length, 1)
  assert.deepEqual(f.counts, counts, "restoration reads no intent receipts and issues no effects")
  assert.equal(acquisitions, 0, "real native authority state/core/plugin root reads remain existing-only")
  await assert.rejects(restored.sign(f.request, { ...after.binding, version: 1, policy: MISSION_AUTHORITY_POLICY,
    epoch: after.epoch, expectedRevision: 1, requestID: "human-only", method: "revoke", payload: {} }, after.revision), /human-auth-required/)
})

test("prepared, adopted, paused, revoked and ambiguous decisions cannot acquire sends through restoration", async t => {
  for (const state of ["prepared", "adopted", "paused", "revoked", "pending"] as const) {
    const f = await fixture(); t.after(f.cleanup)
    await f.create()
    if (state !== "prepared") await f.action("adopt", {})
    if (state === "paused" || state === "revoked" || state === "pending") await f.action("lifecycle", { action: "start" })
    if (state === "paused") await f.action("lifecycle", { action: "pause" })
    if (state === "revoked") await f.authority.revoke(f.request, (await f.authority.read())!.revision)
    if (state === "pending") { f.failStop(); await assert.rejects(f.action("lifecycle", { action: "stop" })) }
    const before = await readFile(f.recordFile, "utf8"), counts = { ...f.counts }, restored = reload(f)
    await assert.rejects(restored.restore(), /restoration-blocked/)
    assert.equal(await readFile(f.recordFile, "utf8"), before)
    assert.deepEqual(f.counts, counts); assert.deepEqual(await restored.readSigners(), [])
  }
})

test("restart requalification loses authority on ownership, key generation or cancellation changes after preparation", async t => {
  for (const fault of ["claim", "generation", "cancel", "native"] as const) {
    const f = await running(); t.after(f.cleanup)
    const before = await readFile(f.recordFile, "utf8"), counts = { ...f.counts }, restored = reload(f)
    const controller = new AbortController()
    f.afterHandshake(async () => {
      if (fault === "claim") f.loseClaim()
      if (fault === "generation") await f.changeGeneration()
      if (fault === "cancel") controller.abort()
      if (fault === "native") f.loseNative()
    })
    await assert.rejects(restored.restore(controller.signal))
    if (fault !== "generation") assert.equal(await readFile(f.recordFile, "utf8"), before)
    assert.deepEqual(f.counts, counts)
    assert.throws(() => restored.assertManagedIncarnation(), /native-qualification-unavailable/)
  }
})

test("fresh native grant, pending control and exact actor placement must match the protected decision", async t => {
  for (const fault of ["grant", "pending", "moved", "identity", "changed"] as const) {
    const f = await running(); t.after(f.cleanup)
    const before = await readFile(f.recordFile, "utf8"), restored = reload(f), rpc = f.client.rpc
    let reads = 0
    f.client.rpc = (definition: { id: string }) => {
      const original = rpc(definition)
      return new Proxy(original, { get(target, method: string) {
        return async (input: unknown, options: unknown) => {
          const result = await target[method](input, options)
          if (definition.id !== "codenomad.missions.authority" || method !== "state") return result
          const changed = structuredClone(result)
          if (fault === "grant") changed.grant.epoch++
          if (fault === "pending") changed.pendingRequestIDs = ["uncertain-native-operation"]
          if (fault === "changed" && ++reads > 1) changed.grant.sendsEnabled = false
          return changed
        }
      } })
    }
    if (fault === "moved") f.sessions.get("ses_test_coordinator")!.location.directory += "/foreign"
    if (fault === "identity") f.sessions.get("ses_test_coordinator")!.id = "ses_substituted"
    await assert.rejects(restored.restore())
    assert.equal(await readFile(f.recordFile, "utf8"), before)
    assert.throws(() => restored.assertManagedIncarnation(), /native-qualification-unavailable/)
  }
})

test("same namespace/session IDs cannot restore a different or historically unknown daemon storage", async t => {
  for (const fault of ["replaced", "unknown"] as const) {
    const f = await running(); t.after(f.cleanup)
    const restored = reload(f)
    if (fault === "replaced") f.observationFault(value => { value.writer.daemonStorageID = "different-native-storage" })
    else {
      const record = JSON.parse(await readFile(f.recordFile, "utf8"))
      delete record.daemonStorageID
      await writeFile(f.recordFile, JSON.stringify(record))
    }
    const before = await readFile(f.recordFile, "utf8")
    await assert.rejects(restored.restore(), /native-storage-mismatch|restoration-blocked/)
    assert.equal(await readFile(f.recordFile, "utf8"), before)
    assert.deepEqual(await restored.readSigners(), [])
  }
})
