import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Predicate } from "effect"
import { readFamilyAuthorityPlacement } from "../../workspaces/family-authority-claim"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { matchesExecution } from "../../missions/execution"
import type { MissionStorage } from "../../missions/journal"
import type { RecurrenceControlRecord } from "../../missions/recurrence-contract"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { acquireMissionNativeService } from "./native-service-adapter"
import { sameLocation } from "../compatibility/location"

const missionID = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
  ? (value as Record<string, unknown>).missionID : undefined

/** Freeze registered roots before interruption; retries advance only unknown targets. */
export const interruptRecurrenceActors = Effect.fn("missions.interruptRecurrenceActors")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location" | "session">,
  input: { scheduleID: string; requestID: string; action: "pause" | "stop"; record: RecurrenceControlRecord },
) {
  const graph = yield* Effect.context<never>(), store = yield* acquireNativeRecurrenceStore(ctx)
  const source = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!source || source.state === "running" || source.controls.at(-1)?.requestID !== input.requestID) throw new Error("Recurrence control changed")
  let record = input.record
  if (!source.pending) {
    if (record.targets.length) return record
    return { ...record, targetsKnown: true }
  }
  const native = yield* acquireMissionNativeService()
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    scan: options => run(ctx.storage.scan(options)) as ReturnType<MissionStorage["scan"]>,
    set: async () => { throw new Error("Control journal is read-only") } }
  const passage = recurrencePassage(storage, source, () => true)
  const snapshot = yield* Effect.promise(() => passage.journal.snapshot())
  const mission = snapshot.missions.find(item => item.id === passage.missionID)
  if (!mission || mission.controlUnavailable || snapshot.controlUnavailable || mission.actors.length > 32) throw new Error("Recurrence actors unavailable")
  if (!record.targetsKnown) {
    record = { ...record, targetsKnown: true, targets: mission.actors.map(actor => ({ sessionID: actor.sessionId, outcome: "unknown" as const })) }
    yield* Effect.promise(() => store.recordControl(input.scheduleID, record, () => true))
  }
  for (const target of record.targets) {
    if (target.outcome === "acknowledged") continue
    yield* Effect.tryPromise(async () => {
      native.assertCurrent()
      const fresh = await store.read(input.scheduleID)
      if (!fresh || fresh.state === "running" || fresh.controls.at(-1)?.requestID !== input.requestID
        || fresh.pending?.passage.id !== source.pending!.passage.id) throw new Error("Recurrence control changed")
      const actor = mission.actors.find(actor => actor.sessionId === target.sessionID)
      const root = actor && source.config.roots.find(root => root.directory === actor.location.directory)
      const placement = root?.mode === "git" ? await readFamilyAuthorityPlacement(root.directory) : undefined
      if (!actor || !root || root.mode !== "git" || placement?.checkout !== root.checkout || placement.family !== root.family) throw new Error("Recurrence root changed")
      const session = await native.get({ sessionID: target.sessionID })
      const assigned = mission.tasks.filter(task => task.actorSessionId === target.sessionID)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      const active = assigned.filter(task => task.status === "queued" || task.status === "dispatching" || task.outstandingExecution)
      const selections = actor.kind === "coordinator" ? [source.config.profiles?.coordinator]
        : (active.length ? active : assigned.slice(0, 1)).map(task => task.execution ?? source.config.profiles?.roles?.[task.role])
      if (!selections.length || selections.some(selection => !selection?.agent || !selection.model || !matchesExecution(selection, session))
        || session.parentID || session.projectID !== source.projectID || !sameLocation(session.location, actor.location)
        || missionID(session.metadata?.["codenomad.mission"]) !== mission.id) throw new Error("Recurrence actor changed")
      if (!Predicate.isFunction(ctx.session.interrupt)) throw new Error("Native interrupt unavailable")
      const interrupted = await run(Effect.suspend(() => { native.assertCurrent(); return ctx.session.interrupt({ sessionID: target.sessionID as never, resume: false }) }))
      if (typeof interrupted?.interrupted !== "boolean") throw new Error("Native interrupt uncertain")
      if (input.action === "stop") {
        for (const item of await native.inbox(session.id)) {
          if ((item.type === "user" || item.type === "synthetic") && missionID(item.payload.metadata?.["codenomad.mission"]) === mission.id) {
            await native.cancelInbox({ sessionID: session.id, inboxID: item.id }, () => { native.assertCurrent(); return true },
              { id: session.id, projectID: source.projectID, location: session.location,
                agent: session.agent!, model: { ...session.model! }, metadata: session.metadata! })
          }
        }
      }
      target.outcome = "acknowledged"
      await store.recordControl(input.scheduleID, record, () => { native.assertCurrent(); return true })
    }).pipe(Effect.catchCause(() => Effect.void))
  }
  return record
})
