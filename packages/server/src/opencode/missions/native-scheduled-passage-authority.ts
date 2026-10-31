import { Context, Effect, Option, Predicate, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { MISSION_DOCUMENT_PREFIX, parseMissionDocument, type MissionDocument } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import { missionLaunchLimit } from "../../missions/launch-policy"

export type ScheduledPassagePurpose = "observe" | "initial" | "business"
export type ScheduledPassageAuthority = (doc: MissionDocument, purpose: ScheduledPassagePurpose) => true
export function documentManualPassageAllowed(doc: MissionDocument): boolean {
  return !!doc.pending && doc.pending.origin.kind === "manual" && doc.pending.manualAllowed === true
    && doc.state === "paused" && !doc.deletion && !doc.blocked && !doc.synchronization
}
export function documentPassageDispatchAllowed(doc: MissionDocument): boolean {
  const maximum = missionLaunchLimit(doc.pending?.configuration.launch ?? doc.configuration.launch)
  return !!doc.pending && doc.pending.admittedAt === null && (maximum === null || doc.launchedCount < maximum)
    && !doc.deletion && !doc.blocked && (!doc.synchronization || doc.state === "finished" && doc.synchronization.kind === "disarm")
    && (doc.state === "running" || documentManualPassageAllowed(doc) || doc.state === "finished")
}
export function documentPassageBusinessAllowed(doc: MissionDocument): boolean {
  return !!doc.pending && doc.pending.admittedAt !== null && !doc.deletion && !doc.blocked
    && (doc.state === "running" || doc.state === "finished" || documentManualPassageAllowed(doc))
}

/** Synchronous point-read fence consumed at native effect entry, against the
 * unified key itself. The owner supplies fresh incarnation/placement/capability
 * checks; no recurrence namespace or schema participates. */
export const acquireNativeScheduledPassageAuthority = Effect.fn("missions.acquireScheduledPassageAuthority")(function* (
  current: () => true,
  dispatchAllowed: (doc: MissionDocument) => boolean = documentPassageDispatchAllowed,
  businessAllowed: (doc: MissionDocument) => boolean = documentPassageBusinessAllowed,
  capability: (doc: MissionDocument) => true = () => { throw new Error("Scheduled passage capability unavailable") },
) {
  const databaseTag = Context.Service<never, unknown>("@opencode/storage/Database")
  const locationTag = Context.Service<never, unknown>("@opencode/Location")
  const found = yield* Effect.serviceOption(databaseTag), placed = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(found) || Option.isNone(placed)) throw new Error("Document passage authority unavailable")
  const database = found.value as { db?: { $client?: SqlClient.SqlClient } }
  const location = placed.value as { directory?: unknown; project?: { id?: unknown; canonical?: unknown } }
  if (!Predicate.isFunction(database.db?.$client?.unsafe)) throw new Error("Document passage SQL authority unavailable")
  const graph = yield* Effect.context<never>()
  const rows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
  return ((expected: MissionDocument, purpose: ScheduledPassagePurpose): true => {
    current()
    if (Context.get(graph, databaseTag) !== found.value || Context.get(graph, locationTag) !== placed.value
      || location.project?.id !== expected.projectID || location.project.canonical !== expected.projectCanonical
      || !expected.pending?.configuration.roots.some(root => root.directory === location.directory)) throw new Error("Document passage placement changed")
    const key = `${MISSION_DOCUMENT_PREFIX}/project/${stableToken(`${expected.projectID}\0${expected.projectCanonical}`, 24)}/missions/${expected.id}`
    const namespace = `plugin:${Array.from("codenomad.missions").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`
    const value = Effect.runSync(database.db!.$client!.unsafe("SELECT value FROM kv WHERE key=?", [`${namespace}${key}`])
      .withoutTransform.pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), Effect.provide(graph)))[0]?.value
    if (typeof value !== "string") throw new Error("Document passage authority missing")
    const doc = parseMissionDocument(JSON.parse(value), expected)
    if (!doc.pending || doc.pending.id !== expected.pending.id || doc.pending.missionID !== expected.pending.missionID
      || doc.pending.messageID !== expected.pending.messageID || doc.pending.coordinatorSessionID !== expected.pending.coordinatorSessionID
      || doc.pending.timeGeneration !== expected.pending.timeGeneration || doc.pending.configurationGeneration !== expected.pending.configurationGeneration
      || canonicalAuthority(doc.pending.configuration) !== canonicalAuthority(expected.pending.configuration)
      || canonicalAuthority(doc.pending.checkpoints) !== canonicalAuthority(expected.pending.checkpoints)
      || purpose === "initial" && (doc.pending.admittedAt !== null || !dispatchAllowed(doc))
      || purpose === "business" && !businessAllowed(doc)) throw new Error("Document passage authority changed")
    if (purpose !== "observe") {
      if (canonicalAuthority(doc.calendarOwner?.installation) !== canonicalAuthority(expected.calendarOwner?.installation))
        throw new Error("Scheduled passage installation changed")
      capability(doc)
    }
    return current()
  }) satisfies ScheduledPassageAuthority
})
