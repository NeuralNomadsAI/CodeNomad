import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Scope } from "effect"
import type { MissionControl } from "../../missions/control"
import type { MissionBusinessRoute } from "../missions-plugin"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { matchesExecution } from "../../missions/execution"
import type { MissionDocument } from "../../missions/mission-document"
import type { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { MissionDocumentPassageEngine, type DocumentPassageWake } from "../../missions/mission-document-passage-engine"
import type { MissionStorage } from "../../missions/journal"
import { acquireNativeMissionDocumentStore } from "./native-mission-document-storage"
import { acquireMissionNativeService, type MissionNativeRunner } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"
import { acquireNativeScheduledPassageAuthority, documentPassageBusinessAllowed, documentPassageDispatchAllowed } from "./native-scheduled-passage-authority"
import { acquireNativeScheduledPassageCoverage } from "./native-scheduled-passage-coverage"
import { nativeScheduledPassageBusiness, scheduledPassageMarker, type NativeScheduledPassageContext } from "./native-scheduled-passage-business"
import { admitNativeScheduledPassage } from "./native-scheduled-passage-admission"
import { observeNativeScheduledPassage } from "./native-scheduled-passage-settlement"
import { prepareNativeDocumentSources, type DocumentConditionReader } from "./native-scheduled-passage-sources"
import { acquireNativeHumanAnswers, nativeHumanAnswerGate } from "./native-human-answer"
import { controlNativeScheduledPassage, type ScheduledPassageControl } from "./native-scheduled-passage-controls"
import { acquireNativeScheduledPassageCapability } from "./native-scheduled-passage-capability"
import { acquireNativeMissionConditionReader } from "./native-mission-condition-reader"
import { acquireNativeSourceFence } from "./native-source-fence"

type Entry = { current(): true; signal: AbortSignal }
type Options = {
  incarnation?: string; now?: () => number; condition?: DocumentConditionReader
  environment?: NativeScheduledPassageContext["environment"]
  lifecycle?: NativeScheduledPassageContext["lifecycle"]
}
const incarnation = `${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`

/** Acquire in, and consume before leaving, the receiving native invocation.
 * Only the business port below survives an invocation; it retains an acquirer. */
export const acquireNativeScheduledPassageRuntime = Effect.fn("missions.acquireScheduledPassageRuntime")(function* (
  ctx: Plugin.Context, run: MissionNativeRunner, options: Options = {},
) {
  let active = true
  const scope = yield* Scope.Scope
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const alive = (): true => { if (!active) throw new Error("Native scheduled passage invocation retired"); return true }
  const native = yield* acquireMissionNativeService(alive, run)
  const observation = yield* acquireNativePassageObservation(undefined, run)
  const store = yield* acquireNativeMissionDocumentStore(ctx, run)
  const sourceFence = yield* acquireNativeSourceFence(alive)
  const dispatchAllowed = documentPassageDispatchAllowed, businessAllowed = documentPassageBusinessAllowed
  const capability = yield* acquireNativeScheduledPassageCapability(ctx, alive)
  const authority = yield* acquireNativeScheduledPassageAuthority(alive, dispatchAllowed, businessAllowed, capability.assertCurrent)
  const calendars = () => run(acquireNativeScheduledPassageCoverage(native, run))
  const now = options.now ?? Date.now
  const guard = (entry: Entry): (() => true) => () => { alive(); entry.signal.throwIfAborted(); entry.current(); return native.assertCurrent() }
  const storage: MissionStorage = {
    get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    scan: input => run(ctx.storage.scan(input)) as ReturnType<MissionStorage["scan"]>,
    set: async (key, value, current) => {
      alive(); current?.()
      await run(Effect.suspend(() => { alive(); current?.(); return ctx.storage.set(key, value) }))
      alive(); current?.()
    },
  }
  const context = async (document: MissionDocument, locked: NativeMissionDocumentStore, entry: Entry): Promise<NativeScheduledPassageContext> => {
    const entryCurrent = guard(entry), profile = document.calendarOwner?.profileSource
    const current = (): true => { entryCurrent(); return locked.assertActive() }
    current()
    if (!document.pending || !profile || profile.profileID !== document.pending.configuration.profileID
      || profile.executionHost !== document.pending.configuration.executionHost
      || document.projectID !== native.location.project.id || document.projectCanonical !== native.location.project.canonical
      || !document.pending.configuration.roots.some(root => root.directory === native.location.directory))
      throw new Error("Scheduled passage owner/profile unavailable")
    const humanGate = nativeHumanAnswerGate(use => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers(ctx)
      return yield* Effect.tryPromise(() => use(answers))
    })))
    const guardedAuthority: NativeScheduledPassageContext["authority"] = (doc, purpose) => { current(); authority(doc, purpose); return current() }
    const productive = await run(acquireMissionNativeService(current, run, () => capability.prepare(document))
      .pipe(Effect.provideService(Scope.Scope, scope)))
    return { document, locked, storage, native: productive, observation, authority: guardedAuthority, profile, signal: entry.signal, humanGate, current, now,
      qualifyBusiness: async () => { current(); await run(capability.prepare(document)); current() },
      environment: options.environment, lifecycle: options.lifecycle, businessAllowed }
  }
  const engine = (entry: Entry) => {
    const current = guard(entry)
    return new MissionDocumentPassageEngine(store, {
      incarnation: options.incarnation ?? incarnation, now, current,
      verifyWake: async (doc, wake) => (await calendars()).verifyWake(doc, wake, current, entry.signal),
      coverage: async (doc, window) => (await calendars()).coverage(doc, window, current, entry.signal),
      snapshot: async doc => {
        const reader = options.condition ?? await run(acquireNativeMissionConditionReader(ctx, store, run, entry.signal, current)
          .pipe(Effect.provideService(Scope.Scope, scope)))
        return prepareNativeDocumentSources(doc, native, entry.signal, current, reader, sourceFence())
      },
      admit: async (doc, locked) => admitNativeScheduledPassage(await context(doc, locked, entry), dispatchAllowed),
      observe: async (doc, locked) => observeNativeScheduledPassage(await context(doc, locked, entry)),
    })
  }
  const business = async <T>(sessionID: string, entry: Entry,
    use: (business: ReturnType<typeof nativeScheduledPassageBusiness>, rootID: string) => Promise<T>): Promise<T | undefined> => store.withExclusion(async locked => {
    const current = guard(entry), seen = new Set<string>()
    let id = sessionID
    for (let depth = 0; depth <= 32; depth++) {
      current()
      if (seen.has(id)) throw new Error("Scheduled passage ancestry cycle")
      seen.add(id)
      const session = await native.get({ sessionID: id }, { signal: entry.signal })
      if (session.id !== id) throw new Error("Scheduled passage ancestry differs")
      if (session.parentID) { id = session.parentID; continue }
      const marker = session.metadata?.["codenomad.mission"] as { missionID?: unknown; document?: { missionID?: unknown; passageID?: unknown } } | undefined
      if (marker?.document === undefined) return undefined
      if (typeof marker.document?.missionID !== "string") throw new Error("Scheduled passage marker unavailable")
      const doc = await locked.read(marker.document.missionID)
      if (!doc || "deletedAt" in doc || !doc.pending || marker.missionID !== doc.pending.missionID
        || canonicalAuthority(marker.document) !== canonicalAuthority(scheduledPassageMarker(doc))) throw new Error("Scheduled passage pending differs")
      // Every traversed actor must remain in this exact invocation Location.
      for (const actorID of seen) {
        const actor = await native.get({ sessionID: actorID }, { signal: entry.signal })
        if (actor.projectID !== doc.projectID || actor.location.directory !== native.location.directory
          || actor.location.workspaceID !== native.location.workspaceID) throw new Error("Scheduled passage actor moved")
      }
      const scoped = nativeScheduledPassageBusiness(await context(doc, locked, entry))
      const snapshot = await scoped.control.snapshot(), mission = snapshot.missions[0]
      if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.missions.length !== 1
        || mission.id !== doc.pending.missionID || mission.coordinatorSessionId !== doc.pending.coordinatorSessionID)
        throw new Error("Scheduled passage journal unavailable")
      const actor = mission.actors.find(actor => actor.sessionId === id)
      const selection = id === doc.pending.coordinatorSessionID ? doc.pending.configuration.profiles?.coordinator
        : doc.pending.configuration.profiles?.roles?.[actor?.roles[0] ?? ""]
      if (!actor || !selection || !matchesExecution(selection, session)) throw new Error("Scheduled passage root profile differs")
      return use(scoped, id)
    }
    throw new Error("Scheduled passage ancestry capacity")
  })
  return {
    preflight: (input: Entry & { missionID: string; wake: DocumentPassageWake; cutoff?: number }) => engine(input).preflight(input),
    wake: (input: Entry & { missionID: string; wake?: DocumentPassageWake; cutoff?: number }) => engine(input).wake(input),
    reconcile: (input: Entry & { missionID: string }) => engine(input).reconcile(input),
    runNow: (input: Entry & { missionID: string; requestID: string; expectedRevision: number }) => engine(input).runNow(input),
    controlPassage: (input: Entry & ScheduledPassageControl & { missionID: string }): Promise<{ pending: boolean }> => store.withExclusion(async locked => {
      guard(input)()
      const doc = await locked.read(input.missionID)
      if (!doc) throw new Error("Document passage control unavailable")
      if ("deletedAt" in doc || !doc.pending) return { pending: false }
      return controlNativeScheduledPassage(await context(doc, locked, input), input)
    }),
    businessSelection: (sessionID: string, entry: Entry) => business(sessionID, entry, async (_scoped, readSessionID) => ({ readSessionID })),
    executeBusiness: <T>(sessionID: string, entry: Entry, use: (control: MissionControl) => Promise<T>,
      tool?: { name: Parameters<MissionBusinessRoute["beforeTool"]>[0]; input: unknown }) => business(sessionID, entry, async (scoped, id) => {
        if (tool) await scoped.route(id).beforeTool(tool.name, tool.input)
        return { value: await use(scoped.control) }
      }),
    prepareBusiness: async (sessionID: string, entry: Entry): Promise<boolean> =>
      (await business(sessionID, entry, async scoped => { await scoped.environment(sessionID); return true })) ?? false,
  }
})

export type NativeScheduledPassageRuntime = Effect.Success<ReturnType<typeof acquireNativeScheduledPassageRuntime>>
export type NativeScheduledPassageAcquirer = <T>(use: (runtime: NativeScheduledPassageRuntime, entry: Entry) => Promise<T>) => Promise<T>
type PublicSessionReader = (sessionID: string) => Promise<{ id: string; parentID?: string; metadata?: unknown }>

/** Public facade prefilter: ordinary/daily families never acquire private Core
 * capabilities just to learn that their route belongs to another owner. */
export async function isNativeScheduledPassageFamily(sessionID: string, read: PublicSessionReader): Promise<boolean> {
  const seen = new Set<string>()
  let id = sessionID
  for (let depth = 0; depth <= 32; depth++) {
    if (seen.has(id)) throw new Error("Scheduled passage ancestry cycle")
    seen.add(id)
    const session = await read(id)
    if (session.id !== id) throw new Error("Scheduled passage ancestry differs")
    if (session.parentID) { id = session.parentID; continue }
    const metadata = session.metadata as Record<string, unknown> | undefined
    const marker = metadata?.["codenomad.mission"]
    return !!marker && typeof marker === "object" && "document" in marker
  }
  throw new Error("Scheduled passage ancestry capacity")
}

/** Use only with a qualified full-graph acquirer. Context/tool graphs require
 * the owned HTTP RPC bridge; capture alone preserves their partial services.
 * Every execute/prepare acquisition stays within its receiving invocation. */
export function createNativeScheduledPassageBusinessPort(acquire: NativeScheduledPassageAcquirer, current: () => true, read: PublicSessionReader) {
  return {
    select: async (sessionID: string): Promise<MissionBusinessRoute | undefined> => {
      current()
      if (!await isNativeScheduledPassageFamily(sessionID, read)) return undefined
      const selected = await acquire((runtime, entry) => runtime.businessSelection(sessionID, entry))
      if (!selected) return undefined
      let tool: Parameters<NativeScheduledPassageRuntime["executeBusiness"]>[3]
      return {
        get control(): MissionControl { throw new Error("Scheduled passage requires invocation-scoped execute") },
        readSessionID: selected.readSessionID, current,
        beforeTool: async (name, input) => { current(); tool = { name, input: structuredClone(input) } },
        execute: use => acquire(async (runtime, entry) => {
          current()
          const result = await runtime.executeBusiness(sessionID, entry, use, tool)
          if (result === undefined) throw new Error("Scheduled passage business disappeared")
          return result.value
        }),
      }
    },
    prepare: async (sessionID: string) => {
      current()
      if (!await isNativeScheduledPassageFamily(sessionID, read)) return false
      return acquire((runtime, entry) => runtime.prepareBusiness(sessionID, entry))
    },
  }
}
