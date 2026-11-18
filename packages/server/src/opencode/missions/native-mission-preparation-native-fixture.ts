import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect, Schema } from "effect"
import { MissionControl } from "../../missions/control"
import type { MissionSessionAdapter, NativeMissionSession } from "../../missions/control-types"
import { missionConfigurationSchema } from "../../missions/launch-policy"
import { missionActorResumeInput } from "../../missions/native-actor-lifecycle"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { configureNativeMissionPreparation } from "./native-mission-preparation"
import { nativeInvocation } from "./native-invocation"
import { useNativeMissionDocuments } from "./native-mission-document-access"

const method = { input: { type: "object" }, output: { type: "object" } } as const
export const preparationQualification = { id: "codenomad.preparation-qualification", methods: { create: method, configure: method, read: method, play: method }, events: {} }
export default Plugin.define({ id: "codenomad.missions", effect: ctx => Effect.gen(function* () {
  const invocation = nativeInvocation()
  const invoke = (kind: string) => (raw: unknown) => invocation.capture(Effect.tryPromise(() => invocation.check(async run => {
    const input = raw as { missionID: string; requestID: string; expectedRevision: number; configuration: unknown; loseNativeACK?: boolean; loseAdmissionACK?: boolean }
    const store = await run(acquireNativeMissionDocumentStore(ctx, run))
    const project = (value: typeof Session.Info.Type): NativeMissionSession => JSON.parse(JSON.stringify(Schema.encodeSync(Session.Info)(value)))
    const sessions: MissionSessionAdapter = { get: async input => project(await run(ctx.session.get({ sessionID: Session.ID.make(input.sessionID) }))),
      create: async input => project(await run(ctx.session.create(input as Parameters<typeof ctx.session.create>[0]))),
      prompt: async () => { throw new Error("No fixture prompt") }, synthetic: async () => { throw new Error("Use fixture lifecycle") } }
    const control: MissionControl = new MissionControl({ project: { id: ctx.location.project.id, canonical: ctx.location.project.canonical,
      location: { directory: ctx.location.directory } }, storage: { get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
      set: async (key, value, guard) => { guard?.(); await run(ctx.storage.set(key, value)) } },
      documents: use => run(useNativeMissionDocuments(ctx, run, use)), documentReads: use => use(store), sessions,
      transport: { prompt: async () => { throw new Error("No prompt") }, synthetic: async () => { throw new Error("No synthetic") },
        lifecycle: async (coordinator, request) => {
          const mission = (await control.snapshot()).missions.find(item => item.id === request.missionID)!, operation = mission.control!
          const route = missionActorResumeInput(mission.id, operation.id, request.sessionID, coordinator)
          const admitted = await run(ctx.session.synthetic({ ...route, ...(request.startText === undefined ? {} : { text: request.startText }),
            sessionID: Session.ID.make(route.sessionID), id: SessionMessage.ID.make(route.id) }))
          if (input.loseAdmissionACK) throw new Error("Lost original admission ACK")
          return { nativeAcknowledgement: { missionID: mission.id, operationID: operation.id, sessionID: request.sessionID,
            action: "start", disposition: "start-admitted", admission: Schema.encodeSync(SessionInbox.Synthetic)(admitted) } }
        } } })
    if (kind === "create") return control.create({ requestID: input.requestID, objective: "Original private preparation", template: "custom" })
    if (kind === "read") return { snapshot: await control.snapshot(), document: await store.read(input.missionID) }
    if (kind === "play") return control.lifecycle({ ...input, action: "start" })
    const selected: Plugin.Context = input.loseNativeACK ? { ...ctx, session: new Proxy(ctx.session, { get(target, key) {
      if (key !== "create") return Reflect.get(target, key)
      return (input: Parameters<typeof target.create>[0]) => target.create(input).pipe(Effect.flatMap(() => Effect.fail(new Error("Lost native creation ACK"))))
    } }) } : ctx
    return { document: await run(configureNativeMissionPreparation(selected, store, { ...input,
      configuration: missionConfigurationSchema.parse(input.configuration) }, () => true, run)) }
  }))).pipe(Effect.map(value => JSON.parse(JSON.stringify(value))), Effect.orDie)
  yield* ctx.rpc.register(Rpc.define(preparationQualification), { create: invoke("create"), configure: invoke("configure"), read: invoke("read"), play: invoke("play") }).pipe(Effect.orDie)
}) })
