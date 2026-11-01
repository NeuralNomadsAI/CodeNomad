import type { Plugin } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { MissionControl } from "../../missions/control"
import type { MissionSessionAdapter, NativeMissionSession } from "../../missions/control-types"
import type { MissionPreparationRequest } from "../../missions/mission-preparation"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import type { MissionDocument } from "../../missions/mission-document"
import type { MissionNativeRunner } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"

/** Native reads stay in this RPC graph; creation uses only the public facade. */
export const configureNativeMissionPreparation = Effect.fn("missions.configurePreparation")(function* (
  ctx: Plugin.Context, store: NativeMissionDocumentStore, input: MissionPreparationRequest, current: () => true, run: MissionNativeRunner,
  admitted?: (document: MissionDocument) => void,
) {
  const observation = yield* acquireNativePassageObservation(undefined, run)
  const project = (value: typeof Session.Info.Type): NativeMissionSession => ({ id: value.id, projectID: value.projectID,
    location: { ...value.location }, parentID: value.parentID, title: value.title, agent: value.agent,
    model: value.model ? { ...value.model } : undefined, metadata: value.metadata ? JSON.parse(JSON.stringify(value.metadata)) : undefined })
  const read = async (sessionID: string) => {
    current()
    if (!await observation.exists(sessionID)) { current(); return undefined }
    const value = await run(ctx.session.get({ sessionID: Session.ID.make(sessionID) }))
    current()
    return project(value)
  }
  const sessions: MissionSessionAdapter = {
    get: async ({ sessionID }) => { const value = await read(sessionID); if (!value) throw new Error("Mission coordinator missing"); return value },
    create: async input => {
      current()
      return project(await run(Effect.suspend(() => {
        current()
        return ctx.session.create(input as Parameters<typeof ctx.session.create>[0])
      })))
    },
    prompt: async () => { throw new Error("Preparation never prompts") },
    synthetic: async () => { throw new Error("Preparation never resumes") },
  }
  const control = new MissionControl({ project: { id: ctx.location.project.id, canonical: ctx.location.project.canonical,
    location: { directory: ctx.location.directory, ...(ctx.location.workspaceID ? { workspaceID: ctx.location.workspaceID } : {}) } },
    storage: { get: key => run(ctx.storage.get(key)), scan: input => run(ctx.storage.scan(input)),
      set: async (key, value, guard) => { current(); guard?.(); await run(ctx.storage.set(key, value)) } },
    sessions, documents: use => use(store), documentReads: use => use(store) })
  return yield* Effect.tryPromise(() => control.configurePreparation(input, {
    read,
    empty: session => observation.empty(session),
  }, current, admitted))
})
