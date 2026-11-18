// Explicit private qualification entry; never installed by product wiring.
import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Context, Effect, Cause } from "effect"
import { appendFileSync } from "node:fs"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import { MissionControl } from "../../missions/control"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentChanges as changes } from "../../missions/mission-document-state"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { captureMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { missionCalendarOwnerSchema } from "../../missions/mission-calendar-owner-state"
import { acquireNativeScheduledActorTransport } from "./native-mission-schedule-actors"
import { nativeScheduleCarrierHooks, NATIVE_SCHEDULE_CARRIER_MODEL } from "./native-schedule-carrier"
import { registerNativeScheduleProvider } from "./native-schedule-provider-registration"
import type { NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import type { MissionStorage } from "../../missions/journal"
import type { MissionDocument } from "../../missions/mission-document"

const wire = { input: { type: "object" }, output: { type: "object" } } as const
const definition = Rpc.define({ id: "codenomad.scheduled-actors-qualification", methods: { prepare: wire, control: wire }, events: {} })
export default Plugin.define({ id: definition.id, effect: ctx => Effect.gen(function* () {
  const options = ctx.options as NativeScheduleCarrierInstallation & { configYamlPath: string; logFile: string }
  const trace = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.tapCause(cause => Effect.sync(() => appendFileSync(options.logFile, Cause.pretty(cause) + "\n"))))
  yield* registerNativeScheduleProvider(ctx, options)
  const hooks = nativeScheduleCarrierHooks(() => false)
  yield* ctx.aisdk.hook("language", event => Effect.sync(() => hooks.language(event)))
  const current = () => true as const
  const handler = (method: "prepare" | "control") => (raw: unknown) => trace(Effect.scoped(Effect.gen(function* () {
    const graph = yield* Effect.context<never>(), run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseWith(graph)(effect)
    const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
      set: async (key, value) => { await run(ctx.storage.set(key, value)) }, scan: input => run(ctx.storage.scan(input)) as ReturnType<MissionStorage["scan"]> }
    // Controlled fixture seeds only. Production uses the qualified native SQL CAS adapter.
    const documents = new NativeMissionDocumentStore({ get: storage.get, compareAndSet: async (key, value, expected, guard) => {
      guard(); const before = await storage.get(key) as { revision?: number } | undefined
      if ((before?.revision ?? null) !== expected) throw new Error("Fixture revision changed")
      await storage.set(key, value)
    } }, ctx.location.project.id, ctx.location.project.canonical)
    const transport = yield* acquireNativeScheduledActorTransport(ctx, options, run, current)
    return yield* Effect.promise(async () => {
      const input = raw as { action?: "pause" | "stop" | "start"; requestID?: string }
      let doc = await documents.read("actors_native") as MissionDocument | undefined
      if (!doc) {
        if (method !== "prepare") throw new Error("Fixture unprepared")
        const selection = { agent: "build", model: NATIVE_SCHEDULE_CARRIER_MODEL }
        doc = await documents.create("actors_native", { title: "Private actor proof", objective: "Private fixture", template: "custom", taskMode: "native",
          profileID: "private-profile", executionHost: "host", profiles: { coordinator: selection, roles: { specialist: selection } },
          roots: [{ mode: "directory-only", directory: ctx.location.directory }], watchedConversationIDs: [],
          launch: { timing: { kind: "immediate" }, condition: null, ends: { at: null, afterMs: null, maxLaunches: null } } }, Date.now(), current)
        doc = await documents.change(doc.id, doc.revision, current, next => {
          changes.play(next, "first_play", Date.now(), []); changes.reserve(next, { kind: "immediate", requestID: "native_original" }, Date.now(), [])
          changes.admitted(next, next.pending!.id, Date.now())
          next.calendarOwner = missionCalendarOwnerSchema.parse({ version: 1, installation: { registrationFile: options.registrationFile, provider: options.provider, runtime: options.runtime },
            profileSource: { profileID: "private-profile", executionHost: "host", configYamlPath: options.configYamlPath },
            placement: captureMissionCalendarPlacement(next.configuration.roots),
            operation: { action: "play", requestID: "first_play", expectedRevision: 0, fingerprint: "a".repeat(64), pending: false, startedAt: Date.now() },
            receipts: [], checks: [], slots: [], retired: [], auxiliaryReady: false, error: null })
        })
        const rootID = Session.ID.make(doc.pending!.coordinatorSessionID)
        await run(ctx.session.create({ id: rootID, agent: Agent.ID.make("build"), model: {
          providerID: Provider.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.providerID), id: Model.ID.make(NATIVE_SCHEDULE_CARRIER_MODEL.id) },
          location: { directory: ctx.location.directory }, metadata: { "codenomad.mission": { version: 1, missionID: doc.pending!.missionID,
            kind: "coordinator", role: "coordinator", document: { missionID: doc.id, passageID: doc.pending!.id } } } }))
        const child = await run(ctx.session.create({ parentID: rootID }))
        const grandchild = await run(ctx.session.create({ parentID: child.id }))
        for (const sessionID of [rootID, child.id, grandchild.id]) await run(ctx.session.synthetic({ sessionID,
          id: SessionMessage.ID.make(`msg_actor_fixture_${sessionID}`), text: "Parked private control fixture", delivery: "queue", resume: false,
          metadata: { "codenomad.mission": { missionID: doc.pending!.missionID } } }))
      }
      const pending = doc.pending!, passage = missionDocumentPassage(storage, doc, current)
      const control = new MissionControl({ project: { id: doc.projectID, canonical: doc.projectCanonical, location: ctx.location }, storage: passage.storage,
        sessions: { get: async value => {
          const session = await run(ctx.session.get({ sessionID: Session.ID.make(value.sessionID) }))
          return { ...session, metadata: JSON.parse(JSON.stringify(session.metadata ?? {})) }
        }, create: async () => { throw new Error("Unexpected create") },
          prompt: async () => {}, synthetic: async () => {} }, transport: { prompt: async () => {}, synthetic: async () => {}, lifecycle: async (...args) => {
            try { return await transport(...args) } catch (error) {
              const text = error instanceof Error && error.message.startsWith("Private actor frames") ? error.message : "Scheduled actor transport refused"
              appendFileSync(options.logFile, text + "\n"); throw error
            }
          } } })
      if (method === "prepare") {
        await control.create({ requestID: pending.id, objective: "Private fixture", template: "custom", coordinatorSessionID: pending.coordinatorSessionID })
        return { coordinatorID: pending.coordinatorSessionID, launchedCount: doc.launchedCount }
      }
      if (!input.action || !input.requestID) throw new Error("Fixture control missing")
      doc = await documents.change(doc.id, doc.revision, current, next => {
        next.state = input.action === "start" ? "running" : input.action === "pause" ? "paused" : "stopped"
        next.calendarOwner!.operation = { ...next.calendarOwner!.operation, requestID: input.requestID!, action: input.action === "start" ? "resume" : input.action!, pending: false }
      })
      const snapshot = await control.snapshot(), existing = snapshot.missions[0].control
      const result = await control.lifecycle({ missionID: pending.missionID, requestID: input.requestID,
        expectedRevision: existing?.requestID === input.requestID ? existing.expectedRevision : snapshot.missions[0].revision, action: input.action })
      return { control: result.mission.control, launchedCount: doc.launchedCount, originalMessageID: pending.messageID }
    })
  }))).pipe(Effect.orDie)
  yield* ctx.rpc.register(definition, { prepare: handler("prepare"), control: handler("control") })
}).pipe(Effect.orDie) })
