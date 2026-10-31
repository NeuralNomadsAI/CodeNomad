import { isSessionNotFoundError, type LocationRef, type OpenCodeClient, type ShellInfo } from "@opencode/client"

import { locationRequestOptions, sameLocation } from "../opencode/compatibility/location"
import type { MissionActivityProjection, MissionSnapshot } from "./model"
import { MAX_MISSION_DESCENDANTS, observeActiveDescendant, readNativeMissionFamilyTree, type NativeMissionFamilyTree } from "./native-session-family"
import { projectMissionFamily } from "./mission-family-projection"
import { runningMissionShellRelation } from "./native-shell-correlation"
import { missionTaskExecutionEvidence } from "./execution-evidence"
import { missionIsRunning } from "./lifecycle-model"
import { isCoordinatorNotificationReport } from "./native-report-provenance"

// Native reads per refresh stay bounded however many missions a project keeps and
// actors a mission has: running, then other active missions' actors are observed
// first, then the most recently updated. Beyond the budget, actors waiting on an
// answer, then those with open work, come first; the rest read as unknown.
const MAX_PROJECTED_ACTORS = 160
const MAX_FAMILY_READS = 2 * (MAX_MISSION_DESCENDANTS + 1) * MAX_PROJECTED_ACTORS
const MAX_FAMILY_SESSIONS = (MAX_MISSION_DESCENDANTS + 1) * MAX_PROJECTED_ACTORS
const READ_CONCURRENCY = 4
const ACTIVE_DESCENDANT_PROBE_MS = 5_000
/** Session reads of one ancestry walk phase: attributing open requests to the actors
 * they descend from, or probing oversized families for active descendants. */
const ANCESTRY_READS = 128

type OwnsLocation = (workspaceID: string, location: LocationRef, client: OpenCodeClient) => Promise<boolean>

interface ActorRead {
  session?: Awaited<ReturnType<OpenCodeClient["session"]["get"]>>
  inbox?: Awaited<ReturnType<OpenCodeClient["session"]["inbox"]["list"]>>
  family?: Set<string>
  tree?: NativeMissionFamilyTree
  missing?: true
  failed?: true
  /** Owned root whose bounded family read failed, e.g. more than 32 descendants. */
  familyFailed?: true
  /** Positive ancestry evidence of an active descendant despite that failure. */
  activeDescendant?: boolean
}

interface LocationRead {
  shells: ShellInfo[]
  forms: Array<{ sessionID: string }>
  permissions: Array<{ sessionID: string }>
  failed: boolean
}

/**
 * Builds a bounded, display-only reconciliation of a Mission snapshot with current
 * native state. It never infers execution from the journal's last outcome.
 */
export async function projectMissionActivity(input: {
  client: OpenCodeClient
  snapshot: MissionSnapshot
  workspaceID: string
  ownsLocation: OwnsLocation
  /** Required for observed family membership; capture real connection/deletion
   * identity in the route. Omission preserves legacy actor display only. */
  isCurrent?: () => boolean
  now?: () => number
}): Promise<MissionActivityProjection> {
  const unknownProjection = (): MissionActivityProjection => ({
    generatedAt: (input.now ?? Date.now)(),
    missions: input.snapshot.missions.map(mission => ({ missionId: mission.id,
      actors: mission.actors.map(actor => ({ sessionId: actor.sessionId, state: "unknown" })),
      family: { state: "unknown", members: [] } })),
  })
  let stale = false
  const assertCurrent = () => {
    try { if (stale || (input.isCurrent && !input.isCurrent())) throw new Error("Stale mission observation") }
    catch (error) { stale = true; throw error }
  }
  try { assertCurrent() } catch { return unknownProjection() }
  const observe = async <T>(read: () => Promise<T>): Promise<T> => {
    assertCurrent()
    try { return await read() } finally { assertCurrent() }
  }
  // The snapshot is ordered by most recent update; a stable sort puts running missions
  // first, with gracefully paused ones whose steps may still be finishing (the panel
  // offers Interrupt now only while it observes them), then the other active ones.
  const pausing = (mission: MissionSnapshot["missions"][number]) => mission.status === "active" && !mission.controlUnavailable
    && mission.runState === "paused" && mission.control?.action === "pause" && Boolean(mission.control.graceful)
  const rank = (mission: MissionSnapshot["missions"][number]) => missionIsRunning(mission) || pausing(mission) ? 2 : mission.status === "active" ? 1 : 0
  const missions = [...input.snapshot.missions].sort((left, right) => rank(right) - rank(left))
  const occurrences = missions.flatMap(mission => mission.actors.map(actor => ({ mission, actor })))
  const actorIDs = [...new Set(occurrences.map(({ actor }) => actor.sessionId))]
  const missingReports = new Set<string>()
  const unsettledCalls = new Set<string>()
  for (const { mission, actor } of occurrences) {
    const key = `${mission.id}\0${actor.sessionId}`
    // A running mission's coordinator still owes its final report, unless a saved
    // report's coordinator notification is still being delivered to wake it.
    if (actor.sessionId === mission.coordinatorSessionId && missionIsRunning(mission) && !mission.reports.some(report =>
      report.notificationStatus === "pending" && isCoordinatorNotificationReport(report))) missingReports.add(key)
    for (const task of mission.tasks.filter(task => task.actorSessionId === actor.sessionId)) {
      const evidence = missionTaskExecutionEvidence(task)
      if (evidence.missingReport) missingReports.add(key)
      if (evidence.nativeCall === "active" || evidence.nativeCall === "unknown") unsettledCalls.add(key)
    }
  }

  const signal = AbortSignal.timeout(15_000)
  const locationReads = new Map<string, LocationRead>()
  const readLocation = async (key: string, location: LocationRef) => {
    const options = { ...locationRequestOptions(location), signal }
    const requestLocation = { location: { directory: location.directory } }
    const shells = await settle(() => observe(() => input.client.shell.list(requestLocation, options)))
    const forms = await settle(() => observe(() => input.client.form.list(requestLocation, options)))
    const permissions = await settle(() => observe(() => input.client.permission.request.list(requestLocation, options)))
    const responseLocations = [shells, forms, permissions].flatMap(result => result.ok ? [result.value.location] : [])
    const failed = !shells.ok || !forms.ok || !permissions.ok
      || responseLocations.some(response => response.directory !== location.directory)
    locationReads.set(key, {
      shells: shells.ok ? shells.value.data : [],
      forms: forms.ok ? forms.value.data : [],
      permissions: permissions.ok ? permissions.value.data : [],
      failed,
    })
  }
  // More actors than one refresh reads: those whose own conversation or a descendant
  // asks for an answer come first, then those with open work, each in mission order.
  const prioritized = async (): Promise<string[]> => {
    const locations = new Map(occurrences.map(({ actor }) => [locationKey(actor.location), actor.location]))
    await readBounded([...locations].slice(0, MAX_PROJECTED_ACTORS), async ([key, location]) => {
      const owned = await settle(() => observe(() => input.ownsLocation(input.workspaceID, location, input.client)))
      if (owned.ok && owned.value) await readLocation(key, location)
    })
    const declared = new Set(actorIDs), asking = new Set<string>()
    const parents = new Map<string, string | undefined>(), budget = { reads: ANCESTRY_READS }
    for (const read of locationReads.values()) {
      if (read.failed) continue
      for (const { sessionID } of [...read.forms, ...read.permissions]) {
        const seen = new Set<string>()
        let cursor: string | undefined = sessionID === "global" ? undefined : sessionID
        while (cursor && !declared.has(cursor) && !seen.has(cursor)) {
          seen.add(cursor)
          if (!parents.has(cursor)) {
            if (budget.reads-- <= 0) break
            const id = cursor, session = await settle(() => observe(() => input.client.session.get({ sessionID: id }, { signal })))
            parents.set(id, session.ok ? session.value.parentID : undefined)
          }
          cursor = parents.get(cursor)
        }
        if (cursor && declared.has(cursor)) asking.add(cursor)
      }
    }
    const working = new Set([...missingReports, ...unsettledCalls].map(key => key.slice(key.indexOf("\0") + 1)))
    const tier = (id: string) => asking.has(id) ? 0 : working.has(id) ? 1 : 2
    return actorIDs.map((id, index) => ({ id, index, tier: tier(id) }))
      .sort((left, right) => left.tier - right.tier || left.index - right.index)
      .slice(0, MAX_PROJECTED_ACTORS).map(item => item.id)
  }
  const sessionIDs = actorIDs.length > MAX_PROJECTED_ACTORS ? await prioritized() : actorIDs
  const selected = new Set(sessionIDs)
  const unread = new Set(actorIDs.filter(id => !selected.has(id)))
  const actorReads = new Map<string, ActorRead>()
  await readBounded(sessionIDs, async sessionID => {
    const sessionResult = await settle(() => observe(() => input.client.session.get({ sessionID }, { signal })))
    if (!sessionResult.ok) {
      actorReads.set(sessionID, isMissing(sessionResult.error) ? { missing: true } : { failed: true })
      return
    }
    actorReads.set(sessionID, { session: sessionResult.value })
  })

  const authorizedLocations = new Map<string, LocationRef>()
  let familyReads = 0
  await readBounded([...actorReads.entries()], async ([sessionID, read]) => {
    if (!read.session || read.failed) return
    const owned = await settle(() => observe(() => input.ownsLocation(input.workspaceID, read.session!.location, input.client)))
    if (!owned.ok || !owned.value || read.session.projectID !== input.snapshot.projectID
      || read.session.id !== sessionID
      || !occurrences.some(({ actor }) => actor.sessionId === read.session!.id && sameLocation(actor.location, read.session!.location))) {
      read.failed = true
      return
    }
    authorizedLocations.set(locationKey(read.session.location), read.session.location)
    const family = await settle(() => readNativeMissionFamilyTree(input.client, read.session!, signal, { assertCurrent,
      consumeRead: () => { if (++familyReads > MAX_FAMILY_READS) throw new Error("Mission family read budget exceeded") } }))
    if (!family.ok) { read.failed = true; read.familyFailed = true; return }
    read.tree = family.value
    read.family = new Set(family.value.keys())
  })
  // Deduplicate overlapping actor families, with no nested parallel fan-out.
  const familyIDs = [...new Set([...actorReads.values()].flatMap(read => [...(read.family ?? [])]))]
  if (familyIDs.length > MAX_FAMILY_SESSIONS) return unknownProjection()
  const inboxes = new Map<string, Awaited<ReturnType<typeof input.client.session.inbox.list>>>()
  await readBounded(familyIDs, async sessionID => {
    const result = await settle(() => observe(() => input.client.session.inbox.list({ sessionID }, { signal })))
    if (result.ok) inboxes.set(sessionID, result.value)
  })
  for (const read of actorReads.values()) {
    if (!read.family) continue
    if ([...read.family].some(id => !inboxes.has(id))) read.failed = true
    else read.inbox = [...read.family].flatMap(id => inboxes.get(id)!)
  }

  const activeResult = await settle(() => observe(() => input.client.session.active({ signal })))

  await readBounded([...authorizedLocations.entries()].filter(([key]) => !locationReads.has(key)), ([key, location]) => readLocation(key, location))

  // Oversized families: probe ancestry after the location reads, with one shared
  // parent cache, read budget and bound, so it cannot starve the other reads.
  if (activeResult.ok) {
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(ACTIVE_DESCENDANT_PROBE_MS)])
    const parents = new Map<string, string | undefined>(), budget = { reads: ANCESTRY_READS }
    for (const [sessionID, read] of actorReads) {
      if (!read.familyFailed || activeResult.value[sessionID]) continue
      const probe = await settle(() => observe(() => observeActiveDescendant(input.client, sessionID, activeResult.value, probeSignal, { parents, budget })))
      read.activeDescendant = probe.ok && probe.value
    }
  }

  // Cross-mission reuse may overlap, but changed parent/location observations
  // cannot be published as two simultaneously truthful display families.
  const conflicts = new Set<string>()
  const identities = new Map<string, { session: NonNullable<ActorRead["session"]>; roots: Set<string> }>()
  for (const [rootID, read] of actorReads) {
    if (read.failed || !read.tree) continue
    for (const [id, session] of read.tree) {
      const prior = identities.get(id)
      if (prior) {
        prior.roots.add(rootID)
        if (prior.session.parentID !== session.parentID || prior.session.projectID !== session.projectID
          || !sameLocation(prior.session.location, session.location)) conflicts.add(id)
      } else identities.set(id, { session, roots: new Set([rootID]) })
    }
  }
  for (const id of conflicts) for (const rootID of identities.get(id)!.roots) actorReads.get(rootID)!.failed = true
  for (const read of actorReads.values()) {
    if (read.failed || !read.tree) continue
    for (const [id, session] of read.tree) {
      // A root GET elsewhere in the shared snapshot must not contradict this
      // catalog's descendant, even when the two actors belong to other missions.
      const direct = actorReads.get(id)
      if (direct && (!direct.session || direct.session.id !== id || direct.session.parentID !== session.parentID
        || direct.session.projectID !== session.projectID || !sameLocation(direct.session.location, session.location))) read.failed = true
    }
    for (const { session } of identities.values()) {
      if (session.parentID && read.tree.has(session.parentID) && !read.tree.has(session.id)) {
        read.failed = true
        for (const rootID of identities.get(session.id)!.roots) actorReads.get(rootID)!.failed = true
      }
    }
  }
  const trees = new Map<string, NativeMissionFamilyTree>()
  for (const [id, read] of actorReads) {
    if (!read.failed && read.tree && read.session && locationReads.get(locationKey(read.session.location))?.failed === false) trees.set(id, read.tree)
  }
  try { assertCurrent() } catch { return unknownProjection() }
  const projection: MissionActivityProjection = {
    generatedAt: (input.now ?? Date.now)(),
    missions: input.snapshot.missions.map(mission => ({
      missionId: mission.id,
      family: projectMissionFamily({ mission, trees, observed: Boolean(input.isCurrent) && activeResult.ok, unread }),
      actors: mission.actors.map(actor => {
        if (!actorReads.has(actor.sessionId)) return { sessionId: actor.sessionId, state: "unknown" as const }
        const read = actorReads.get(actor.sessionId)!
        if (read.missing) return { sessionId: actor.sessionId, state: "missing" as const }
        // An oversized/partial family is still positive evidence of ongoing work:
        // never let it read as unknown and invite recovery of a busy mission.
        if (read.familyFailed && activeResult.ok && read.session && sameLocation(read.session.location, actor.location)) {
          // Membership is unknown, but the actor's own (or a global) request is not.
          const resources = locationReads.get(locationKey(read.session.location))
          const own = (item: { sessionID: string }) => item.sessionID === actor.sessionId || item.sessionID === "global"
          if (resources && !resources.failed && resources.permissions.some(own)) return { sessionId: actor.sessionId, state: "permission" as const }
          if (resources && !resources.failed && resources.forms.some(own)) return { sessionId: actor.sessionId, state: "form" as const }
          if (activeResult.value[actor.sessionId]) return { sessionId: actor.sessionId, state: "running" as const }
          if (read.activeDescendant) return { sessionId: actor.sessionId, state: "background" as const }
        }
        if (read.failed || !read.session || !read.inbox || !read.family || !activeResult.ok
          || !sameLocation(read.session.location, actor.location)) {
          return { sessionId: actor.sessionId, state: "unknown" as const }
        }
        const resources = locationReads.get(locationKey(read.session.location))
        if (!resources || resources.failed) return { sessionId: actor.sessionId, state: "unknown" as const }
        const key = `${mission.id}\0${actor.sessionId}`
        const shellRelations = resources.shells.map(shell => runningMissionShellRelation(shell, read.family!))
        const related = (sessionID: string) => sessionID === "global" || read.family!.has(sessionID)
        const state = resources.permissions.some(item => related(item.sessionID)) ? "permission"
          : resources.forms.some(item => related(item.sessionID)) ? "form"
            : activeResult.value[actor.sessionId] ? "running"
              : [...read.family].some(id => id !== actor.sessionId && activeResult.value[id])
                 || shellRelations.includes("related") ? "background"
                  : (missingReports.has(key) || unsettledCalls.has(key)) && read.inbox.length ? "queued"
                    : shellRelations.includes("unknown") || unsettledCalls.has(key) ? "unknown"
                      : missingReports.has(key) ? "idle-without-report"
                       : "unknown"
        return { sessionId: actor.sessionId, state }
      }),
    })),
  }
  try { assertCurrent() } catch { return unknownProjection() }
  return projection
}

function locationKey(location: LocationRef): string {
  return `${location.directory}\0${location.workspaceID ?? ""}`
}

function isMissing(error: unknown): boolean {
  return isSessionNotFoundError(error) || Boolean(error && typeof error === "object" && "status" in error
    && (error as { status?: unknown }).status === 404)
}

async function settle<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try { return { ok: true, value: await read() } }
  catch (error) { return { ok: false, error } }
}

async function readBounded<T>(items: T[], read: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await read(items[next++])
  }))
}
