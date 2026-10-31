import { isDeepStrictEqual } from "node:util"
import { OpenCode, isSessionNotFoundError, type OpenCodeClient, type SessionInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import type { MissionInputTransport } from "../../missions/control-types"
import { matchesExecution } from "../../missions/execution"
import { MissionJournal, type MissionStorage } from "../../missions/journal"
import { parseMissionDocument } from "../../missions/mission-document"
import { assertMissionCalendarPlacement } from "../../missions/mission-calendar-placement"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { parseMissionNativeAcknowledgement } from "../../missions/lifecycle-schema"
import { interruptNativeMissionActor, interruptedMissionConversations, missionActorResumeInput } from "../../missions/native-actor-lifecycle"
import { MAX_CONTROL_FAMILY_SESSIONS } from "../../missions/native-session-family"
import { sameLocation } from "../compatibility/location"
import { readAutonomousMissionEnvironment } from "./autonomous-environment"
import { nativeScheduleDocumentKey, type NativeScheduleCarrierInstallation } from "./native-schedule-carrier-binding"
import { nativeScheduleIncarnationGuard, readNativeScheduleIncarnation } from "./native-schedule-transport-identity"
import type { MissionNativeRunner } from "./native-service-adapter"

type Lifecycle = NonNullable<MissionInputTransport["lifecycle"]>
type ActorCalendarControl = { requestID: string; expectedRevision: number; action: "play" | "resume" | "pause" | "stop" | "delete"; pending: boolean }
/** Interruption accepts the current durable intent before calendar cleanup.
 * Start requires completed calendars; retained receipts survive reconciliation
 * only while no newer explicit intent supersedes them. */
export function scheduledActorCalendarBarrier(owner: { operation: unknown; receipts: readonly unknown[]; lastControl?: unknown },
  requestID: string, action: "start" | "pause" | "stop", captured?: ActorCalendarControl): ActorCalendarControl | undefined {
  const records = [owner.operation, ...owner.receipts, owner.lastControl]
  if (action === "start" && (!owner.operation || typeof owner.operation !== "object"
    || (owner.operation as Record<string, unknown>).pending !== false)) return
  for (const candidate of records) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    if (record.requestID !== requestID || typeof record.pending !== "boolean"
      || record.pending && (action === "start" || candidate !== owner.operation) || !Number.isSafeInteger(record.expectedRevision)
      || Number(record.expectedRevision) < 0 || (action === "start" ? record.action !== "play" && record.action !== "resume"
        : action === "stop" ? record.action !== "stop" && record.action !== "delete" : record.action !== "pause")
      || captured && !isDeepStrictEqual(candidate, captured)) continue
    if (records.some(other => {
      if (!other || typeof other !== "object" || Array.isArray(other)) return false
      const newer = other as Record<string, unknown>
      return (newer.requestID !== requestID && ["play", "resume", "pause", "stop", "delete", "configure"].includes(String(newer.action))
        && Number.isSafeInteger(newer.expectedRevision) && Number(newer.expectedRevision) >= Number(record.expectedRevision))
        || (other === owner.operation && newer.requestID === requestID && !isDeepStrictEqual(other, candidate))
    })) continue
    return candidate as ActorCalendarControl
  }
}
const locationTag = Context.Service<never, unknown>("@opencode/Location")
const marker = (session: Pick<SessionInfo, "metadata">) => session.metadata?.["codenomad.mission"] as
  { version?: unknown; missionID?: unknown; kind?: unknown; role?: unknown; document?: { missionID?: unknown; passageID?: unknown } } | undefined

/** Acquire and consume in the same RPC scope. The parent holds document exclusion
 * before MissionControl's writer; this port only reads those existing records. */
export const acquireNativeScheduledActorTransport = Effect.fn("missions.acquireScheduledActorTransport")(function* (
  ctx: Plugin.Context, installation: NativeScheduleCarrierInstallation, run: MissionNativeRunner, current: () => true,
) {
  const placed = yield* Effect.serviceOption(locationTag), graph = yield* Effect.context<never>()
  if (Option.isNone(placed)) throw new Error("Scheduled actor Location unavailable")
  const location = structuredClone(ctx.location), manifest = { registrationFile: installation.registrationFile,
    provider: { file: installation.provider.file, sha256: installation.provider.sha256 },
    runtime: { file: installation.runtime.file, sha256: installation.runtime.sha256 } }
  const identity = readNativeScheduleIncarnation(manifest.registrationFile)
  const incarnation = nativeScheduleIncarnationGuard(manifest.registrationFile, identity)
  const retired = new AbortController()
  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false; retired.abort() }))
  const guard = (): true => {
    current(); incarnation()
    const nativeLocation = placed.value as typeof location
    if (!active || Context.get(graph, locationTag) !== placed.value || !sameLocation(ctx.location, location)
      || ctx.location.project.id !== location.project.id || ctx.location.project.canonical !== location.project.canonical
      || !sameLocation(nativeLocation, location) || nativeLocation.project.id !== location.project.id
      || nativeLocation.project.canonical !== location.project.canonical) throw new Error("Scheduled actor invocation changed")
    return true
  }
  guard()
  const endpoint = yield* Effect.tryPromise(() => Service.discover({ file: manifest.registrationFile })).pipe(Effect.timeout("4 seconds"))
  guard()
  if (!endpoint || endpoint.url !== identity.url) throw new Error("Scheduled actor service differs")
  const headers = Service.headers(endpoint)
  const storage: MissionStorage = {
    get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    scan: input => run(ctx.storage.scan(input)) as ReturnType<MissionStorage["scan"]>,
    set: async () => { throw new Error("Scheduled actor authority is read-only") },
  }
  const lifecycle: Lifecycle = async (coordinatorID, input) => {
    const signal = AbortSignal.any([retired.signal, AbortSignal.timeout(85_000)])
    const live = () => { signal.throwIfAborted(); return guard() }
    // Effect races interrupt and join the losing fiber/finalizers before returning.
    const invoke = <A>(effect: Effect.Effect<A, unknown>, callSignal?: AbortSignal) => {
      const combined = callSignal ? AbortSignal.any([signal, callSignal]) : signal
      return run(Effect.raceFirst(Effect.suspend(() => { combined.throwIfAborted(); return effect }), Effect.callback<never, Error>(resume => {
        const abort = () => resume(Effect.fail(new Error("Scheduled actor invocation cancelled")))
        combined.addEventListener("abort", abort, { once: true })
        if (combined.aborted) abort()
        return Effect.sync(() => combined.removeEventListener("abort", abort))
      })))
    }
    const get = async (id: string, callSignal?: AbortSignal): Promise<SessionInfo> => {
      live()
      const session = await invoke(Effect.suspend(() => { live(); return ctx.session.get({ sessionID: Session.ID.make(id) }) }), callSignal)
      live()
      if (session.id !== id || session.projectID !== location.project.id || !sameLocation(session.location, location)) throw new Error("Scheduled actor moved")
      return session as unknown as SessionInfo
    }
    try {
      if (input.recurrence) throw new Error("Foreign recurrence control")
      const coordinator = await get(coordinatorID), ownerID = marker(coordinator)?.document?.missionID
      if (typeof ownerID !== "string") throw new Error("Scheduled actor owner missing")
      const readDocument = async () => {
        live()
        const doc = parseMissionDocument(await storage.get(nativeScheduleDocumentKey(ctx, ownerID)), {
          id: ownerID, projectID: location.project.id, projectCanonical: location.project.canonical,
        })
        live()
        return doc
      }
      const doc = await readDocument(), pending = doc.pending
      if (!pending || pending.missionID !== input.missionID || pending.coordinatorSessionID !== coordinatorID
        || !isDeepStrictEqual(marker(coordinator)?.document, { missionID: doc.id, passageID: pending.id })
        || marker(coordinator)?.missionID !== pending.missionID || !doc.calendarOwner
        || !isDeepStrictEqual(doc.calendarOwner.installation, manifest)) throw new Error("Scheduled actor pending differs")
      const passage = missionDocumentPassage(storage, doc, live), before = await passage.journal.snapshot()
      const mission = before.missions[0], operation = structuredClone(mission?.control)
      const target = operation?.targets.find(target => target.sessionID === input.sessionID)
      if (before.discardedEvents || before.controlUnavailable || before.cleanupUnavailable || before.missions.length !== 1
        || !mission || mission.id !== input.missionID || mission.coordinatorSessionId !== coordinatorID || !operation
        || operation.id !== input.operationID || operation.recurrence || !target || !operation.pending.includes(input.sessionID))
        throw new Error("Scheduled actor control unavailable")
      const action = operation.action, frozen = pending.configuration
      const calendarControl = structuredClone(scheduledActorCalendarBarrier(doc.calendarOwner, operation.requestID, action))
      if (!calendarControl) throw new Error("Scheduled actor calendar barrier missing")
      if (!frozen.profileID || !frozen.executionHost || doc.calendarOwner.profileSource.profileID !== frozen.profileID
        || doc.calendarOwner.profileSource.executionHost !== frozen.executionHost) throw new Error("Scheduled actor frozen profile missing")
      const expectedState = action === "start" ? "running" : action === "pause" ? "paused" : "stopped"
      const documentCurrent = (fresh: typeof doc) => {
        if (!fresh.pending || fresh.pending.id !== pending.id || fresh.pending.missionID !== pending.missionID
          || fresh.pending.coordinatorSessionID !== coordinatorID || fresh.pending.messageID !== pending.messageID
          || fresh.pending.configurationGeneration !== pending.configurationGeneration || fresh.pending.timeGeneration !== pending.timeGeneration
          || !isDeepStrictEqual(fresh.pending.configuration, frozen) || !isDeepStrictEqual(fresh.pending.checkpoints, pending.checkpoints)
          || !isDeepStrictEqual(fresh.calendarOwner?.installation, manifest)
          || !isDeepStrictEqual(fresh.calendarOwner?.profileSource, doc.calendarOwner!.profileSource)
          || !isDeepStrictEqual(fresh.calendarOwner?.placement, doc.calendarOwner!.placement)
          || (action === "start" ? !["running", "finished"].includes(fresh.state) || fresh.pending.admittedAt === null || !!fresh.deletion || !!fresh.blocked
            : fresh.state !== expectedState)) throw new Error("Scheduled actor desired state changed")
        if (!scheduledActorCalendarBarrier(fresh.calendarOwner!, operation.requestID, action, calendarControl))
          throw new Error("Scheduled actor calendar barrier missing")
        assertMissionCalendarPlacement(fresh.calendarOwner!.placement, frozen.roots)
      }
      const checkOperation = async () => {
        documentCurrent(await readDocument())
        const snapshot = await passage.journal.snapshot(), fresh = snapshot.missions[0]
        live()
        if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.missions.length !== 1 || !fresh
          || fresh.id !== mission.id || fresh.coordinatorSessionId !== coordinatorID || fresh.runState !== expectedState
          || action !== "stop" && fresh.status !== "active" || fresh.control?.id !== operation.id
          || fresh.control.requestID !== operation.requestID || fresh.control.action !== action
          || fresh.control.expectedRevision !== operation.expectedRevision || !isDeepStrictEqual(fresh.control.targets, operation.targets)
          || !fresh.control.pending.includes(target.sessionID)) throw new Error("Scheduled actor operation changed")
      }
      const root = async (id: string, callSignal?: AbortSignal) => {
        const session = await get(id, callSignal), actor = mission.actors.find(actor => actor.sessionId === id)
        const assigned = mission.tasks.filter(task => task.actorSessionId === id).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
        const unfinished = assigned.filter(task => task.status === "queued" || task.status === "dispatching" || task.outstandingExecution)
        const selections = id === coordinatorID ? [frozen.profiles?.coordinator]
          : (unfinished.length ? unfinished : assigned.slice(0, 1)).map(task => task.execution ?? frozen.profiles?.roles?.[task.role])
        if (!actor || session.parentID || !sameLocation(actor.location, session.location)
          || !frozen.roots.some(owned => sameLocation(owned, session.location)) || !selections.length
          || selections.some(selected => !selected?.agent || !selected.model || !matchesExecution(selected, session))
          || marker(session)?.version !== 1 || marker(session)?.missionID !== mission.id
          || marker(session)?.kind !== (id === coordinatorID ? "coordinator" : "actor")
          || !actor.roles.includes(String(marker(session)?.role))
          || !isDeepStrictEqual(marker(session)?.document, { missionID: doc.id, passageID: pending.id })) throw new Error("Scheduled actor profile differs")
        return session
      }
      const ackIdentity = { missionID: mission.id, operationID: operation.id, sessionID: target.sessionID, action }
      const reply = (value: unknown) => {
        live()
        const nativeAcknowledgement = parseMissionNativeAcknowledgement(value, ackIdentity)
        if (!nativeAcknowledgement) throw new Error("Scheduled actor acknowledgement unknown")
        return { nativeAcknowledgement }
      }
      await checkOperation(); await root(coordinatorID)
      // The existing MissionControl writer serializes ordinary and isolated maps.
      // Read shared memberships under that writer before touching a root.
      const ordinary = await new MissionJournal(storage, doc.projectID, doc.projectCanonical).snapshot()
      if (ordinary.discardedEvents || ordinary.controlUnavailable) throw new Error("Scheduled actor membership unknown")
      if (ordinary.missions.some(other => other.id !== mission.id && other.status === "active"
        && other.actors.some(actor => actor.sessionId === target.sessionID))) {
        if (action !== "stop") throw new Error("Scheduled actor root reused")
        await checkOperation()
        return reply({ ...ackIdentity, disposition: "target-reused" })
      }
      let selected: SessionInfo
      try { selected = await root(target.sessionID) } catch (error) {
        if (action !== "start" && isSessionNotFoundError(error) && error.sessionID === target.sessionID) {
          await checkOperation(); await root(coordinatorID)
          return reply({ ...ackIdentity, disposition: "target-missing" })
        }
        throw error
      }
      const checkpoint = async (callSignal?: AbortSignal) => {
        callSignal?.throwIfAborted()
        await checkOperation()
        for (const [id, metadata] of [[coordinatorID, coordinator.metadata], [target.sessionID, selected.metadata]] as const) {
          if (!isDeepStrictEqual((await root(id, callSignal)).metadata, metadata)) throw new Error("Scheduled actor metadata changed")
        }
        live()
      }
      const member = async (id: string, callSignal?: AbortSignal) => {
        const seen = new Set<string>()
        // ponytail: fresh ancestry per effect, bounded by 4096; optimize only with equivalent fresh ownership proof.
        for (let cursor: string | undefined = id; cursor && seen.size < MAX_CONTROL_FAMILY_SESSIONS;) {
          if (seen.has(cursor)) break
          seen.add(cursor)
          const session = await get(cursor, callSignal)
          if (session.id === selected.id) return
          cursor = session.parentID
        }
        throw new Error("Scheduled actor descendant differs")
      }
      const http = OpenCode.make({ baseUrl: endpoint.url, headers, fetch: async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url)
        const inbox = url.pathname.match(/^\/api\/session\/([^/]+)\/inbox(?:\/[^/]+)?$/)
        const environment = url.pathname === `/api/session/${encodeURIComponent(selected.id)}/environment` && request.method === "PUT" && action === "start"
        const list = url.pathname === "/api/session" && request.method === "GET" && url.searchParams.has("parentID")
        const activeRead = url.pathname === "/api/session/active" && request.method === "GET"
        if (url.origin !== new URL(endpoint.url).origin || !(environment || list || activeRead
          || inbox && ["GET", "DELETE"].includes(request.method))) throw new Error("Scheduled actor HTTP boundary")
        live()
        if (request.method !== "GET") await checkpoint(request.signal)
        if (list) await member(url.searchParams.get("parentID")!, request.signal)
        if (inbox) await member(decodeURIComponent(inbox[1]), request.signal)
        live()
        return globalThis.fetch(request, { signal: AbortSignal.any([signal, request.signal]), redirect: "error" })
      } })
      const client = { ...http, session: { ...http.session, get: ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => get(sessionID, options?.signal),
        interrupt: async ({ sessionID, resume }: { sessionID: string; resume?: boolean }, options?: { signal?: AbortSignal }) => {
          if (resume !== false) throw new Error("Scheduled actor interrupt policy")
          await checkpoint(options?.signal); await member(sessionID, options?.signal)
          const result = await invoke(Effect.suspend(() => { live(); return ctx.session.interrupt({ sessionID: Session.ID.make(sessionID), resume: false }) }), options?.signal)
          live(); return result
        },
      } } as OpenCodeClient
      await checkpoint()
      if (action === "start") {
        const variables = await readAutonomousMissionEnvironment({ profileID: frozen.profileID, executionHost: frozen.executionHost }, doc.calendarOwner.profileSource, signal)
        await checkpoint()
        await http.session.environment({ sessionID: selected.id, variables: { ...variables } }, { signal })
        const interrupted = selected.id === coordinatorID && operation.pausedDescendants
          ? await interruptedMissionConversations(client, selected, mission.tasks, operation.pausedDescendants, signal, live) : ""
        await checkpoint()
        const route = missionActorResumeInput(mission.id, operation.id, selected.id, coordinatorID, interrupted)
        const nativeAdmission = await invoke(Effect.suspend(() => { live(); return ctx.session.synthetic({ ...route,
          sessionID: Session.ID.make(route.sessionID), id: SessionMessage.ID.make(route.id) }) }))
        await checkpoint()
        const admission = Schema.encodeSync(SessionInbox.Synthetic)(nativeAdmission)
        return reply({ ...ackIdentity, disposition: "start-admitted", admission })
      }
      const observed = await interruptNativeMissionActor({ client, root: selected, action, missionID: mission.id, signal, current: live, checkpoint })
      await checkpoint()
      return reply({ ...ackIdentity, disposition: "interrupt-observed", ...observed })
    } catch { throw new Error("Scheduled actor lifecycle unconfirmed") }
  }
  return lifecycle
}, effect => effect.pipe(Effect.catchCause(() => Effect.fail(new Error("Scheduled actor transport unavailable")))))
