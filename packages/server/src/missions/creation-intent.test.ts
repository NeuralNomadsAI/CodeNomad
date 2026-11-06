import assert from "node:assert/strict"
import test from "node:test"
import { MissionCreationIntents, MISSION_CREATION_INTENT_RETENTION_MS } from "./creation-intent"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { resolveMissionCreationDefaults } from "./profile-defaults"

function fixture() {
  const values = new Map<string, MissionJsonValue>()
  let now = Date.now()
  const storage: MissionStorage = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value, current) => { current?.(); values.set(key, structuredClone(value)) },
    remove: async key => { values.delete(key) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const rows = [...values].filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
      return { entries: rows.slice(0, limit).map(([key, value]) => ({ key, value })),
        ...(rows.length > limit ? { next: rows[limit - 1][0] } : {}) }
    },
  }
  return { values, storage, intents: new MissionCreationIntents(storage, "project", () => now), advance: (ms: number) => { now += ms } }
}
const request = { objective: "Prepare", template: "custom" as const }
const defaults = { request: {}, ...resolveMissionCreationDefaults({ ...request, preferences: [] }) }
const missing = async () => undefined

test("pre-dispatch intentions replay original whole choices across instances and refuse real request changes", async () => {
  const f = fixture()
  await f.intents.save("msn_first", request, defaults, missing, () => {}, "prepare-conflict")
  const changed = { request: {}, ...resolveMissionCreationDefaults({ ...request,
    preferences: [{ template: "all", profiles: { coordinator: { agent: "different" } } }] }) }
  const restarted = new MissionCreationIntents(f.storage, "project")
  assert.deepEqual(await restarted.save("msn_first", request, changed, missing, () => {}, "prepare-conflict"), defaults)
  const before = structuredClone([...f.values])
  for (const other of [{ ...request, objective: "Other" }, { ...request, profiles: {} }, { ...request, taskMode: "native" as const }]) {
    await assert.rejects(restarted.read("msn_first", other, missing, "prepare-conflict"), (error: any) => error.code === "prepare-conflict")
  }
  assert.deepEqual([...f.values], before)
})

test("lost intent acknowledgement retains the original data and guards run before publication", async () => {
  const f = fixture(), set = f.storage.set
  f.storage.set = async (...args) => { await set(...args); throw new Error("Acknowledgement lost") }
  await assert.rejects(f.intents.save("msn_lost", request, defaults, missing, () => {}, "request-conflict"), /Acknowledgement lost/)
  assert.deepEqual(await f.intents.read("msn_lost", request, missing, "request-conflict"), defaults)
  f.storage.set = set
  const before = structuredClone([...f.values])
  await assert.rejects(f.intents.save("msn_denied", request, defaults, missing, () => { throw new Error("Retired") }, "request-conflict"), /Retired/)
  assert.deepEqual([...f.values], before)
})

test("pending intentions are bounded and settled evidence releases its capacity place", async () => {
  const f = fixture()
  for (let index = 0; index < 128; index++) await f.intents.save(`msn_${index}`, request, defaults, missing, () => {}, "request-conflict")
  await assert.rejects(f.intents.save("msn_over", request, defaults, missing, () => {}, "request-conflict"), (error: any) => error.code === "creation-capacity")
  assert.equal(f.values.size, 128)
  await f.intents.settled("msn_0")
  await f.intents.save("msn_over", request, defaults, missing, () => {}, "request-conflict")
  assert.equal(f.values.size, 128)
})

test("damaged intent bytes stay intact and refuse before another preference read or write", async () => {
  const f = fixture()
  f.values.set("codenomad-missions/v2/creation-intents/project/msn_damaged", { version: 1 })
  const before = structuredClone([...f.values])
  await assert.rejects(f.intents.read("msn_damaged", request, missing, "request-conflict"),
    (error: any) => error.code === "invalid-journal")
  assert.deepEqual([...f.values], before)
})

test("uncertain choices expire without extending their lifetime on an identical retry", async () => {
  const f = fixture()
  for (let index = 0; index < 128; index++) await f.intents.save(`msn_${index}`, request, defaults, missing, () => {}, "request-conflict")
  f.advance(MISSION_CREATION_INTENT_RETENTION_MS - 1)
  assert.deepEqual(await f.intents.read("msn_0", request, missing, "request-conflict"), defaults)
  await f.intents.save("msn_0", request, defaults, missing, () => {}, "request-conflict")
  f.advance(2)
  await f.intents.save("msn_new", request, defaults, missing, () => {}, "request-conflict")
  assert.equal(f.values.size, 1)
  assert.equal(await f.intents.read("msn_0", request, missing, "request-conflict"), undefined)
})

test("settled choices release capacity on adapters without key removal", async () => {
  const f = fixture()
  f.storage.remove = undefined
  for (let index = 0; index < 150; index++) {
    await f.intents.save(`msn_${index}`, request, defaults, missing, () => {}, "request-conflict")
    await f.intents.settled(`msn_${index}`)
  }
  await f.intents.save("msn_new", request, defaults, missing, () => {}, "request-conflict")
  assert.equal([...f.values.values()].filter(value => value !== null).length, 1)
})

test("an un-timestamped valid intention gets one bounded retention window", async () => {
  const f = fixture()
  f.values.set("codenomad-missions/v2/creation-intents/project/msn_old", { version: 1, request, defaults } as unknown as MissionJsonValue)
  assert.deepEqual(await f.intents.read("msn_old", request, missing, "request-conflict"), defaults)
  f.advance(MISSION_CREATION_INTENT_RETENTION_MS)
  assert.equal(await f.intents.read("msn_old", request, missing, "request-conflict"), undefined)
})

test("failed choice cleanup cannot replace an authoritative success or refusal", async () => {
  const f = fixture(), remove = f.storage.remove, set = f.storage.set
  await f.intents.save("msn_done", request, defaults, missing, () => {}, "request-conflict")
  const before = structuredClone([...f.values])
  f.storage.remove = async () => { throw new Error("Removal unavailable") }
  f.storage.set = async (key, value, current) => { if (value === null) throw new Error("Clear unavailable"); await set(key, value, current) }
  await f.intents.settled("msn_done")
  assert.deepEqual([...f.values], before, "retention age is preserved while cleanup is unavailable")
  f.storage.remove = remove; f.storage.set = set
  await f.intents.settled("msn_done")
  assert.equal(f.values.size, 0)
})
