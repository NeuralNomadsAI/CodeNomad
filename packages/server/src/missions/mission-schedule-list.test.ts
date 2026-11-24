import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import { NativeMissionDocumentStore } from "./mission-document-store"
import { readMissionSchedulePage } from "./mission-schedule-list"
import { missionScheduleRpcMethods } from "./mission-schedule-contract"
import { missionDocumentChanges as changes } from "./mission-document-state"
import type { MissionConfiguration } from "./launch-policy"
import type { MissionJsonValue } from "./model"

async function fixture() {
  const values = new Map<string, MissionJsonValue>(), scans: unknown[] = [], project = { id: "project", canonical: "/project" }
  const current = () => true as const
  const store = new NativeMissionDocumentStore({ get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, _revision, guard) => { guard(); values.set(key, structuredClone(value)) } }, project.id, project.canonical)
  const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
  const config: MissionConfiguration = { title: "Review", objective: "Review sources", template: "custom", taskMode: "native",
    profiles: { coordinator: selection, roles: { specialist: selection } }, profileID: "profile", executionHost: "host",
    roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
    launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: 3 } } }
  const storage = { scan: async (input: { prefix: string; after?: string; limit?: number }) => {
    scans.push(input)
    const all = [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([key]) => key.startsWith(input.prefix) && (!input.after || key > input.after))
    const entries = all.slice(0, input.limit).map(([key, value]) => ({ key, value: structuredClone(value) }))
    return { entries, ...(all.length > entries.length ? { next: entries.at(-1)!.key } : {}) }
  } }
  return { values, store, config, current, project, storage, scans }
}

test("one bounded key-ordered page advances across tombstones and never reads other projects", async () => {
  const f = await fixture()
  for (const id of ["schedule_a", "schedule_b", "schedule_c"]) await f.store.create(id, f.config, 1000, f.current)
  let doc = await f.store.change("schedule_b", 0, f.current, doc => changes.requestDeletion(doc, "delete_b", 1001))
  doc = await f.store.change(doc.id, doc.revision, f.current, doc => { doc.synchronization = null })
  await f.store.compact(doc.id, doc.revision, 1002, f.current)
  f.values.set("codenomad-missions/documents-v1/project/foreign/missions/foreign_doc", {} as MissionJsonValue)
  const before = structuredClone([...f.values])
  const first = await readMissionSchedulePage(f.storage, f.project, { limit: 2 })
  assert.deepEqual(first.schedules.map(item => item.id), ["schedule_a"])
  assert.equal(first.next, "schedule_b")
  const last = await readMissionSchedulePage(f.storage, f.project, { after: first.next, limit: 2 })
  assert.deepEqual(last.schedules.map(item => item.id), ["schedule_c"])
  assert.equal(last.next, undefined)
  assert.equal(f.scans.length, 2)
  assert.deepEqual([...f.values], before)
  const validate = new Ajv().compile(missionScheduleRpcMethods.scheduleList.output)
  assert.equal(validate(first), true, JSON.stringify(validate.errors))
  assert.equal(first.schedules[0].kind, "schedule")
})

test("invalid input, foreign identities, page overflow/order/cursor corruption fail closed", async () => {
  const f = await fixture()
  await f.store.create("schedule_a", f.config, 1000, f.current)
  for (const input of [{ limit: 0 }, { limit: 9 }, { after: "../outside" }, { unknown: true }])
    await assert.rejects(readMissionSchedulePage(f.storage, f.project, input))
  assert.equal(f.scans.length, 0)
  const page = await f.storage.scan({ prefix: "codenomad-missions/documents-v1/project/", limit: 8 })
  const entry = page.entries[0]
  for (const bad of [
    { entries: [entry, entry] }, { entries: [entry], next: "foreign" }, { entries: [], next: entry.key },
    { entries: [{ ...entry, key: "outside" }] },
    { entries: [{ ...entry, value: { ...entry.value as object, projectID: "foreign" } }] },
    { entries: Array(9).fill(entry) },
  ]) await assert.rejects(readMissionSchedulePage({ scan: async () => bad }, f.project, {}))
})

test("list/detail projection retains frozen result identities and durable counters without internal runtime data", async () => {
  const f = await fixture()
  await f.store.create("schedule_a", f.config, 1000, f.current)
  await f.store.change("schedule_a", 0, f.current, doc => {
    // The manual passage is independent of the calendar's native schedule rows.
    doc.firstPlayedAt = 1000; doc.state = "running"
    changes.reserve(doc, { kind: "manual", requestID: "manual_original" }, 1001, [])
    changes.admitted(doc, doc.pending!.id, 1002)
    changes.settle(doc, doc.pending!.id, "completed", 1003)
  })
  const page = await readMissionSchedulePage(f.storage, f.project, {})
  const row = page.schedules[0]
  assert.equal(row.launchedCount, 1); assert.equal(row.successfulCount, 1); assert.equal(row.settledCount, 1)
  assert.equal(row.history[0].origin.kind, "manual")
  assert.deepEqual(row.latestResult, row.history[0]); assert.equal(row.pendingPassage, null)
  assert.equal(row.remaining, 2)
  assert.doesNotMatch(JSON.stringify(page), /registrationFile|sha256|configYamlPath|checkpoints|fingerprint/)
  const validate = new Ajv().compile(missionScheduleRpcMethods.scheduleList.output)
  assert.equal(validate(page), true, JSON.stringify(validate.errors))
})
