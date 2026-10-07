import assert from "node:assert/strict"
import test from "node:test"
import { readFile, writeFile } from "node:fs/promises"
import { ProtectedHostAuthority } from "./store"
import { fixture } from "./test-fixture"
import type { NativeGrantObservation } from "./registry"
import { authorityDigest, MISSION_AUTHORITY_POLICY } from "../authority-protocol"
import { controlOperationID } from "../receipt-identity"
import { HostAuthorityAdmissions } from "./qualification"

async function running() {
  const f = await fixture()
  try { await f.prepare(); await f.execute(await f.body("adopt", {})); await f.execute(await f.body("lifecycle", { action: "start" })); return f }
  catch (error) { await f.cleanup(); throw error }
}
const observation = (grant: NativeGrantObservation["grant"]): NativeGrantObservation => ({
  grant, revision: 2, terminal: null, pendingRequestIDs: [], status: "active", runState: "running", controlPending: false,
  control: { id: controlOperationID(grant!.missionID, "unit-play"), missionID: grant!.missionID, requestID: "unit-play", action: "start",
    expectedRevision: 1, completedRevision: 2, pending: [], targets: [{ sessionID: grant!.coordinatorSessionID,
      location: { directory: grant!.roots[0].directory } }] },
})

test("unknown historical identity cannot be filled by update/recover or rotation; adoption keeps sends disabled until Play", async t => {
  const f = await running(); t.after(f.cleanup)
  const saved = (await f.host.read())!
  const raw = JSON.parse(await readFile(f.recordFile, "utf8")); delete raw.daemonStorageID
  await writeFile(f.recordFile, JSON.stringify(raw))
  const host = new ProtectedHostAuthority(f.files, f.admissions), before = await readFile(f.recordFile, "utf8")
  const body = (method: string, payload: unknown, epoch = saved.epoch) => ({ ...saved.binding, version: 1,
    policy: MISSION_AUTHORITY_POLICY, requestID: `explicit-${method}`, expectedRevision: 2, epoch, method, payload })
  for (const [method, payload] of [["update", { objective: "changed" }], ["recover", { target: "coordinator" }]] as const) {
    await assert.rejects(host.sign(f.request, body(method, payload), raw.revision), /native-storage-mismatch/)
    assert.equal(await readFile(f.recordFile, "utf8"), before)
  }
  // Original trusted human operation remains explicit; it cannot silently revive
  // the old epoch. The ordinary native adoption path disables sends.
  const adoption = body("adopt", {}, saved.epoch + 1)
  const signed = await f.host.sign(f.request, adoption, raw.revision)
  const operation = await f.core.execute(signed, { apply: async () => { throw new Error("adoption is metadata only") } }, new AbortController().signal)
  const native = await f.core.state(f.target.missionID)
  f.setObservation({ operation, revision: 2, terminal: native.terminal, pendingRequestIDs: native.pendingRequestIDs })
  await f.host.accept(f.request, authorityDigest(adoption), raw.revision + 1)
  assert.equal((await f.host.read())!.mirror!.sendsEnabled, false)
  await assert.rejects(f.host.assertHostGrant((await f.host.read())!.mirror!), /host-grant-disabled/)
  await f.execute(await f.body("revoke", {}))
  const revoked = await f.host.revoke(f.request, (await f.host.read())!.revision)
  const document = JSON.parse(await readFile(f.recordFile, "utf8"))
  delete document.daemonStorageID
  await writeFile(f.recordFile, JSON.stringify(document))
  await assert.rejects(host.prepare(f.request, f.target, revoked.revision), /native-storage-mismatch/)
})

test("losing concurrent restoration cannot erase the winning attempt's qualified lease", async t => {
  const f = await running(); t.after(f.cleanup)
  const losingSignal = new AbortController().signal
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const host = new ProtectedHostAuthority(f.files, f.admissions, {
    read: async () => { throw new Error("not a human completion") },
    restore: async (grant, signal) => { if (signal === losingSignal) { entered(); await held }; return observation(grant) },
  })
  const losing = host.restore(losingSignal)
  const rejected = assert.rejects(losing, /revision-conflict|restoration-changed/)
  await waiting
  const winning = await host.restore()
  release(); await rejected
  assert.equal(host.assertManagedIncarnation(), true)
  await host.assertHostGrant(winning.mirror!)
})

test("cancelled read-only qualification releases observation without a late anchor publication", async t => {
  for (const stage of ["discovery", "handshake"] as const) {
    const f = await running(); t.after(f.cleanup)
    const controller = new AbortController()
    let entered!: () => void, finish!: () => void, observedSignal: AbortSignal | undefined
    const enteredRead = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { finish = resolve })
    if (stage === "discovery") {
      const original = f.nativeBridge.readDiscoveryBoundary
      f.nativeBridge.readDiscoveryBoundary = async signal => { observedSignal = signal; entered(); await held; return original(signal) }
    } else {
      const original = f.nativeBridge.handshake
      f.nativeBridge.handshake = async (input, signal) => { observedSignal = signal; entered(); await held; return original(input, signal) }
    }
    const before = await readFile(f.recordFile, "utf8")
    const host = new ProtectedHostAuthority(f.files, f.admissions, { read: async () => { throw new Error("unused") }, restore: async grant => observation(grant) })
    const attempt = host.restore(controller.signal), denied = assert.rejects(attempt, /native-observation-unavailable|AbortError/)
    await enteredRead; controller.abort(); await denied
    assert.equal(observedSignal!.aborted, true)
    assert.equal(await readFile(f.recordFile, "utf8"), before)
    finish(); await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(await readFile(f.recordFile, "utf8"), before)
    assert.deepEqual(await host.readSigners(), [])
  }
})

test("restoration never falls back to ordinary effect-bearing ownership acquisition", async t => {
  const f = await running(); t.after(f.cleanup)
  let ordinary = 0
  const admissions = new HostAuthorityAdmissions({ isAuthEnabled: () => true, getSessionFromRequest: () => null }, {
    async withOwned() { ordinary++; throw new Error("ordinary acquisition forbidden") },
  }, f.descriptor, f.nativeBridge)
  const host = new ProtectedHostAuthority(f.files, admissions, {
    read: async () => { throw new Error("unused") }, restore: async grant => observation(grant),
  })
  const before = await readFile(f.recordFile, "utf8")
  await assert.rejects(host.restore(), /existing-ownership-unavailable/)
  assert.equal(ordinary, 0); assert.equal(await readFile(f.recordFile, "utf8"), before)
})
