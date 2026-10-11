import assert from "node:assert/strict"
import test from "node:test"
import Ajv from "ajv"
import type { MissionStorage } from "./journal"
import type { MissionJsonValue } from "./model"
import { CODENOMAD_MISSIONS_RPC } from "./rpc"
import { recurrenceProofExpired } from "./recurrence-control-proof"
import { NativeMissionRecurrenceStore } from "./recurrence-store"

const current = () => true as const
const execution = { agent: "worker", model: { providerID: "provider", id: "model" } }
async function fixture(name: string) {
  const values = new Map<string, MissionJsonValue>()
  const storage: MissionStorage = { get: async key => structuredClone(values.get(key)),
    set: async (key, value, fence) => { fence?.(); values.set(key, structuredClone(value)) }, scan: async () => ({ entries: [] }) }
  const store = new NativeMissionRecurrenceStore(storage, `project_${name}`, "/project")
  await store.create("schedule", { title: "Review", template: "custom", consigne: "Review.", clock: { time: "07:00", zone: "UTC" },
    profileID: "profile", executionHost: "local", profiles: { coordinator: execution, roles: { specialist: execution } },
    taskMode: "native", roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [] }, 1, current)
  return { store, values }
}

test("only a proof this clock already expired counts; future-dated or fresh issue times never do", () => {
  assert.equal(recurrenceProofExpired(1_000, 31_000), true)
  assert.equal(recurrenceProofExpired(1_000, 30_999), false)
  assert.equal(recurrenceProofExpired(60_000, 1_000), false, "future-dated may become fresh")
  assert.equal(recurrenceProofExpired(Number.NaN, 1e12), false)
})

test("an unrecorded request is retired only with an expired proof, then never records in this host", async () => {
  const { store } = await fixture("retire")
  const play = { requestID: "play_lost", action: "play" as const, expectedRevision: 0 }
  assert.equal((await store.refusal("schedule", play))?.reason, undefined, "no proof time: unknown")
  assert.equal((await store.refusal("schedule", play, 10_000, () => 39_999))?.reason, undefined, "still fresh: unknown")
  assert.equal((await store.refusal("schedule", play, 10_000, () => 40_000))?.reason, "control-conflict")
  assert.equal((await store.refusal("schedule", play))?.reason, "control-conflict", "retired identities stay refused")
  await assert.rejects(store.beginControl("schedule", play, current))
  assert.equal((await store.read("schedule"))!.revision, 0)
  // Run now: the same serialized retirement fences its reservation CAS.
  const run = { requestID: "run_lost", action: "run-now" as const, expectedRevision: 0 }
  assert.equal((await store.refusal("schedule", run, 10_000, () => 40_000))?.reason, "control-conflict")
  await assert.rejects(store.reserveManual("schedule", "run_lost", 0, 2, { profileID: "profile", executionHost: "local", configYamlPath: "/c.yml" }, current))
  // A recorded request is never retired.
  const stop = { requestID: "stop_done", action: "stop" as const, expectedRevision: 0 }
  await store.beginControl("schedule", stop, current)
  assert.equal((await store.refusal("schedule", stop, 10_000, () => 40_000))?.reason, undefined)
})

test("a request whose record may have been evicted is never retired by proof expiry", async () => {
  const { store, values } = await fixture("evicted")
  const [key, raw] = [...values.entries()][0]!
  values.set(key, { ...(raw as Record<string, MissionJsonValue>), revision: 5, evictedControlRevision: 5 })
  const result = await store.refusal("schedule", { requestID: "play_old", action: "play", expectedRevision: 2 }, 10_000, () => 40_000)
  assert.ok(result); assert.equal(result.reason, undefined)
})

test("native status inputs accept only an integer proof hint", () => {
  const ajv = new Ajv(), methods = CODENOMAD_MISSIONS_RPC.methods
  const control = ajv.compile(methods.recurrenceControlStatus.input), manual = ajv.compile(methods.recurrenceRunNowStatus.input)
  const input = { scheduleID: "schedule", requestID: "request", expectedRevision: 0 }
  assert.equal(control({ ...input, action: "play", issuedAt: 1 }), true)
  assert.equal(control({ ...input, action: "play", issuedAt: "1" }), false)
  assert.equal(manual({ ...input, issuedAt: 1 }), true)
  assert.equal(manual({ ...input, issuedAt: -1 }), false)
  const output = ajv.compile(methods.recurrenceRunNowStatus.output)
  assert.equal(output({ ...input, issuedAt: 1, version: 1, projectID: "p", projectCanonical: "/p", location: { directory: "/p" },
    outcome: "unknown", passageID: null, messageID: null, admission: null }), false, "the hint is input only")
})
