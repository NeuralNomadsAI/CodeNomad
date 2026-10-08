import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Predicate } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { canonicalAuthority, rejectAuthority } from "../../missions/authority-protocol"
import { readFamilyAuthorityPlacementSync } from "../../workspaces/family-authority-claim"
import { recurrencePassage } from "../../missions/recurrence-passage"
import { MissionControl } from "../../missions/control"
import { matchesExecution } from "../../missions/execution"
import type { MissionStorage } from "../../missions/journal"
import type { MissionLifecycleOperation } from "../../missions/lifecycle-model"
import { readSignedRecurrence } from "./native-recurrence-snapshot"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { acquireMissionNativeService, type NativeRootPlacement } from "./native-service-adapter"
import { sameLocation } from "../compatibility/location"
import { emitNativeRecurrenceChanged } from "./native-recurrence-events"

const prefix = `plugin:${Array.from("codenomad.missions").map(c => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
const dbTag = Context.Service<never, unknown>("@opencode/storage/Database")
const missionID = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value)
  ? (value as Record<string, unknown>).missionID : undefined

/** Shared Mission lifecycle owns immutable target identities and per-target
 * receipts. This runs only on an authenticated explicit denial/retry, never a
 * due timer; registered roots are interrupted, not recursively suspended. */
export const interruptRecurrenceActors = Effect.fn("missions.interruptRecurrenceActors")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location" | "session">,
  input: { scheduleID: string; requestID: string; epoch: number; action: "pause" | "stop" },
) {
  const graph = yield* Effect.context<never>()
  const store = yield* acquireNativeRecurrenceStore(ctx)
  const source = yield* Effect.promise(() => store.read(input.scheduleID))
  if (!source) rejectAuthority("observation-unavailable")
  const signed = yield* readSignedRecurrence(ctx, source)
  if (!signed?.ledger || signed.epoch !== input.epoch || signed.ledger.parent.body.requestID !== input.requestID
    || signed.ledger.parent.body.action !== (input.action === "pause" ? "pause" : "revoke")) rejectAuthority("authorization-blocked")
  const child = signed.ledger.child
  if (!child) return undefined
  if (!source.pending || source.pending.passage.id !== child.grant.passage.id) rejectAuthority("binding-mismatch")
  const native = yield* acquireMissionNativeService(), database = yield* dbTag
  const client = (database as { db: { $client: SqlClient.SqlClient } }).db.$client
  const live = () => {
    native.assertCurrent()
    const rows = Effect.runSync(client.unsafe("SELECT value FROM kv WHERE key=?", [prefix + signed.authority.key]).withoutTransform.pipe(Effect.provide(graph)))
    const row = rows[0] as { value?: unknown } | undefined
    if (typeof row?.value !== "string") rejectAuthority("observation-unavailable")
    const value = JSON.parse(row.value) as typeof signed.ledger
    if (!value.child || canonicalAuthority(value.child.grant) !== canonicalAuthority(child.grant)
      || value.parent.body.action === "authorize") rejectAuthority("authorization-blocked")
    return value
  }
  const receiptCurrent = (): true => { live(); return true }
  const dispatchCurrent = (): true => {
    const value = live()
    if (value.parent.body.epoch !== input.epoch || value.parent.body.requestID !== input.requestID) rejectAuthority("authorization-blocked")
    return true
  }
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
  const storage: MissionStorage = { get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    scan: options => run(ctx.storage.scan(options)) as ReturnType<MissionStorage["scan"]>,
    set: async (key, value, current) => {
      receiptCurrent(); current?.()
      const before = await run(ctx.storage.get(key))
      await run(ctx.storage.set(key, value))
      if (canonicalAuthority(before ?? null, 256 * 1024) !== canonicalAuthority(value, 256 * 1024)
        && value && typeof value === "object" && !Array.isArray(value) && "type" in value
        && (value.type === "mission.control-requested" || value.type === "mission.control-applied")) {
        await run(Effect.tryPromise(async () => {
          const fresh = await store.read(source.id)
          if (fresh) await run(emitNativeRecurrenceChanged({ directory: ctx.location.directory, workspaceID: ctx.location.workspaceID,
            projectID: source.projectID, projectCanonical: source.projectCanonical }, source.id, fresh.revision))
        }).pipe(Effect.catchCause(() => Effect.logWarning("recurrence-invalidation-unavailable"))))
      }
      receiptCurrent(); current?.()
    } }
  const passage = recurrencePassage(storage, source, receiptCurrent)
  let control!: MissionControl
  const ownedRoot = async (sessionID: string): Promise<NativeRootPlacement> => {
    const snapshot = await passage.journal.snapshot(), mission = snapshot.missions.find(item => item.id === child.grant.missionID)
    const actor = mission?.actors.find(actor => actor.sessionId === sessionID)
    if (!mission || !actor || mission.controlUnavailable || snapshot.controlUnavailable || mission.actors.length > 32) rejectAuthority("observation-unavailable")
    const root = source.config.roots.find(root => root.directory === actor.location.directory)
    const placement = root?.mode === "git" ? readFamilyAuthorityPlacementSync(root.directory) : undefined
    if (!root || root.mode !== "git" || placement?.checkout !== root.checkout
      || placement.family !== root.family) rejectAuthority("binding-mismatch")
    const session = await native.get({ sessionID })
    const assigned = mission.tasks.filter(task => task.actorSessionId === sessionID)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    const active = assigned.filter(task => task.status === "queued" || task.status === "dispatching" || task.outstandingExecution)
    // Reuse follows the active frozen task contracts, or the last completed
    // contract when the root is still unwinding. Never consult mutable defaults
    // or infer every playbook worker to be the custom `specialist` role.
    const contracts = active.length ? active : assigned.slice(0, 1)
    const selections = actor.kind === "coordinator" ? [source.config.profiles?.coordinator]
      : contracts.map(task => task.execution ?? source.config.profiles?.roles?.[task.role])
    if (!selections.length || selections.some(selection => !selection?.agent || !selection.model || !matchesExecution(selection, session))
      || session.parentID || session.projectID !== source.projectID || !sameLocation(session.location, actor.location)
      || missionID(session.metadata?.["codenomad.mission"]) !== mission.id) rejectAuthority("binding-mismatch")
    return { id: sessionID, projectID: source.projectID, location: session.location,
      agent: session.agent!, model: { ...session.model! }, metadata: session.metadata! }
  }
  control = new MissionControl({ project: { id: source.projectID, canonical: source.projectCanonical, location: { directory: ctx.location.directory } },
    storage: passage.storage, isActive: () => { try { receiptCurrent(); return true } catch { return false } },
    sessions: { get: input => native.get(input), create: async () => rejectAuthority("authorization-blocked"),
      prompt: async () => rejectAuthority("authorization-blocked"), synthetic: async () => rejectAuthority("authorization-blocked") },
    transport: { prompt: async () => rejectAuthority("authorization-blocked"), synthetic: async () => rejectAuthority("authorization-blocked"),
      lifecycle: async (coordinatorID, target) => {
        const snapshot = await passage.journal.snapshot(), mission = snapshot.missions.find(item => item.id === child.grant.missionID)
        if (!mission || mission.coordinatorSessionId !== coordinatorID || mission.control?.id !== target.operationID
          || mission.control.requestID !== input.requestID || !mission.control.pending.includes(target.sessionID)) rejectAuthority("authorization-blocked")
        const root = await ownedRoot(target.sessionID)
        if (!Predicate.isFunction(ctx.session.interrupt)) rejectAuthority("effect-unavailable")
        const interrupt = await run(Effect.suspend(() => { dispatchCurrent(); return ctx.session.interrupt({ sessionID: root.id as never, resume: false }) }))
        if (typeof interrupt?.interrupted !== "boolean") rejectAuthority("effect-unavailable")
        const cancellations: Array<{ inboxID: string; disposition: "native-acknowledged" }> = []
        if (input.action === "stop") {
          const inbox = await native.inbox(root.id)
          for (const item of inbox) {
            if ((item.type !== "user" && item.type !== "synthetic") || missionID(item.payload.metadata?.["codenomad.mission"]) !== mission.id) continue
            await native.cancelInbox({ sessionID: root.id, inboxID: item.id }, dispatchCurrent, root)
            cancellations.push({ inboxID: item.id, disposition: "native-acknowledged" })
          }
        }
        return { nativeAcknowledgement: { missionID: mission.id, operationID: target.operationID, sessionID: root.id,
          action: input.action, disposition: "interrupt-observed", interrupt, cancellations } }
      } } })
  let snapshot = yield* Effect.promise(() => passage.journal.snapshot())
  let mission = snapshot.missions.find(item => item.id === child.grant.missionID)
  if (!mission) {
    const session = yield* Effect.promise(() => native.get({ sessionID: child.grant.coordinatorSessionID }))
    if (session.parentID || session.projectID !== source.projectID || missionID(session.metadata?.["codenomad.mission"]) !== child.grant.missionID) rejectAuthority("binding-mismatch")
    yield* Effect.promise(() => control.create({ requestID: child.grant.passage.id, objective: source.config.consigne, template: source.config.template,
      ...(source.config.notes === undefined ? {} : { notes: source.config.notes }),
      profiles: source.config.profiles, taskMode: source.config.taskMode, prepared: true,
      coordinatorSessionID: child.grant.coordinatorSessionID, expectedCoordinatorLocation: session.location }))
    snapshot = yield* Effect.promise(() => passage.journal.snapshot())
    mission = snapshot.missions.find(item => item.id === child.grant.missionID)
  }
  if (!mission || snapshot.controlUnavailable || mission.controlUnavailable) rejectAuthority("observation-unavailable")
  const expectedRevision = mission.control?.requestID === input.requestID ? mission.control.expectedRevision : mission.revision
  // A durable partial lifecycle stays pending with the original target/request
  // identity. Catch the Effect cause, not a JavaScript try around a yielded Effect.
  yield* Effect.promise(() => control.lifecycle({ missionID: mission!.id, requestID: input.requestID, expectedRevision, action: input.action }))
    .pipe(Effect.catchCause(() => Effect.void))
  const final = yield* Effect.promise(() => passage.journal.snapshot())
  const operation = final.missions.find(item => item.id === child.grant.missionID)?.control
  if (!operation || operation.requestID !== input.requestID || operation.action !== input.action) rejectAuthority("observation-unavailable")
  return operation as MissionLifecycleOperation
})
