import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { OpenCodeServerConnections } from "./connections"
import { OpenCodeServerRegistry } from "./registry"
import { OpenCodeServerCredentials } from "./credentials"

function fixture() {
  let profiles: any[] = [{ kind: "explicit", id: "A", label: "A", origin: "http://127.0.0.1:1" }]
  const registry = new OpenCodeServerRegistry(() => profiles, next => { profiles = next })
  const credentials = new OpenCodeServerCredentials({ profileKey: "test", configIdentity: "test" }, registry)
  const forbidden = () => { throw new Error("native IO forbidden") }
  const owner = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  return { owner, registry, credentials }
}

test("reservation receipts cover pre-publication, publication, disconnect, release and attach/detach ABA without IO", async t => {
  const { owner } = fixture(); t.after(() => owner.dispose())
  const empty = owner.attachmentReservations("A")
  assert.equal(empty.status, "complete")
  assert.deepEqual(empty.reservations, [])
  const lease = owner.retainProject({ serverId: "A", directory: "Z:\\Case\\Opaque/ " })
  assert.equal(owner.attachmentReceiptCurrent(empty.receipt), false)
  const pending = owner.attachmentReservations("A")
  assert.equal(pending.inFlight, true)
  assert.equal(pending.reservations[0]!.directory, "Z:\\Case\\Opaque/ ")
  const instanceId = randomUUID()
  lease.published(instanceId)
  assert.equal(owner.attachmentReceiptCurrent(pending.receipt), false)
  const published = owner.attachmentReservations("A")
  assert.equal(published.reservations[0]!.state, "published")
  assert.equal(published.reservations[0]!.instanceId, instanceId)
  ;(published.reservations[0] as any).directory = "/forged"
  assert.equal(owner.attachmentReservations("A").reservations[0]!.directory, "Z:\\Case\\Opaque/ ")
  owner.disconnect("A")
  assert.equal(owner.attachmentReceiptCurrent(published.receipt), false)
  assert.equal(owner.attachmentReservations("A").reservations.length, 1)
  lease.release(); lease.release()
  const zero = owner.attachmentReservations("A")
  assert.equal(zero.reservations.length, 0)
  const second = owner.retainProject({ serverId: "A", directory: "/same" }); second.release()
  assert.equal(owner.attachmentReceiptCurrent(zero.receipt), false)
  assert.notEqual(owner.attachmentReservations("A").receipt, zero.receipt)
})

test("reservation snapshots are bounded and closed/replaced owners cannot validate an old receipt", async t => {
  const { owner, registry } = fixture(); t.after(() => owner.dispose())
  const old = owner.attachmentReservations("A")
  registry.replace([{ kind: "explicit", id: "A", label: "changed", origin: "http://127.0.0.1:1" }])
  assert.equal(owner.attachmentReceiptCurrent(old.receipt), false)
  const leases = Array.from({ length: 513 }, () => owner.retainProject({ serverId: "A", directory: "/same" }))
  const bounded = owner.attachmentReservations("A")
  assert.equal(bounded.status, "unknown")
  assert.equal(bounded.reservations.length, 512)
  assert.equal(new Set(bounded.reservations.map(value => value.reservationId)).size, 512)
  for (const lease of leases) lease.release()
  const fresh = owner.attachmentReservations("A")
  assert.equal(fresh.status, "complete")
  assert.equal(owner.attachmentReceiptCurrent(fresh.receipt), true)
  await owner.dispose()
  assert.equal(owner.attachmentReceiptCurrent(fresh.receipt), false)
  assert.equal(owner.attachmentReservations("A").status, "unknown")
})
