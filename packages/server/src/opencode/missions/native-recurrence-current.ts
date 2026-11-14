import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Context, Effect, Option, Schema } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { currentRecurrenceContent, recurrenceCurrentInput, recurrenceCurrentContentInput, recurrenceCurrentPageInput } from "../../missions/recurrence-current"
import { recurrencePassage } from "../../missions/recurrence-passage"
import type { MissionStorage } from "../../missions/journal"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { NativeMissionDocumentStore } from "../../missions/mission-document-store"
import { missionDocumentPassage } from "../../missions/mission-document-passage-storage"
import { contentDigest } from "../../missions/content-digest"
import { projectMissionPanel } from "../../missions/mission-panel-projection"
import { missionPanelPage } from "../../missions/mission-panel-page"
import { readMissionContent } from "../../missions/mission-content"
import { missionPlanChanges } from "../../missions/model"
import type { MissionCurrentSource } from "../../missions/mission-current-source"
import type { MissionCurrentIdentity } from "../../missions/mission-current-source"
import type { MissionPanelPageResult } from "../../missions/mission-panel-wire"
import { MISSION_DOCUMENT_MAX_BYTES } from "../../missions/launch-policy"
import { RECURRENCE_MAX_BYTES } from "../../missions/recurrence-contract"
import { nativeInvocation } from "./native-invocation"

const locationTag = Context.Service<never, unknown>("@opencode/Location")
const OWNER_BYTES = Math.max(MISSION_DOCUMENT_MAX_BYTES, RECURRENCE_MAX_BYTES)
const invocation = nativeInvocation(30000)
const equal = (a: unknown, b: unknown) => canonicalAuthority(a ?? null, OWNER_BYTES) === canonicalAuthority(b ?? null, OWNER_BYTES)

/** One isolated range per page/content request; identity reads never reconstruct a map. */
const readCurrent = Effect.fn("missions.readNativeRecurrenceCurrent")(function* (
  ctx: Pick<Plugin.Context, "storage" | "location">, raw: unknown, mode: "identity" | "page" | "content",
) {
  const pageInput = mode === "page" ? recurrenceCurrentPageInput.parse(raw) : undefined
  const input = pageInput ? { scheduleID: pageInput.source.scheduleID, owner: pageInput.source.owner }
    : mode === "content" ? recurrenceCurrentContentInput.parse(raw) : recurrenceCurrentInput.parse(raw)
  const origin = yield* Effect.serviceOption(locationTag)
  if (Option.isNone(origin)) throw new Error("Native recurrence Location unavailable")
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin.value)
  const current = (): true => {
    if (location.directory !== ctx.location.directory || location.workspaceID !== ctx.location.workspaceID
      || location.project.id !== ctx.location.project.id || location.project.canonical !== ctx.location.project.canonical)
      throw new Error("Recurrence Location changed")
    return true
  }
  current()
  const run = <A>(effect: Effect.Effect<A, unknown>) => invocation.check(run => run(effect))
  const storage: MissionStorage = {
    get: key => run(ctx.storage.get(key)) as ReturnType<MissionStorage["get"]>,
    set: async () => { throw new Error("Current passage reader is read-only") },
    scan: async options => {
      current()
      const page = await run(ctx.storage.scan(options)) as Awaited<ReturnType<MissionStorage["scan"]>>
      // Each entry is bounded; the journal validates and bounds its own accepted range.
      for (const entry of page.entries) canonicalAuthority(entry.value, 256 * 1024)
      return page
    },
  }
  const identity = { version: 1 as const, projectID: location.project.id, projectCanonical: location.project.canonical,
    location: { directory: location.directory, ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }) }, scheduleID: input.scheduleID }
  let passage: ReturnType<typeof recurrencePassage> | ReturnType<typeof missionDocumentPassage> | undefined
  let source: MissionCurrentSource | undefined, profiles: unknown, taskMode: unknown
  let ownerRevision = 0
  let reread!: () => Promise<boolean>
  if (input.owner === "scheduled") {
    const store = new NativeMissionDocumentStore({ get: storage.get, compareAndSet: async () => { throw new Error("Current passage is read-only") } }, identity.projectID, identity.projectCanonical)
    const doc = yield* Effect.promise(() => store.read(input.scheduleID))
    if (!doc || !("configuration" in doc) || !doc.configuration.roots.some(root => root.directory === location.directory)) throw new Error("Current schedule unavailable")
    ownerRevision = doc.revision
    if (doc.pending) {
      passage = missionDocumentPassage(storage, doc, current)
      profiles = doc.pending.configuration.profiles; taskMode = doc.pending.configuration.taskMode
      source = { owner: "scheduled", projectID: identity.projectID, scheduleID: doc.id, passageID: passage.passageID, missionID: passage.missionID,
        digest: contentDigest(canonicalAuthority({ pending: doc.pending, configurationGeneration: doc.configurationGeneration, timeGeneration: doc.timeGeneration,
          roots: doc.configuration.roots }, OWNER_BYTES)), configurationGeneration: doc.configurationGeneration, timeGeneration: doc.timeGeneration }
    }
    reread = async () => equal(await store.read(doc.id), doc)
  } else {
    const store = new NativeMissionRecurrenceStore(storage, identity.projectID, identity.projectCanonical)
    const doc = yield* Effect.promise(() => store.read(input.scheduleID))
    if (!doc || !doc.config.roots.some(root => root.directory === location.directory)) throw new Error("Current recurrence schedule unavailable")
    ownerRevision = doc.revision
    if (doc.pending) {
      passage = recurrencePassage(storage, doc, current); profiles = doc.config.profiles; taskMode = doc.config.taskMode
      source = { owner: "daily", projectID: identity.projectID, scheduleID: doc.id, passageID: passage.passageID,
        missionID: passage.missionID, digest: contentDigest(canonicalAuthority({ pending: doc.pending, profiles: doc.config.profiles, taskMode: doc.config.taskMode, roots: doc.config.roots }, OWNER_BYTES)) }
    }
    reread = async () => equal(await store.read(doc.id), doc)
  }
  if (pageInput && (!source || !equal(pageInput.source, source))) throw new Error("Current passage changed")
  if ("passageID" in input && input.passageID !== passage?.passageID) throw new Error("Current passage changed")
  let answer: unknown
  if (mode === "identity") answer = { ...identity, ownerRevision, passageID: passage?.passageID ?? null, ...(source ? { source } : {}) }
  else {
    if (!passage || !source) throw new Error("Current passage content unavailable")
    const view = yield* Effect.promise(() => passage!.journal.missionView(passage!.missionID)), mission = view.mission
    if (view.discardedEvents || view.controlUnavailable || view.notificationUnavailable || view.cleanupUnavailable) throw new Error("Current passage journal unavailable")
    if (!mission) throw new Error("Current passage has not been admitted")
    if (mission.projectID !== identity.projectID || mission.projectCanonical !== identity.projectCanonical
      || mission.id !== passage.missionID || mission.coordinatorSessionId !== passage.coordinatorSessionID || !equal(mission.profiles, profiles) || mission.taskMode !== taskMode)
      throw new Error("Current passage identity differs")
    if (!view.events.some(event => event.type === "mission.created" && event.missionID === passage!.missionID && event.requestID === passage!.passageID))
      throw new Error("Current passage creation differs")
    if (mode === "content") answer = { ...currentRecurrenceContent(mission, input), projectCanonical: identity.projectCanonical, location: identity.location }
    else if (pageInput!.body) answer = missionPanelPage({ projectID: mission.projectID, missionID: mission.id, revision: mission.revision,
      discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false,
      source: "mission", field: "body", passage: source, window: { offset: 0, end: 1, total: 1, order: contentDigest(JSON.stringify(pageInput!.body)) } },
    [{ available: true, ...readMissionContent(mission.projectID, pageInput!.body, mission, () => missionPlanChanges(view.events, mission.id)) }], pageInput!.selector.cursor)
    else {
      const selector = pageInput!.selector
      if (selector.source === "summaries" || selector.source === "cleanups" || selector.source === "marks" || selector.source === "task-marks") throw new Error("Current passage selector differs")
      answer = projectMissionPanel(mission, selector, { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }, { passage: source })
    }
  }
  if (!(yield* Effect.promise(reread))) throw new Error("Current passage changed")
  current()
  return answer
})

export const readNativeRecurrenceCurrent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => invocation.capture(readCurrent(ctx, input, "identity").pipe(Effect.timeout("30 seconds"), Effect.map(value => value as MissionCurrentIdentity)))
export const readNativeRecurrenceCurrentPage = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => invocation.capture(readCurrent(ctx, input, "page").pipe(Effect.timeout("30 seconds"), Effect.map(value => value as MissionPanelPageResult)))
export const readNativeRecurrenceCurrentContent = (ctx: Pick<Plugin.Context, "storage" | "location">, input: unknown) => invocation.capture(readCurrent(ctx, input, "content").pipe(Effect.timeout("30 seconds"), Effect.map(value => value as ReturnType<typeof currentRecurrenceContent> & Pick<MissionCurrentIdentity, "projectCanonical" | "location">)))
