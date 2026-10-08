import { MissionControl } from "../../missions/control"
import type { MissionsPluginContext, MissionBusinessRoute } from "../missions-plugin"
import { sameLocation } from "../compatibility/location"
import type { RecurrenceDocument } from "../../missions/recurrence-contract"
import { matchesExecution } from "../../missions/execution"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { NativeMissionRecurrenceStore } from "../../missions/recurrence-store"
import { recurrencePassage } from "../../missions/recurrence-passage"
import type { NativeMissionSession } from "../../missions/control-types"
import type { MissionStorage } from "../../missions/journal"
import type { NativeHumanAnswerGate } from "../../missions/human-answer"

type Passage = { document: RecurrenceDocument; coordinatorSessionID: string; missionID: string;
  location: MissionsPluginContext["location"]; control: MissionControl; current(): true;
  read(): Promise<RecurrenceDocument | undefined>; prepare(sessionID: string): Promise<void> }
// The due Job and Promise plugin are separate bundles. This map contains only
// reconstructible native business handles; durable pending remains the owner.
const key = Symbol.for("codenomad.missions.native-passage-business/v2")
const root = globalThis as typeof globalThis & { [key]?: Map<string, Passage> }
const passages = root[key] ??= new Map<string, Passage>()

/** Native OpenCode can resume an existing turn before the user resumes its
 * interrupted schedule. Recover business reads/reports from the durable pending
 * identity without starting a Job, applying ENV or admitting any new prompt. */
async function restorePendingBusiness(context: MissionsPluginContext, session: NativeMissionSession, humanGate?: NativeHumanAnswerGate) {
  const marker = session.metadata?.["codenomad.mission"] as { recurrence?: { scheduleID?: unknown; passageID?: unknown } } | undefined
  const recurrence = marker?.recurrence
  if (!recurrence || typeof recurrence.scheduleID !== "string" || typeof recurrence.passageID !== "string") return undefined
  const source = new NativeMissionRecurrenceStore(context.storage, context.location.project.id, context.location.project.canonical)
  const doc = await source.read(recurrence.scheduleID)
  if (!doc?.pending || doc.pending.passage.id !== recurrence.passageID
    || !doc.config.roots.some(root => root.directory === context.location.directory)) throw new Error("Pending passage business differs")
  let installed = false
  let passage!: Passage
  const current = (): true => {
    if (installed && passages.get(passage.coordinatorSessionID) !== passage) throw new Error("Recovered passage business retired")
    if (!sameLocation(session.location, context.location) || session.projectID !== context.location.project.id)
      throw new Error("Pending passage Location changed")
    return true
  }
  const storage: MissionStorage = { get: key => context.storage.get(key), scan: options => context.storage.scan(options),
    set: async (key, value, guard) => {
      guard?.(); current()
      const fresh = await source.read(doc.id)
      if (fresh?.pending?.passage.id !== doc.pending!.passage.id || canonicalAuthority(fresh.config) !== canonicalAuthority(doc.config))
        throw new Error("Pending passage journal closed")
      guard?.(); current()
      await context.storage.set(key, value)
    } }
  const isolated = recurrencePassage(storage, doc, current)
  const snapshot = await isolated.journal.snapshot()
  if (snapshot.missions.length !== 1 || snapshot.discardedEvents || snapshot.controlUnavailable
    || snapshot.notificationUnavailable || snapshot.missions[0].coordinatorSessionId !== isolated.coordinatorSessionID)
    throw new Error("Pending passage journal unavailable")
  const actor = snapshot.missions[0].actors.find(actor => actor.sessionId === session.id && sameLocation(actor.location, session.location))
  const selection = session.id === isolated.coordinatorSessionID ? doc.config.profiles?.coordinator
    : doc.config.profiles?.roles?.[actor?.roles[0] ?? ""]
  if (!actor || !selection || !matchesExecution(selection, session)) throw new Error("Pending passage actor differs")
  const unavailable = async (): Promise<never> => { throw new Error("Resume the schedule before new passage admission") }
  const control = new MissionControl({ project: { id: doc.projectID, canonical: doc.projectCanonical, location: session.location },
    storage: isolated.storage, humanGate, sessions: { get: input => context.session.get(input), create: unavailable,
      prompt: unavailable, synthetic: unavailable } })
  passage = { document: doc, coordinatorSessionID: isolated.coordinatorSessionID, missionID: isolated.missionID,
    location: context.location, control, current, read: () => source.read(doc.id), prepare: unavailable }
  publishNativePassageBusiness(passage)
  installed = true
  return passage
}

export function publishNativePassageBusiness(passage: Passage) {
  passage.current()
  if (!passage.document.pending) throw new Error("Passage pending identity unavailable")
  // ponytail: bounded cache, reconstructed on every Job wake after restart.
  if (!passages.has(passage.coordinatorSessionID) && passages.size >= 64) {
    for (const [id, previous] of passages) {
      try { previous.current() } catch { passages.delete(id) }
    }
    if (passages.size >= 64) throw new Error("Passage business capacity")
  }
  passages.set(passage.coordinatorSessionID, passage)
}

/** Frozen handoff's invocation-scoped selection, without its authority/effect
 * qualification. Native ancestry selects storage; tool input cannot select it. */
export async function selectNativePassageBusiness(context: MissionsPluginContext, sessionID: string,
  humanGate?: NativeHumanAnswerGate): Promise<MissionBusinessRoute | undefined> {
  const seen = new Set<string>()
  let id = sessionID
  for (let depth = 0; depth <= 32; depth++) {
    if (seen.has(id)) throw new Error("Passage ancestry cycle")
    seen.add(id)
    const session = await context.session.get({ sessionID: id })
    if (session.id !== id || session.projectID !== context.location.project.id || !sameLocation(session.location, context.location))
      throw new Error("Passage session moved")
    if (session.parentID) { id = session.parentID; continue }
    let passage = passages.get(id)
    const marker = session.metadata?.["codenomad.mission"] as { recurrence?: unknown; missionID?: unknown } | undefined
    if (!passage && marker?.missionID !== undefined) {
      for (const candidate of passages.values()) {
        if (candidate.missionID !== marker.missionID || !sameLocation(candidate.location, context.location)) continue
        candidate.current()
        const mission = (await candidate.control.snapshot()).missions.find(mission => mission.id === candidate.missionID)
        if (mission?.actors.some(actor => actor.sessionId === id && sameLocation(actor.location, session.location))) {
          passage = candidate
          break
        }
      }
    }
    if (!passage && marker?.recurrence !== undefined) passage = await restorePendingBusiness(context, session, humanGate)
    if (!passage) {
      if (marker?.recurrence !== undefined) throw new Error("Passage business not yet reconciled")
      return undefined
    }
    passage.current()
    const doc = await passage.read()
    if (!doc?.pending || doc.pending.passage.id !== passage.document.pending!.passage.id
      || marker?.missionID !== passage.missionID || !sameLocation(passage.location, context.location)) {
      passages.delete(id)
      throw new Error("Passage no longer pending")
    }
    if (id === passage.coordinatorSessionID && (!matchesExecution(doc.config.profiles?.coordinator, session)
      || canonicalAuthority(marker?.recurrence) !== canonicalAuthority({ scheduleID: doc.id, passageID: doc.pending.passage.id })))
      throw new Error("Passage coordinator changed")
    return { control: passage.control, readSessionID: id, current: passage.current,
      beforeTool: async (_name, raw) => {
        const input = raw as { missionID?: unknown; start?: unknown }
        if (input.missionID !== undefined && input.missionID !== passage.missionID || input.start !== undefined)
          throw new Error("Passage tool identity differs")
        passage.current()
        const latest = await passage.read()
        if (latest?.pending?.passage.id !== doc.pending!.passage.id) throw new Error("Passage changed")
      } }
  }
  throw new Error("Passage ancestry capacity")
}

/** Every native prompt in the family gets the fresh execution-host profile ENV;
 * native subagent/permissions remain untouched. No custom executor or receipt. */
export async function prepareNativePassageSession(context: MissionsPluginContext, sessionID: string, humanGate?: NativeHumanAnswerGate) {
  const selected = await selectNativePassageBusiness(context, sessionID, humanGate)
  if (!selected) return
  const passage = [...passages.values()].find(passage => passage.control === selected.control)
  if (!passage) throw new Error("Passage preparation unavailable")
  selected.current()
  await passage.prepare(sessionID)
  selected.current()
}

export function retireNativePassageBusiness(location: MissionsPluginContext["location"]) {
  for (const [id, passage] of passages) if (sameLocation(passage.location, location)) passages.delete(id)
}
