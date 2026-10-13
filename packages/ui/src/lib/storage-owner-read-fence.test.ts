import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { serverEvents } from "./server-events"
import { ServerStorage, ConfigOwnerReconciliationPendingError } from "./storage"

const originalFetch = serverApi.fetchConfigOwner, originalPatch = serverApi.patchConfigOwner, originalMissionPatch = serverApi.patchMissionPreferences
afterEach(() => { serverApi.fetchConfigOwner = originalFetch; serverApi.patchConfigOwner = originalPatch; serverApi.patchMissionPreferences = originalMissionPatch })
const dispatch = (event: WorkspaceEventPayload) => (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch([event])
function holdFetch() {
  let release!: (owner: Record<string, unknown>) => void
  serverApi.fetchConfigOwner = <T extends Record<string, unknown>>() => new Promise<T>(resolve => { release = owner => resolve(owner as T) })
  return (owner: Record<string, unknown>) => release(owner)
}

test("an old initial GET never replaces a newer owned configuration event", async () => {
  const release = holdFetch(), storage = new ServerStorage(), published: unknown[] = []
  storage.onConfigOwnerChanged("ui", owner => published.push(owner))
  const read = storage.loadConfigOwner("ui"), fresh = { settings: { missionModels: [{ id: "fresh" }] } }
  dispatch({ type: "storage.configChanged", owner: "ui", value: fresh })
  release({ settings: { missionModels: [] } })
  assert.deepEqual(await read, fresh)
  assert.deepEqual(published, [fresh])
  assert.deepEqual(await storage.loadConfigOwner("ui"), fresh)
})

test("a completed older display GET cannot supersede an intervening successful owner write", async () => {
  const release = holdFetch(), storage = new ServerStorage(), fresh = { settings: { missionModels: [{ id: "written" }] } }
  const read = storage.loadConfigOwner("ui")
  serverApi.patchConfigOwner = async <T extends Record<string, unknown>>() => fresh as unknown as T
  await storage.patchConfigOwner("ui", { settings: fresh.settings })
  release({ settings: { missionModels: [] } })
  assert.deepEqual(await read, fresh)
  assert.deepEqual(await storage.loadConfigOwner("ui"), fresh)
})

test("full-document invalidation during a read fails closed rather than publishing a stale owner", async () => {
  const release = holdFetch(), storage = new ServerStorage()
  const read = storage.loadConfigOwner("ui")
  dispatch({ type: "storage.configChanged", owner: "*", value: {} })
  release({ settings: { missionModels: [] } })
  await assert.rejects(read, /changed during read/)
})

test("owner read failures and malformed responses are not cached as successful empty owners", async () => {
  const storage = new ServerStorage()
  serverApi.fetchConfigOwner = async () => { throw new Error("Unreadable configuration") }
  await assert.rejects(storage.loadConfigOwner("ui"), /Unreadable/)
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => undefined as unknown as T
  await assert.rejects(storage.loadConfigOwner("ui"), /Invalid configuration owner/)
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => ({}) as T
  assert.deepEqual(await storage.loadConfigOwner("ui"), {})
})

test("a delayed successful conditional ACK returns the newer SSE owner without rolling its profile or unrelated fields back", async () => {
  const storage = new ServerStorage(), published: unknown[] = []
  storage.onConfigOwnerChanged("ui", owner => published.push(owner))
  let acknowledge!: (owner: Record<string, unknown>) => void
  serverApi.patchMissionPreferences = <T extends Record<string, unknown>>() => new Promise<T>(resolve => { acknowledge = owner => resolve(owner as T) })
  const write = storage.patchMissionPreferences({ settings: { missionProfileDefaults: [] } }, [{ key: "missionProfileDefaults", present: false }])
  const newer = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "newer" } } }], unrelated: "newer-window-value" } }
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => newer as unknown as T
  dispatch({ type: "storage.configChanged", owner: "ui", value: newer })
  acknowledge({ settings: { missionProfileDefaults: [], unrelated: "older-window-value" } })
  assert.deepEqual(await write, newer, "certified success still resolves, but with the current snapshot")
  assert.deepEqual(published, [newer])
  assert.deepEqual(await storage.loadConfigOwner("ui"), newer)
})

test("ordinary owner PATCH ACKs are fenced against newer successful owner writes as well", async () => {
  const storage = new ServerStorage()
  let acknowledge!: (owner: Record<string, unknown>) => void
  serverApi.patchConfigOwner = <T extends Record<string, unknown>>() => new Promise<T>(resolve => { acknowledge = owner => resolve(owner as T) })
  const olderWrite = storage.patchConfigOwner("ui", { settings: { missionModels: [] } })
  const newer = { settings: { missionModels: [{ id: "newer" }], unrelated: true } }
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => newer as unknown as T
  serverApi.patchConfigOwner = async <T extends Record<string, unknown>>() => newer as unknown as T
  await storage.patchConfigOwner("ui", { settings: newer.settings })
  acknowledge({ settings: { missionModels: [] } })
  assert.deepEqual(await olderWrite, newer)
  assert.deepEqual(await storage.loadConfigOwner("ui"), newer)
})

test("an earlier unrelated SSE during a later successful write cannot replace the accepted profile: a fresh GET reconciles ordering", async () => {
  const storage = new ServerStorage()
  let acknowledge!: (owner: Record<string, unknown>) => void, writes = 0, reads = 0
  serverApi.patchMissionPreferences = <T extends Record<string, unknown>>() => { writes++; return new Promise<T>(resolve => { acknowledge = owner => resolve(owner as T) }) }
  const earlier = { settings: { missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "earlier" } } }], unrelated: "preserve" } }
  const accepted = { settings: { ...earlier.settings, missionProfileDefaults: [{ template: "custom", profiles: { coordinator: { agent: "accepted" } } }] } }
  const write = storage.patchMissionPreferences({ settings: { missionProfileDefaults: accepted.settings.missionProfileDefaults } }, [{ key: "missionProfileDefaults", present: false }])
  dispatch({ type: "storage.configChanged", owner: "ui", value: earlier })
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => { reads++; return accepted as unknown as T }
  acknowledge(accepted)
  assert.deepEqual(await write, accepted)
  assert.deepEqual(await storage.loadConfigOwner("ui"), accepted)
  assert.equal(writes, 1); assert.equal(reads, 1)
})

test("continuous invalidation yields a typed reconciliation-pending error after three strict reads, without mutation replay", async () => {
  const storage = new ServerStorage()
  let writes = 0, reads = 0
  const old = { settings: { missionModels: [] } }, accepted = { settings: { missionModels: [{ id: "accepted" }] } }
  serverApi.patchMissionPreferences = async <T extends Record<string, unknown>>() => {
    writes++; dispatch({ type: "storage.configChanged", owner: "ui", value: old }); return accepted as unknown as T
  }
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => {
    reads++; dispatch({ type: "storage.configChanged", owner: "ui", value: old }); return accepted as unknown as T
  }
  await assert.rejects(storage.patchMissionPreferences({ settings: accepted.settings }, [{ key: "missionModels", present: false }]), error => {
    assert.ok(error instanceof ConfigOwnerReconciliationPendingError)
    assert.equal(error.owner, "ui"); assert.equal(error.mutationCommitted, true)
    return true
  })
  assert.equal(writes, 1); assert.equal(reads, 3)
  // Only an explicit stable fresh read can restore an ordered snapshot.
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => accepted as unknown as T
  assert.deepEqual(await storage.revalidateUiConfigOwner(), accepted)
  assert.equal(writes, 1)
})

test("strict reconciliation retries an invalidated response without substituting the old display cache", async () => {
  const storage = new ServerStorage()
  const old = { settings: { missionModels: [] } }, accepted = { settings: { missionModels: [{ id: "accepted" }] } }
  let reads = 0
  serverApi.patchMissionPreferences = async <T extends Record<string, unknown>>() => {
    dispatch({ type: "storage.configChanged", owner: "ui", value: old }); return accepted as unknown as T
  }
  serverApi.fetchConfigOwner = async <T extends Record<string, unknown>>() => {
    if (++reads === 1) dispatch({ type: "storage.configChanged", owner: "ui", value: old })
    return accepted as unknown as T
  }
  assert.deepEqual(await storage.patchMissionPreferences({ settings: accepted.settings }, [{ key: "missionModels", present: false }]), accepted)
  assert.equal(reads, 2)
})
