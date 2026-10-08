import assert from "node:assert/strict"
import test from "node:test"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import type { MissionJsonValue } from "../../missions/model"
import { recurrenceConfigSchema } from "../../missions/recurrence-contract"

test("simple controls CAS desired state once, keep exact requests, and explicitly retry frozen partial targets", async () => {
  const values = new Map<string, MissionJsonValue>(), current = () => true as const
  const storage = { get: async (key: string) => structuredClone(values.get(key)),
    set: async (key: string, value: MissionJsonValue) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value: structuredClone(value) })) }) }
  const store = new NativeMissionRecurrenceStore(storage, "project", "/project")
  const selection = { agent: "worker", model: { providerID: "provider", id: "model" } }
  const config = recurrenceConfigSchema.parse({ title: "Review", consigne: "Review", template: "custom", taskMode: "native",
    clock: { time: "07:00", zone: "UTC" }, profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only", directory: "/project" }],
    watchedConversationIDs: [], profiles: { coordinator: selection, roles: { specialist: selection } } })
  const profile = { profileID: "profile", executionHost: "local", configYamlPath: "/project/config.yaml" }
  let doc = await store.create("schedule_one", config, 1, current)
  assert.equal(doc.state, "paused")
  const play = { requestID: "play_one", expectedRevision: doc.revision, action: "play" as const }
  doc = await store.beginControl(doc.id, play, current, profile)
  assert.equal(doc.state, "running")
  assert.deepEqual(await store.beginControl(doc.id, play, current, profile), doc, "same request is not another CAS")
  await assert.rejects(store.beginControl(doc.id, { ...play, action: "stop" }, current), /request conflict/)
  doc = await store.recordControl(doc.id, { ...doc.controls[0], targetsKnown: true, controlsComplete: true }, current)
  const pause = { requestID: "pause_one", expectedRevision: doc.revision, action: "pause" as const }
  doc = await store.beginControl(doc.id, pause, current)
  assert.equal(doc.state, "paused")
  const partial = { ...doc.controls.at(-1)!, targetsKnown: true, schedulerCancellation: "acknowledged" as const,
    targets: [{ sessionID: "session_one", outcome: "acknowledged" as const }, { sessionID: "session_two", outcome: "unknown" as const }] }
  doc = await store.recordControl(doc.id, partial, current)
  await assert.rejects(store.beginControl(doc.id, { requestID: "play_two", expectedRevision: doc.revision, action: "play" }, current), /control conflict/)
  const retry = await store.beginControl(doc.id, pause, current)
  assert.deepEqual(retry.controls.at(-1)!.targets, partial.targets)
  await assert.rejects(store.recordControl(doc.id, { ...partial, targets: [] }, current), /targets changed/)
  doc = await store.recordControl(doc.id, { ...partial, controlsComplete: true,
    targets: partial.targets.map(target => ({ ...target, outcome: "acknowledged" as const })) }, current)
  doc = await store.reserveManual(doc.id, "manual_one", doc.revision, 2, profile, current)
  assert(doc.pending)
  doc = await store.beginControl(doc.id, { requestID: "resume_one", expectedRevision: doc.revision, action: "resume" }, current, profile)
  assert.equal(doc.state, "running", "pending unknown passage permits reconcile-only Resume")
  assert.equal(doc.pending!.passage.due.kind, "manual")
})
