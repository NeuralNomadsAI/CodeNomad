import assert from "node:assert/strict"
import { test } from "node:test"
import { createMissionStore, type MissionDisplayResponse } from "./mission-store"
import { createMissionPanelInventory } from "./mission-panel-inventory"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve }
}
const response = (projectID: string): MissionDisplayResponse => ({ available: true, version: 1, projectID,
  generatedAt: 1, discardedEvents: 0, missions: [], activity: { generatedAt: 1, missions: [] } })

for (const retire of ["clear", "invalidateTasks"] as const)
test(`${retire} admits a new same-attachment read and old settlement preserves its busy owner`, async () => {
  const reads = [deferred<MissionDisplayResponse>(), deferred<MissionDisplayResponse>()]
  const attachment = new AbortController()
  let calls = 0
  const store = createMissionStore(() => reads[calls++].promise, undefined, false, () => attachment.signal)
  const old = store.refresh("east~workspace")
  store[retire]("east~workspace")
  const replacement = store.refresh("east~workspace")
  assert.equal(calls, 2)
  reads[0].resolve(response("obsolete")); await old
  assert.equal(store.state("east~workspace").status, "loading")
  assert.equal(store.state("east~workspace").projectID, undefined)
  reads[1].resolve(response("current")); await replacement
  assert.equal(store.state("east~workspace").status, "ready")
  assert.equal(store.state("east~workspace").projectID, "current")
  assert.equal(calls, 2, "old settlement starts no trailing read")
})

for (const replacement of ["attachment", "invalidation"] as const)
test(`panel ${replacement} admits fresh lanes before obsolete lanes settle`, async () => {
  let attachment = new AbortController()
  const reads: { reject(error: Error): void }[] = []
  const store = createMissionPanelInventory({ scope: () => "east-project", signal: () => attachment.signal,
    tasks: async () => { throw new Error("unexpected tasks") },
    read: () => new Promise((_resolve, reject) => { reads.push({ reject }) }) })
  try {
    store.setDemand("east~workspace", true)
    const old = store.ensure("east~workspace")
    await new Promise<void>(resolve => setImmediate(resolve))
    const count = reads.length
    assert.ok(count > 0)
    if (replacement === "attachment") { attachment.abort(); attachment = new AbortController() }
    else store.invalidateTasks("east~workspace")
    const fresh = store.refresh("east~workspace")
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(reads.length, count * 2, "replacement never waits for revoked pending lanes")
    for (const read of reads.slice(0, count)) read.reject(new Error("obsolete"))
    await old
    assert.equal(store.reading("east~workspace"), true, "old finally cannot clear replacement loading")
    for (const read of reads.slice(count)) read.reject(new Error("current"))
    await fresh
    assert.equal(store.reading("east~workspace"), false)
    assert.match(store.state("east~workspace").error!, /current/)
  } finally { store.clear("east~workspace") }
})
