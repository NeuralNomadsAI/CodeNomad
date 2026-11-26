import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { MissionConfiguration } from "../../missions/launch-policy"
import type { MissionDocument } from "../../missions/mission-document"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionJsonValue } from "../../missions/model"
import { compactNativeMissionDocumentDeletion } from "./native-mission-schedule-deletion"
import { reconcileNativeMissionScheduleMaintenance } from "./native-mission-schedule-wake-maintenance"
import { receiveNativeMissionScheduleWake } from "./native-mission-schedule-wake-rpc"
import { nativeSchedulePreflight } from "./native-mission-schedule-preflight"
import { nativeScheduleWakeKey } from "./native-schedule-transport-contract"

const selection = { agent: "worker", model: { providerID: "unit", id: "model" } }
const config: MissionConfiguration = {
  title: "Scheduled sync", objective: "Sync", template: "custom", taskMode: "native",
  profiles: { coordinator: selection, roles: { specialist: selection } },
  profileID: "profile", executionHost: "host",
  roots: [{ mode: "directory-only", directory: "/project" }], watchedConversationIDs: [],
  launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } },
}
const bothCalendars = (auxSession: string, auxSchedule: string) => [
  { role: "reconciliation" as const, slot: 0, timeGeneration: 1, sessionID: auxSession, scheduleID: auxSchedule, highWater: 0, pendingWake: null, wakePreparing: null },
  { role: "principal" as const, slot: 0, timeGeneration: 1, sessionID: "ses_prin", scheduleID: "aut_prin", highWater: 0, pendingWake: null, wakePreparing: null },
]

const current = () => true as const

async function createStore() {
  const values = new Map<string, MissionJsonValue>()
  const store = new NativeMissionDocumentStore({
    get: async key => structuredClone(values.get(key)),
    compareAndSet: async (key, value, _rev, guard) => { guard(); values.set(key, structuredClone(value)) },
  }, "project", "/project")
  const ctx = {
    storage: {
      get: (key: string) => Effect.sync(() => structuredClone(values.get(key))),
      scan: () => Effect.sync(() => ({ entries: [] })),
      set: (key: string, value: unknown) => Effect.sync(() => { values.set(key, structuredClone(value as MissionJsonValue)) }),
    },
  } as unknown as Plugin.Context
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)
  return { store, ctx, run }
}

test("compactNativeMissionDocumentDeletion compacts a cleaned deleting schedule (including ended-without-report) and preserves original deletion identity", async () => {
  const { store, ctx, run } = await createStore()
  let doc = await store.create("msn_cleanup", config, 1000, current)
  doc = await store.change(doc.id, doc.revision, current, value => {
    value.blocked = "ended-without-report"
    changes.requestDeletion(value, "req_orig_delete", 1001, { expectedRevision: 0, deleteManagedSessions: false })
    value.synchronization = null
    value.calendars = []
  })
  const result = await compactNativeMissionDocumentDeletion(ctx, store, doc.id, run, current)
  assert.deepEqual(result, { compacted: true, managedOrReleasePending: false })
  const tombstone = await store.read(doc.id)
  assert.ok(tombstone && "deletedAt" in tombstone)
  assert.equal(tombstone.requestID, "req_orig_delete")
  assert.equal(tombstone.expectedRevision, 0)
  assert.equal(tombstone.deleteManagedSessions, false)
})

test("compactNativeMissionDocumentDeletion holds off while managed sessions, releases, unknown block or slots remain", async () => {
  for (const kind of ["managed", "unknown", "release"] as const) {
    const { store, ctx, run } = await createStore()
    const doc = await store.create(`msn_hold_${kind}`, config, 1000, current)
    await store.change(doc.id, doc.revision, current, value => {
      if (kind === "managed") {
        changes.play(value, "sync_m", 1000, [])
        changes.synchronized(value, "sync_m", bothCalendars("ses_aux_m", "aut_aux_m"))
        changes.reserve(value, { kind: "manual", requestID: "man_1" }, 1000, [])
        changes.admitted(value, value.pending!.id, 1000)
        changes.settle(value, value.pending!.id, "completed", 1000)
        value.calendars = []
      }
      if (kind === "unknown") value.blocked = "unknown"
      if (kind === "release") value.coordinatorReleases = [{ id: "psg_1", missionID: "msn_1", coordinatorSessionID: "ses_1" }]
      changes.requestDeletion(value, `req_${kind}`, 1001, { expectedRevision: 0, deleteManagedSessions: kind === "managed" })
      value.synchronization = null
    })
    const result = await compactNativeMissionDocumentDeletion(ctx, store, doc.id, run, current)
    assert.equal(result.compacted, false, kind)
    assert.equal(result.managedOrReleasePending, kind === "managed" || kind === "release", kind)
    const after = await store.read(doc.id)
    assert.ok(after && !("deletedAt" in after), kind)
  }
})

test("reconcileNativeMissionScheduleMaintenance compacts only when deleting cleanup finishes", async () => {
  const retiredSlot = { role: "reconciliation" as const, slot: 0, timeGeneration: 1, sessionID: "ses_aux",
    name: "cm_aux", when: { type: "every" as const, every: "60000 millis", tz: "UTC" }, endsAt: null,
    creation: "adopted" as const, scheduleID: "aut_aux", ambiguous: [] }
  const deletingDoc = {
    id: "msn_maint", state: "stopped", pending: null, deletion: { requestID: "del_1", expectedRevision: 1, deleteManagedSessions: false, requestedAt: 1 },
    calendarOwner: { operation: { pending: true }, slots: [], retired: [{ descriptor: retiredSlot, highWater: 1, scheduleRemoved: false, sessionRemoved: false, indexRemoved: false }] },
  } as unknown as MissionDocument
  const cleanedDoc = { ...deletingDoc, calendarOwner: { operation: { pending: false }, slots: [], retired: [] } } as unknown as MissionDocument
  let compacted = 0
  const finished = await reconcileNativeMissionScheduleMaintenance(deletingDoc, "ses_aux", async () => true, async () => cleanedDoc, async () => { compacted++ })
  assert.deepEqual(finished, { complete: true })
  assert.equal(compacted, 1)
  const stillPending = await reconcileNativeMissionScheduleMaintenance(deletingDoc, "ses_aux", async () => true, async () => deletingDoc, async () => { compacted++ })
  assert.deepEqual(stillPending, { complete: false })
  assert.equal(compacted, 1)
  const stoppedOnly = { ...cleanedDoc, deletion: null } as unknown as MissionDocument
  await reconcileNativeMissionScheduleMaintenance({ ...deletingDoc, deletion: null } as unknown as MissionDocument, "ses_aux", async () => true, async () => stoppedOnly, async () => { compacted++ })
  assert.equal(compacted, 1)
  // A compaction that cannot finish yet leaves the completed cleanup complete.
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(deletingDoc, "ses_aux", async () => true, async () => cleanedDoc,
    async () => { throw new Error("cleanup-pending") }), { complete: true })
})

test("reconcileNativeMissionScheduleMaintenance settles a pending owner operation on a live schedule without requiring quietness", async () => {
  const liveSlot = { role: "reconciliation" as const, slot: 0, timeGeneration: 1, sessionID: "ses_aux",
    name: "cm_aux", when: { type: "every" as const, every: "60000 millis", tz: "UTC" }, endsAt: null,
    creation: "adopted" as const, scheduleID: "aut_aux", ambiguous: [] }
  const livePending = {
    id: "msn_live_op", state: "running", pending: null, deletion: null,
    calendarOwner: { operation: { pending: true, action: "check" }, slots: [liveSlot], retired: [] },
  } as unknown as MissionDocument
  const liveSettled = { ...livePending, calendarOwner: { operation: { pending: false, action: "check" }, slots: [liveSlot], retired: [] } } as unknown as MissionDocument
  let quietChecked = 0
  let reconciled = 0
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(livePending, "ses_aux", async () => { quietChecked++; return false },
    async () => { reconciled++; return liveSettled }), { complete: true })
  assert.equal(quietChecked, 0)
  assert.equal(reconciled, 1)
  // Already settled live schedule does nothing.
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(liveSettled, "ses_aux", async () => false,
    async () => { reconciled++; return liveSettled }), { complete: false })
  assert.equal(reconciled, 1)
  // Unsettled owner operation reports incomplete.
  assert.deepEqual(await reconcileNativeMissionScheduleMaintenance(livePending, "ses_aux", async () => false,
    async () => livePending), { complete: false })
})

for (const failing of [false, true]) test(`receiveNativeMissionScheduleWake replies applied for a completed deleting schedule, ${failing ? "also when it cannot be compacted yet" : "which it compacts"}`, async () => {
  const { store, ctx, run } = await createStore()
  const wake = { missionID: "msn_wake_del", generation: 1, scheduleID: "aut_aux", run: 1, sessionID: "ses_aux", messageID: "msg_aut_aux_1" }
  const incarnation = { id: "inc_1", pid: process.pid, url: "http://127.0.0.1:1" }
  let doc = await store.create(wake.missionID, config, 1000, current)
  doc = await store.change(doc.id, doc.revision, current, value => {
    changes.play(value, "sync_wake", 1000, [])
    changes.synchronized(value, "sync_wake", bothCalendars(wake.sessionID, wake.scheduleID))
    changes.requestDeletion(value, "req_wake_del", 1001, { expectedRevision: 0, deleteManagedSessions: false })
  })
  let claim: { version: 1; key: string; wake: typeof wake; incarnation: typeof incarnation; settled?: { revision: number; highWater: number } } = {
    version: 1, key: nativeScheduleWakeKey(wake), wake, incarnation,
  }
  const reply = await receiveNativeMissionScheduleWake("wake", {
    registrationFile: "/service.json", incarnation, wake, preflight: nativeSchedulePreflight(wake, incarnation.id, 1002),
  }, { current, signal: new AbortController().signal }, {
    store,
    owner: {
      adoptAuxiliary: async () => doc,
      reconcile: async () => store.change(wake.missionID, (await store.read(wake.missionID) as MissionDocument).revision, current, value => {
        value.calendars = []; value.synchronization = null
      }),
    },
    runtime: { preflight: async () => ({ messagePresent: true, ready: true, cutoff: 1002 }), wake: async () => "idle", reconcile: async () => "idle" },
    read: async () => {
      const latest = await store.read(wake.missionID) as MissionDocument
      return { binding: { document: latest, calendar: latest.calendars[0]! } as never, wake: { scheduleID: wake.scheduleID, run: 1, messageID: wake.messageID, dueAt: 1002 } }
    },
    claim: async () => claim,
    close: async locked => {
      const latest = await locked.read(wake.missionID) as MissionDocument
      claim = { ...claim, settled: { revision: latest.revision, highWater: 1 } }
      return true
    },
    compact: failing ? async () => { throw new Error("cleanup-pending") }
      : () => compactNativeMissionDocumentDeletion(ctx, store, wake.missionID, run, current).then(() => undefined),
  })
  assert.equal(reply.state, "applied")
  const tombstone = await store.read(wake.missionID)
  assert.equal(Boolean(tombstone && "deletedAt" in tombstone), !failing)
  if (tombstone && "deletedAt" in tombstone) assert.equal(tombstone.requestID, "req_wake_del")
})
