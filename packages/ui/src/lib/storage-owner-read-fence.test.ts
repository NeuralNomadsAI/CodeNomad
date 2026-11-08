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

test("replacement owner authority separates flights and fences late reads and ACKs on the same storage", async () => {
  for (const family of ["config", "state"] as const) {
    const releases: ((value: Record<string, unknown>) => void)[] = []
    const delayed = <T>() => new Promise<T>(resolve => releases.push(value => resolve(value as T)))
    const storage = new ServerStorage({ api: { ...serverApi,
      fetchConfigOwner: delayed, fetchStateOwner: delayed,
      patchConfigOwner: delayed, patchStateOwner: delayed, patchMissionPreferences: delayed,
    }, events: { on: () => () => {} } })
    const first = new AbortController(), second = new AbortController()
    storage.bindOwnerAuthority(first.signal)
    const load = () => family === "config" ? storage.loadConfigOwner("ui") : storage.loadStateOwner("ui")
    const patch = () => family === "config" ? storage.patchConfigOwner("ui", {}) : storage.patchStateOwner("ui", {})
    const oldRead = assert.rejects(load(), /revoked storage authority/)
    const oldWrite = assert.rejects(patch(), /revoked storage authority/)
    const oldMission = family === "config" ? assert.rejects(storage.patchMissionPreferences({}, []), /revoked storage authority/) : undefined
    first.abort()
    storage.bindOwnerAuthority(second.signal)
    const newRead = load()
    const published: unknown[] = []
    const off = family === "config" ? storage.onConfigOwnerChanged("ui", value => published.push(value))
      : storage.onStateOwnerChanged("ui", value => published.push(value))
    releases[0]({ stale: "read" })
    releases[1]({ stale: "write" })
    if (oldMission) releases[2]({ stale: "mission" })
    await Promise.all([oldRead, oldWrite, oldMission])
    const joined = load()
    assert.equal(releases.length, family === "config" ? 4 : 3, "old flight cleanup preserves the replacement's coalesced read")
    releases.at(-1)!({ fresh: true })
    assert.deepEqual(await newRead, { fresh: true })
    assert.deepEqual(await joined, { fresh: true })
    assert.deepEqual(await load(), { fresh: true })
    assert.deepEqual(published, [{ fresh: true }])
    off(); second.abort()
  }
})

test("replacement barriers cover each owner write family, release failures and keep documents independent", async () => {
  for (const family of ["config", "state", "mission"] as const) for (const failure of [false, true]) {
    let release!: () => void, writes = 0, reads = 0
    const wait = new Promise<void>(resolve => { release = resolve })
    const delayed = async <T>() => {
      writes++
      if (writes === 1) { await wait; if (failure) throw new Error("write failed") }
      return { fresh: true } as T
    }
    const read = async <T>() => { reads++; return { fresh: true } as T }
    const storage = new ServerStorage({ api: { ...serverApi, fetchConfigOwner: read, fetchStateOwner: read,
      patchConfigOwner: delayed, patchStateOwner: delayed, patchMissionPreferences: delayed,
    }, events: { on: () => () => {} } })
    const first = new AbortController(), second = new AbortController()
    storage.bindOwnerAuthority(first.signal)
    const patch = () => family === "state" ? storage.patchStateOwner("ui", {})
      : family === "mission" ? storage.patchMissionPreferences({}, []) : storage.patchConfigOwner("ui", {})
    const old = assert.rejects(patch(), failure ? /write failed/ : /revoked storage authority/)
    first.abort(); storage.bindOwnerAuthority(second.signal)
    const loading = family === "state" ? storage.loadStateOwner("ui") : storage.revalidateUiConfigOwner()
    const editing = patch()
    await storage.loadConfigOwner("independent")
    assert.equal(reads, 1, "another document does not wait")
    assert.equal(writes, 1, "direct writes also wait for the previous attachment")
    release(); await Promise.all([old, loading, editing])
    assert.equal(writes, 2)
    assert.ok(reads >= 2)
  }
})

test("a hung owner write bounds replacement waiting and stays fenced until settlement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let release!: () => void, reads = 0, writes = 0
  const wait = new Promise<void>(resolve => { release = resolve })
  const storage = new ServerStorage({ api: { ...serverApi,
    fetchStateOwner: async <T>() => { reads++; return { fresh: true } as T },
    patchStateOwner: async <T>() => { writes++; await wait; return {} as T },
  }, events: { on: () => () => {} } })
  const first = new AbortController(), second = new AbortController()
  storage.bindOwnerAuthority(first.signal)
  const old = assert.rejects(storage.patchStateOwner("ui", {}), /revoked storage authority/)
  first.abort(); storage.bindOwnerAuthority(second.signal)
  const loading = assert.rejects(storage.loadStateOwner("ui"), /write pending/)
  const editing = assert.rejects(storage.patchStateOwner("ui", {}), /write pending/)
  t.mock.timers.tick(10_000)
  await Promise.all([loading, editing])
  assert.equal(reads, 0)
  assert.equal(writes, 1, "timeout never dispatches a replacement write")
  const retry = assert.rejects(storage.loadStateOwner("ui"), /write pending/)
  t.mock.timers.tick(10_000); await retry
  release(); await old
  assert.deepEqual(await storage.loadStateOwner("ui"), { fresh: true })
})

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
