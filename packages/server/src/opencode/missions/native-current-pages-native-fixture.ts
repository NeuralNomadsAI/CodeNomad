// Trusted seeds only, loaded by the isolated current-display qualification script.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { MissionControl } from "../../missions/control"
import type { MissionStorage } from "../../missions/journal"
import type { NativeMissionSession } from "../../missions/control-types"
import { readNativeRecurrenceCurrent, readNativeRecurrenceCurrentPage, readNativeRecurrenceCurrentContent } from "./native-recurrence-current"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"

const method = { input: { type: "object" }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.current-display-qualification", methods: { seed: method }, events: {} })
const reads = Rpc.define({ id: CODENOMAD_MISSIONS_RPC.id, methods: {
  recurrenceCurrent: CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrent,
  recurrenceCurrentPage: CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrentPage,
  recurrenceCurrentContent: CODENOMAD_MISSIONS_RPC.methods.recurrenceCurrentContent,
}, events: {} })
export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  yield* ctx.rpc.register(reads, {
    recurrenceCurrent: input => readNativeRecurrenceCurrent(ctx, input).pipe(Effect.orDie),
    recurrenceCurrentPage: input => readNativeRecurrenceCurrentPage(ctx, input).pipe(Effect.orDie),
    recurrenceCurrentContent: input => readNativeRecurrenceCurrentContent(ctx, input).pipe(Effect.orDie),
  })
  yield* ctx.rpc.register(definition, {
    seed: () => Effect.gen(function* () {
      const graph = yield* Effect.context<never>(), run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
      const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
        set: async (key, value) => { await run(ctx.storage.set(key, value)) }, scan: input => run(ctx.storage.scan(input)) as ReturnType<MissionStorage["scan"]> }
      return yield* Effect.promise(async () => {
        const current = () => true as const, now = Date.now(), project = ctx.location.project
        const selection = { agent: "build", model: { providerID: "fixture", id: "fixture" } }
        const profiles = { coordinator: selection, roles: { specialist: selection } }
        const config = { title: "Daily display", consigne: "Exact display", template: "custom" as const, taskMode: "native" as const, profiles,
          profileID: "profile", executionHost: "local", roots: [{ mode: "directory-only" as const, directory: ctx.location.directory }], watchedConversationIDs: [], clock: { time: "23:59", zone: "UTC" } }
        const calendar = new NativeMissionRecurrenceStore(storage, project.id, project.canonical)
        let daily = await calendar.create("daily_current", config, now, current)
        daily = await calendar.setState(daily.id, daily.revision, "running", current)
        daily = await calendar.reserve(daily.id, daily.revision, { kind: "manual", requestID: "seed", expectedRevision: daily.revision, at: now }, now, current)
        const documents = new NativeMissionDocumentStore({ get: storage.get, compareAndSet: async (key, value, expected, guard) => {
          guard(); const previous = await storage.get(key) as { revision?: number } | undefined
          if ((previous?.revision ?? null) !== expected) throw Error("Fixture CAS conflict")
          await storage.set(key, value)
        } }, project.id, project.canonical)
        let scheduled = await documents.create("scheduled_current", { title: "Scheduled display", objective: "Exact display", template: "custom", taskMode: "native", profiles,
          profileID: "profile", executionHost: "local", roots: config.roots, watchedConversationIDs: [],
          launch: { timing: { kind: "every", intervalMs: 900000 }, condition: null, ends: { at: null, afterMs: null, maxLaunches: 3 } } }, now, current)
        scheduled = await documents.change(scheduled.id, scheduled.revision, current, doc => {
          changes.play(doc, "play", now, [])
          changes.synchronized(doc, "play", (["principal", "reconciliation"] as const).map(role => ({ role, slot: 0, timeGeneration: 1,
            scheduleID: `sch_${role}`, sessionID: `ses_${role}`, highWater: 0, pendingWake: null, wakePreparing: null })))
          changes.reserve(doc, { kind: "manual", requestID: "seed" }, now, []); changes.admitted(doc, doc.pending!.id, now)
        })
        const passages = [recurrencePassage(storage, daily, current), missionDocumentPassage(storage, scheduled, current)]
        for (const passage of passages) {
          const sessions = new Map<string, NativeMissionSession>()
          sessions.set(passage.coordinatorSessionID, { id: passage.coordinatorSessionID, projectID: project.id, location: { directory: ctx.location.directory },
            agent: selection.agent, model: selection.model, metadata: { "codenomad.mission": { version: 1, missionID: passage.missionID, kind: "coordinator", role: "coordinator" } } })
          const control = new MissionControl({ storage: passage.storage, project: { ...project, location: { directory: ctx.location.directory } }, sessions: {
            get: async ({ sessionID }) => { const value = sessions.get(sessionID); if (!value) throw Error("Fixture root absent"); return value },
            create: async input => { const value = { ...input, projectID: project.id, location: { directory: ctx.location.directory } }; sessions.set(input.id!, value); return value },
            prompt: async () => {}, synthetic: async () => {},
          } })
          const first = (await control.create({ requestID: passage.passageID, coordinatorSessionID: passage.coordinatorSessionID, objective: "Exact display", template: "custom", taskMode: "native", profiles })).mission
          let map = first
          for (let batch = 0; batch < 5; batch++) map = (await control.revise(map.coordinatorSessionId, { missionID: map.id, requestID: `batch-${batch}`, expectedRevision: map.revision,
            reason: "Display rows", retireTasks: [], dependencyUpdates: [], addTasks: Array.from({ length: 12 }, (_, i) => ({ taskKey: `task-${batch}-${i}`, title: `Task ${batch}-${i}`,
              brief: "b".repeat(20000), role: "specialist", blockedBy: [], executionMode: { kind: "native" as const, parentTaskKey: null } })) })).mission
          map = (await control.revise(map.coordinatorSessionId, { missionID: map.id, requestID: "wide-body", expectedRevision: map.revision,
            reason: "Escaped body continuation", retireTasks: [], dependencyUpdates: [], addTasks: [{ taskKey: "wide-body", title: "Escaped body",
              brief: "\u0001".repeat(20000), role: "specialist", blockedBy: [], executionMode: { kind: "native", parentTaskKey: null } }] })).mission
          if (map.id !== passage.missionID || map.coordinatorSessionId !== passage.coordinatorSessionID) throw Error("Fixture execution identity differs")
        }
        return { schedules: [{ owner: "daily", scheduleID: daily.id }, { owner: "scheduled", scheduleID: scheduled.id }], tasks: 61 }
      })
    }).pipe(Effect.orDie),
  })
}).pipe(Effect.orDie) })
