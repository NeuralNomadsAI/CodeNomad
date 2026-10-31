// Private service qualification only; product setup never loads this entry.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Context, Effect, Option } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { MissionControl } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { documentPassageStartInput } from "../../missions/mission-document-passage-input"
import { missionCalendarOwnerSchema } from "../../missions/mission-calendar-owner-state"
import { captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import type { MissionStorage } from "../../missions/journal"
import type { MissionDocument } from "../../missions/mission-document"
import { registerNativeScheduledBusinessRpc } from "./native-scheduled-business-rpc"
import { acquireNativeScheduledPassageRuntime } from "./native-scheduled-passage-runtime"
import { registerNativeScheduleProvider } from "./native-schedule-provider-registration"
import { nativeScheduleCarrierHooks, NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import type { NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { nativeInvocation } from "./native-invocation"
import { nativeScheduleDocumentKey } from "./native-schedule-carrier-binding"

const method = { input: { type: "object" }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.business-bridge-qualification", methods: { seed: method, use: method }, events: {} })
export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  const options = ctx.options as NativeScheduleCarrierInstallation & { configYamlPath: string }, invocation = nativeInvocation()
  yield* registerNativeScheduleProvider(ctx, options)
  const hooks = nativeScheduleCarrierHooks(() => false)
  yield* ctx.aisdk.hook("language", event => Effect.sync(() => hooks.language(event)))
  const sessionTag = Context.Service<never, unknown>("@opencode/Session"), scheduleTag = Context.Service<never, unknown>("@opencode/Schedule")
  const receivers: boolean[] = []
  const business = yield* registerNativeScheduledBusinessRpc(ctx, options, invocation, run => Effect.gen(function* () {
    receivers.push(Option.isSome(yield* Effect.serviceOption(sessionTag)) && Option.isSome(yield* Effect.serviceOption(scheduleTag)))
    if (!receivers.at(-1)) throw new Error("Receiver lacks fresh native services")
    return yield* acquireNativeScheduledPassageRuntime(ctx, run)
  }))
  const current = () => true as const
  const seed = () => invocation.capture(Effect.scoped(Effect.gen(function* () {
    const graph = yield* Effect.context<never>(), run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
    const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
      set: async (key, value) => { await run(ctx.storage.set(key, value)) }, scan: input => run(ctx.storage.scan(input)) as ReturnType<MissionStorage["scan"]> }
    return yield* Effect.promise(async () => {
      // Controlled seeding only. Business mutations below use B's actual SQL CAS.
      const documents = new NativeMissionDocumentStore({ get: storage.get, compareAndSet: async (key, value, expected, guard) => {
        guard(); const before = await storage.get(key) as { revision?: number } | undefined
        if ((before?.revision ?? null) !== expected) throw new Error("Fixture revision conflict")
        await storage.set(key, value)
      } }, ctx.location.project.id, ctx.location.project.canonical)
      const selection = { agent: "build", model: NATIVE_SCHEDULE_CARRIER_MODEL }
      let doc = await documents.create("business_native", { title: "Business bridge", objective: "Private proof", template: "custom", taskMode: "native",
        profileID: "profile", executionHost: "host", profiles: { coordinator: selection, roles: { specialist: selection } },
        roots: [{ mode: "directory-only", directory: ctx.location.directory }], watchedConversationIDs: [],
        launch: { timing: { kind: "immediate" }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } } }, Date.now(), current)
      doc = await documents.change(doc.id, doc.revision, current, next => {
        changes.play(next, "first_play", Date.now(), []); changes.reserve(next, { kind: "immediate", requestID: "original" }, Date.now(), [])
        changes.admitted(next, next.pending!.id, Date.now())
        next.calendarOwner = missionCalendarOwnerSchema.parse({ version: 1, installation: { registrationFile: options.registrationFile, provider: options.provider, runtime: options.runtime },
          profileSource: { profileID: "profile", executionHost: "host", configYamlPath: options.configYamlPath }, placement: captureMissionCalendarPlacement(next.configuration.roots),
          operation: { action: "play", requestID: "first_play", expectedRevision: 0, fingerprint: "a".repeat(64), pending: false, startedAt: Date.now() },
          slots: [], retired: [], auxiliaryReady: false, error: null })
      })
      const pending = doc.pending!, rootID = Session.ID.make(pending.coordinatorSessionID)
      await run(ctx.session.create({ id: rootID, agent: Agent.ID.make("build"), model: { providerID: Provider.ID.make(selection.model.providerID), id: Model.ID.make(selection.model.id) },
        location: { directory: ctx.location.directory }, metadata: { "codenomad.mission": { version: 1, missionID: pending.missionID, kind: "coordinator", role: "coordinator",
          document: { missionID: doc.id, passageID: pending.id } } } }))
      const original = documentPassageStartInput(doc)
      await run(ctx.session.synthetic({ ...original, id: SessionMessage.ID.make(original.id), sessionID: rootID, resume: false }))
      const passage = missionDocumentPassage(storage, doc, current), control = new MissionControl({ project: { id: doc.projectID, canonical: doc.projectCanonical, location: ctx.location },
        storage: passage.storage, sessions: { get: async input => {
          const value = await run(ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })); return { ...value, metadata: JSON.parse(JSON.stringify(value.metadata ?? {})) }
        }, create: async () => { throw new Error("No root creation") }, prompt: async () => {}, synthetic: async () => {} } })
      await control.create({ requestID: pending.id, objective: "Private proof", template: "custom", coordinatorSessionID: rootID })
      return { sessionID: rootID }
    })
  }))).pipe(Effect.orDie)
  yield* ctx.rpc.register(definition, { seed,
    use: raw => Effect.gen(function* () {
      const full = yield* Effect.context<never>(), partial = Context.omit(sessionTag, scheduleTag)(full)
      return yield* invocation.capture(Effect.gen(function* () {
        const missing = Option.isNone(yield* Effect.serviceOption(sessionTag)) && Option.isNone(yield* Effect.serviceOption(scheduleTag))
        return yield* Effect.promise(async () => {
          const sessionID = (raw as { sessionID: string }).sessionID
          if (!missing || !await business.prepare(sessionID)) throw new Error("Partial-graph preparation failed")
          const selected = await business.select(sessionID)
          if (!selected || selected.control.backendActions) throw new Error("Selection failed")
          const result = await selected.execute!(control => control.declare(sessionID, { taskKey: "owned", title: "Owned", brief: "Private proof", role: "specialist", blockedBy: [],
            executionMode: { kind: "native", parentTaskKey: null } }))
          const context = await selected.execute!(control => control.contextFor(selected.readSessionID))
          const snapshot = await invocation.check(run => run(ctx.storage.get(nativeScheduleDocumentKey(ctx, "business_native")))) as unknown as MissionDocument
          return { partialGraph: missing, receivers: [...receivers], taskKeys: result.mission.tasks.map(task => task.key), context: !!context?.instruction,
            backendActions: selected.control.backendActions, launchedCount: snapshot.launchedCount }
        })
      }).pipe(Effect.provide(partial)))
    }).pipe(Effect.orDie),
  })
}).pipe(Effect.orDie) })
