import { z } from "zod"
import { sameLocation } from "../opencode/compatibility/location"
import type { MissionActivityInput, MissionObservedRequests } from "./activity"
import type { MissionActivityProjection } from "./model"
import { contentDigest } from "./content-digest"
import { MISSION_ACTIVITY_ACTORS, MISSION_MARK_ACTORS, MISSION_MARK_MISSIONS, type MissionActivityContext } from "./mission-activity-context"
import { isMissionPanelPageResult, missionPanelBytes, missionPanelPage, MISSION_PANEL_PAGE_BYTES,
  type MissionPanelCursor, type MissionPanelPageRequest, type MissionPanelPageResult } from "./mission-panel-page"

type Request = Extract<MissionPanelPageRequest, { source: "activity" | "marks" }>
/** Invalid plugin data uses the existing foreign/invalid RPC response path. */
export class MissionPanelObservationError extends Error {}
export interface MissionPanelActivityObservation {
  context: MissionActivityContext
  coverage: "observed" | "partial" | "unknown"
  requests: { state: "observed" | "partial" | "unknown"; items: Array<{
    kind: "form" | "permission"; actorSessionId: string
    request: MissionObservedRequests["forms"][number] | MissionObservedRequests["permissions"][number]
  }> }
  activity: { actors: MissionActivityProjection["missions"][number]["actors"]; family: {
    state: "observed" | "partial" | "unknown"
    members: Array<Omit<NonNullable<MissionActivityProjection["missions"][number]["family"]>["members"][number], "kind"> & { kind?: "declared" | "ordinary" }>
  } }
}
export interface MissionPanelMarkObservations {
  missionPage: { order: string; offset: number; end: number; total: number }
  observations: MissionPanelActivityObservation[]
}
const count = z.number().int().nonnegative().safe(), id = z.string().min(1).max(240)
const DAMAGE_FIELDS = ["discardedEvents", "controlUnavailable", "notificationUnavailable", "cleanupUnavailable"] as const
const contextSchema = z.object({ id, projectID: id, revision: count, status: z.enum(["active", "completed", "failed", "stopped"]),
  runState: z.enum(["prepared", "running", "paused", "stopped"]).optional(), coordinatorSessionId: id,
  actors: z.array(z.object({ sessionId: id, title: z.string().max(240), location: z.object({ directory: z.string().min(1).max(20_000), workspaceID: id.optional() }).strict(),
    reportOwed: z.boolean(), callOpen: z.boolean(), taskContext: z.object({ invalid: z.boolean(), taskKey: z.string().max(64).optional(), parentSessionID: id.optional() }).strict().optional(),
  }).strict()).max(MISSION_ACTIVITY_ACTORS), actorPage: z.object({ order: z.string().length(43), offset: count, end: count, total: count }).strict(),
  control: z.object({ id, requestID: id, expectedRevision: count, completedRevision: count.optional(), action: z.enum(["start", "pause", "stop"]),
    graceful: z.literal(true).optional(), pending: count, receipts: count, unconfirmedReceipts: count, partialDescendants: count }).strict().optional(),
  discardedEvents: count, controlUnavailable: z.boolean(), notificationUnavailable: z.boolean(), cleanupUnavailable: z.boolean(),
}).strict().refine(value => value.actorPage.offset <= value.actorPage.end && value.actorPage.end <= value.actorPage.total
  && (value.actorPage.offset === value.actorPage.total || value.actorPage.end > value.actorPage.offset)
  && value.actorPage.end - value.actorPage.offset === value.actors.length && new Set(value.actors.map(actor => actor.sessionId)).size === value.actors.length)
const marksSchema = z.object({ contexts: z.array(contextSchema).max(MISSION_MARK_MISSIONS),
  missionPage: z.object({ order: z.string().length(43), offset: count, end: count, total: count }).strict(),
}).strict().refine(value => value.contexts.every(context => context.actors.length <= MISSION_MARK_ACTORS)
  && new Set(value.contexts.map(context => context.id)).size === value.contexts.length
  && value.missionPage.offset <= value.missionPage.end && value.missionPage.end <= value.missionPage.total
  && (value.missionPage.offset === value.missionPage.total || value.missionPage.end > value.missionPage.offset)
  && value.missionPage.end - value.missionPage.offset === value.contexts.length)

/** Reads bounded persisted context, then observes outside the journal append exclusion.
 * RPC returns context; HTTP adds live evidence. Both use panelPage's exact byte transport.
 * Every continuation re-observes; another content digest refuses rather than splicing.
 * No observations are retained and no changed-source request is automatically restarted. */
export async function readMissionPanelObservation(request: Request, input: {
  projectID: string
  read(request: MissionPanelPageRequest): Promise<unknown>
  observe(context: MissionActivityInput, requests: (value: MissionObservedRequests) => void): Promise<MissionActivityProjection>
  current(): boolean
}): Promise<MissionPanelPageResult> {
  let cursor: MissionPanelCursor | undefined, text = "", header: Omit<Extract<MissionPanelPageResult, { available: true }>, "page" | "available" | "version"> | undefined
  let digest: string | undefined, characters: number | undefined
  do {
    const result = await input.read({ ...request, cursor })
    if (!isMissionPanelPageResult(result) || missionPanelBytes(result) > MISSION_PANEL_PAGE_BYTES) throw new MissionPanelObservationError("Invalid mission activity context")
    if (!result.available) return result
    digest ??= result.page.digest
    if (result.projectID !== input.projectID || result.source !== request.source || result.phase !== "context"
      || result.missionID !== (request.source === "activity" ? request.missionID : undefined) || result.field !== undefined
      || result.observedAt !== undefined || (request.source === "activity" ? result.revision === undefined : result.revision !== undefined)
      || DAMAGE_FIELDS.some(field => result[field] === undefined)
      || result.page.total !== 1 || !result.page.pieces.length || result.page.digest !== digest) throw new MissionPanelObservationError("Foreign mission activity context")
    const { page: _page, available: _available, version: _version, ...own } = result
    const keys = Object.keys(own) as Array<keyof typeof own>
    if (header && (keys.length !== Object.keys(header).length || keys.some(key => own[key] !== header![key]))) throw new MissionPanelObservationError("Changed mission activity header")
    header ??= own
    for (const piece of result.page.pieces) {
      // 160 records with existing journal string bounds fit below this assembly bound,
      // including maximal JSON escapes. It bounds untrusted intermediate data, not totals.
      characters ??= piece.characters
      if (piece.index !== 0 || piece.offset !== text.length || characters > 24 * 1024 * 1024 || piece.characters !== characters
        || !piece.text.length || piece.offset + piece.text.length > characters) throw new MissionPanelObservationError("Invalid mission activity slice")
      text += piece.text
    }
    cursor = result.page.next
    if (cursor ? cursor.digest !== digest || cursor.index !== 0 || cursor.offset !== text.length || cursor.offset >= characters!
      : text.length !== characters) throw new MissionPanelObservationError("Invalid mission activity continuation")
  } while (cursor)
  if (contentDigest(`[${text}]`) !== digest) throw new MissionPanelObservationError("Invalid mission activity digest")
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new MissionPanelObservationError("Invalid mission activity JSON") }
  const context = request.source === "activity" ? contextSchema.safeParse(parsed) : undefined
  const directory = request.source === "marks" ? marksSchema.safeParse(parsed) : undefined
  if (context && !context.success || directory && !directory.success) throw new MissionPanelObservationError("Invalid mission activity actors")
  const contexts: MissionActivityContext[] = context?.success ? [context.data] : directory?.success ? directory.data.contexts : []
  if (contexts.some(context => context.projectID !== input.projectID) || contexts.reduce((n, context) => n + context.actors.length, 0) > MISSION_ACTIVITY_ACTORS
    || request.source === "activity" && (contexts[0].id !== request.missionID || contexts[0].revision !== header!.revision
      || contexts[0].actorPage.offset !== Math.min(request.actorOffset ?? 0, contexts[0].actorPage.total)
      || request.actorOrder !== undefined && request.actorOrder !== contexts[0].actorPage.order
      || DAMAGE_FIELDS.some(field => contexts[0][field] !== header![field]))
    || request.source === "marks" && directory?.success && (directory.data.missionPage.offset !== Math.min(request.missionOffset ?? 0, directory.data.missionPage.total)
      || request.missionOrder !== undefined && request.missionOrder !== directory.data.missionPage.order
      || contexts.some(context => context.actorPage.offset !== 0))) throw new MissionPanelObservationError("Foreign mission actors")
  const captures: MissionObservedRequests[] = []
  const activity = await input.observe({ projectID: input.projectID, missions: contexts.map(context => ({ ...context,
    tasks: [], reports: [], actors: context.actors, actorEvidence: {
      reportOwed: context.actors.filter(actor => actor.reportOwed).map(actor => actor.sessionId),
      callOpen: context.actors.filter(actor => actor.callOpen).map(actor => actor.sessionId),
    }, taskContexts: Object.fromEntries(context.actors.filter(actor => actor.taskContext).map(actor => [actor.sessionId, actor.taskContext!])),
  })) }, value => captures.push(value))
  if (!input.current()) return { available: false, reason: "observation-unavailable" }
  const values: MissionPanelActivityObservation[] = contexts.map(context => {
    const observed = activity.missions.find(mission => mission.missionId === context.id)!, own = new Set(context.actors.map(actor => actor.sessionId))
    const partial = context.actorPage.end - context.actorPage.offset < context.actorPage.total
    const family = observed.family ?? { state: "unknown", members: [] }
    const members = new Map(family.members.map(member => [member.sessionId, member]))
    const requests = captures.flatMap(capture => {
      const roots = new Set(capture.ownedActors.filter(id => context.actors.some(actor => actor.sessionId === id && sameLocation(actor.location, capture.location))))
      const actorOf = (sessionID: string) => roots.has(sessionID) ? sessionID
        : family.state !== "unknown" && roots.has(members.get(sessionID)?.actorSessionId ?? "") ? members.get(sessionID)!.actorSessionId : undefined
      return [...(capture.formsObserved ? capture.forms.map(form => ({ kind: "form" as const, request: form, actorSessionId: actorOf(form.sessionID) })) : []),
        ...(capture.permissionsObserved ? capture.permissions.map(permission => ({ kind: "permission" as const, request: permission, actorSessionId: actorOf(permission.sessionID) })) : [])]
        .filter(item => item.actorSessionId !== undefined).map(item => ({ ...item, actorSessionId: item.actorSessionId! }))
    })
    const requestComplete = family.state === "observed" && captures.every(capture => capture.formsObserved && capture.permissionsObserved)
      && context.actors.every(actor => captures.some(capture => capture.ownedActors.includes(actor.sessionId) && sameLocation(actor.location, capture.location)))
      && !captures.some(capture => [...capture.forms, ...capture.permissions].some(item => !item.sessionID?.trim() || item.sessionID === "global"))
    const damaged = context.discardedEvents > 0 || context.controlUnavailable || context.notificationUnavailable || context.cleanupUnavailable
    return { context, coverage: damaged || family.state === "unknown" ? "unknown" : partial || family.state === "partial" ? "partial" : "observed",
      requests: { state: requestComplete && !damaged ? partial ? "partial" : "observed" : requests.length ? "partial" : "unknown", items: requests },
      activity: { actors: observed.actors, family: { state: family.state === "observed" && partial ? "partial" : family.state,
        members: family.members.map(member => {
          // Another declared actor may be outside this window. Its ordinary/declared
          // classification and task context stay unspecified until that actor is read.
          if (!partial || own.has(member.sessionId)) return member
          const { kind: _kind, taskKey: _task, ...identity } = member
          return identity
        }) } } }
  })
  const missionPage = directory?.success ? directory.data.missionPage : undefined
  const value: MissionPanelActivityObservation | MissionPanelMarkObservations = request.source === "activity" ? values[0] : { missionPage: missionPage!, observations: values }
  return missionPanelPage({ ...header!, phase: "observed", observedAt: activity.generatedAt }, [value], request.cursor)
}
