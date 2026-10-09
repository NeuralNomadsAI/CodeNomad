import type { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Option, Schema } from "effect"
import { Location } from "@opencode/schema/location"
import type { MissionStorage } from "../../missions/journal"
import { MissionRecurrenceRunner, type RecurrenceAuthorizedAdmission } from "../../missions/recurrence-runner"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { acquireNativeRecurrenceStore } from "./native-recurrence-storage"
import { admitNativeRecurrencePassage, PassageNotStartedError } from "./native-recurrence-admission"
import { recurrenceDispatchAllowed, type RecurrenceDocument } from "../../missions/recurrence-contract"
import { stableToken } from "../../missions/journal"
import { observeNativePassageSettlement } from "./native-recurrence-settlement"
import { settleNativePassageBusiness } from "./native-passage-business"
import { acquireMissionNativeService } from "./native-service-adapter"
import { acquireNativePassageObservation } from "./native-passage-observation"
import type { AutonomousProfileSource } from "./autonomous-environment"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"
import { runMissionExclusive } from "../../missions/exclusive"
import { acquireNativeHumanAnswers } from "./native-human-answer"

export type NativePassagePlacement = Readonly<{ projectID: string; projectCanonical: string; directory: string;
  workspaceID?: string; scheduleID: string; profileID: string; executionHost: string;
  profileSource?: AutonomousProfileSource; humanGate?: NativeHumanAnswerGate;
  manual?: { requestID: string; expectedRevision: number } }>
export type NativePassageWake = "idle" | "started" | "pending" | "settled"
type WakeEffect = Effect.Effect<NativePassageWake, Error | Schema.SchemaError, import("effect").Scope.Scope>
export interface NativePassageDue {
  (scheduleID: string, graphCurrent: () => true, signal: AbortSignal): WakeEffect
}
const locationTag = Context.Service<never, unknown>("@opencode/Location")

/** Called in the freshly borrowed native Location graph on every Job wake.
 * Detached storage/placement only; no backend presence or signed child ledger. */
export function nativeRecurrenceDue(ctx: Pick<Plugin.Context, "storage" | "location">, placement: NativePassagePlacement,
  now: () => number = Date.now): NativePassageDue {
  const storageContext = ctx.storage
  const wake = (scheduleID: string, graphCurrent: () => true, signal: AbortSignal) => Effect.gen(function* () {
    if (scheduleID !== placement.scheduleID) throw new Error("Recurrence Job schedule differs")
    graphCurrent(); signal.throwIfAborted()
    const origin = yield* Effect.serviceOption(locationTag)
    if (Option.isNone(origin)) throw new Error("Recurrence Location unavailable")
    const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
    const current = (): true => {
      graphCurrent()
      if (location.directory !== placement.directory || location.workspaceID !== placement.workspaceID
        || location.project.id !== placement.projectID || location.project.canonical !== placement.projectCanonical)
        throw new Error("Recurrence Job Location changed")
      return true
    }
    current()
    const exact = { storage: storageContext, location: new Location.Info(location) }
    const source = yield* acquireNativeRecurrenceStore(exact)
    const native = yield* acquireMissionNativeService(current)
    const observation = yield* acquireNativePassageObservation()
    const graph = yield* Effect.context<never>()
    const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect.pipe(Effect.provide(graph)))
    const humanGate: NativeHumanAnswerGate = placement.humanGate ?? (request => run(Effect.gen(function* () {
      const answers = yield* acquireNativeHumanAnswers(exact)
      return yield* Effect.tryPromise(() => answers.verify(request))
    })))
    const storage: MissionStorage = {
      get: key => run(storageContext.get(key)) as ReturnType<MissionStorage["get"]>,
      scan: options => run(storageContext.scan(options)) as ReturnType<MissionStorage["scan"]>,
      set: async (key, value, fence) => { current(); fence?.(); await run(storageContext.set(key, value)); current(); fence?.() },
    }
    const admission: RecurrenceAuthorizedAdmission = {
      authorize: async (document, purpose) => {
        if (purpose === "dispatch" && !placement.profileSource) throw new Error("Recurrence profile source unavailable")
        current()
        const fresh = await source.read(scheduleID)
        if (!fresh || canonicalAuthority(fresh) !== canonicalAuthority(document)
          || fresh.config.profileID !== placement.profileID || fresh.config.executionHost !== placement.executionHost
          || !fresh.config.roots.some(root => root.directory === placement.directory)
          || purpose === "dispatch" && fresh.state !== "running") throw new Error("Recurrence admission changed")
        return current
      },
      admit: async document => {
        if (!placement.profileSource) throw new Error("Recurrence profile source unavailable")
        return admitNativeRecurrencePassage({ document: structuredClone(document), storage, native, observation,
          profile: placement.profileSource, signal, current, read: () => source.read(scheduleID),
          humanGate, now })
      },
    }
    /** Deterministic only: the failure is a not-started classification or the
     * schedule no longer allows dispatch, and the original message is natively absent. */
    const unstartable = async (pending: RecurrenceDocument, error: unknown) => {
      const fresh = await source.read(scheduleID)
      if (!fresh?.pending || fresh.revision !== pending.revision || fresh.pending.admission) return false
      if (!(error instanceof PassageNotStartedError) && recurrenceDispatchAllowed(fresh)) return false
      const passage = fresh.pending.passage
      current()
      return !(await observation.exists(passage.coordinatorSessionID))
        || !(await observation.session(passage.coordinatorSessionID, passage.messageID)).messagePresent
    }
    const doc = yield* Effect.promise(() => source.read(scheduleID))
    if (!doc) return "idle" as NativePassageWake
    if (placement.manual) {
      const due = doc.pending?.passage.due
      if (due?.kind !== "manual" || due.requestID !== placement.manual.requestID
        || due.expectedRevision !== placement.manual.expectedRevision) throw new Error("Manual passage identity differs")
    }
    if (doc.config.profileID !== placement.profileID || doc.config.executionHost !== placement.executionHost
      || !doc.config.roots.some(root => root.directory === placement.directory)) throw new Error("Recurrence Job binding differs")
    if (doc.pending) {
      return yield* Effect.tryPromise(() => runMissionExclusive(`recurrence-flight:${source.projectToken}:${scheduleID}`, async (): Promise<NativePassageWake> => {
        // Reconstruct business routing even for an already admitted passage.
        // Admission checks the original inbox/message first and does not resend.
        const pending = await source.read(scheduleID)
        if (!pending?.pending) return "settled"
        let ack: Awaited<ReturnType<typeof admission.admit>>
        try { ack = await admission.admit(pending, async () => current) }
        catch (error) {
          if (pending.pending.admission || !await unstartable(pending, error)) throw error
          // Exact native absence of the original start message and no way to build or
          // dispatch it: archive failed/not-started. Nothing was sent, so nothing can
          // replay; the coordinator session stays as-is and cursors do not advance.
          const passage = pending.pending.passage
          await source.finish(scheduleID, { passageID: passage.id, messageID: passage.messageID,
            missionID: `msn_${stableToken(`${pending.projectID}\0${passage.id}`, 24)}`, conversationID: passage.coordinatorSessionID,
            outcome: "failed", reason: "not-started", artifactMessageIDs: [], cursors: [] }, now(), current, pending.revision)
          return "settled"
        }
        if (!pending.pending.admission) await source.recordAdmission(scheduleID, ack, now(), current)
        const fresh = await source.read(scheduleID)
        if (!fresh?.pending) return "settled"
        const result = await observeNativePassageSettlement({ document: fresh, storage, native: observation,
          directory: placement.directory, workspaceID: placement.workspaceID, current, signal })
        if (!result) return "pending"
        await source.finish(scheduleID, result.result, now(), current, result.expectedRevision)
        settleNativePassageBusiness(result.result.conversationID)
        return "settled"
      })).pipe(Effect.catchCause(() => Effect.succeed("pending" as NativePassageWake)))
    }
    if (doc.state !== "running") return "idle" as NativePassageWake
    const outcome = yield* Effect.tryPromise(() => new MissionRecurrenceRunner(source, admission, now).tick(scheduleID))
    return (outcome === "accepted" ? "started" : ["pending", "unknown"].includes(outcome) ? "pending" : "idle") as NativePassageWake
  })
  return wake
}
