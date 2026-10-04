import { MISSION_MAX_ACTORS, type MissionActor, type MissionMap, type MissionSnapshot } from "../model"

export interface NativeActorCapacityReservation {
  /** Fresh accepted shared projection, after the wrapper verifies actual native identity. */
  bound(childID: string, freshSnapshot: MissionMap | MissionSnapshot): void
  release(): void
}

interface Reservations {
  pending: Set<symbol>
  consumedChildren: Set<string>
}

// Like the project lock, survive content-addressed plugin reloads in this host.
// No storage, timers, replay or cross-process/durable authority is claimed.
const registryKey = Symbol.for("codenomad.missions.private-native-actor-capacity.v1")
const host = globalThis as typeof globalThis & { [registryKey]?: Map<string, Reservations> }
const reservations = host[registryKey] ??= new Map<string, Reservations>()
const actorIdentity = (actor: MissionActor) => JSON.stringify([
  actor.sessionId, actor.kind, actor.managed, actor.title,
  actor.location.directory, actor.location.workspaceID ?? null,
])
const sameLocation = (a: MissionActor, b: MissionActor) => a.location.directory === b.location.directory
  && a.location.workspaceID === b.location.workspaceID

function checkedActors(projectID: string, mission: MissionMap) {
  if (mission.projectID !== projectID || !mission.id || !mission.projectCanonical
    || !Number.isSafeInteger(mission.revision) || mission.revision < 1
    || mission.controlUnavailable || mission.notificationUnavailable) throw new Error("Actor capacity Mission identity/evidence unavailable")
  if (mission.actors.length > MISSION_MAX_ACTORS) throw new Error("Mission actor capacity already exceeded")
  const actors = new Map(mission.actors.map(actor => [actor.sessionId, actor]))
  const coordinator = actors.get(mission.coordinatorSessionId)
  if (actors.size !== mission.actors.length || [...actors.values()].some(actor => !actor.sessionId || !actor.location.directory)
    || !coordinator || coordinator.kind !== "coordinator"
    || mission.actors.filter(actor => actor.kind === "coordinator").length !== 1) throw new Error("Actor capacity inventory is damaged or incomplete")
  return { actors, coordinator }
}

function freshMission(projectID: string, missionID: string, fresh: MissionMap | MissionSnapshot): MissionMap {
  if (!("missions" in fresh)) return fresh
  if (fresh.projectID !== projectID || fresh.discardedEvents || fresh.controlUnavailable
    || fresh.notificationUnavailable || fresh.cleanupUnavailable) throw new Error("Actor capacity shared snapshot evidence unavailable")
  const matches = fresh.missions.filter(mission => mission.id === missionID)
  if (matches.length !== 1) throw new Error("Actor capacity Mission missing or ambiguous in fresh snapshot")
  return matches[0]
}

/** Call reserve and bound under the wrapper's existing project lock, using fresh
 * authoritative projections. Never hold that lock over the native executor.
 * Always release in finally. Existing-child ownership, execution policy and the
 * exact accepted task.native-bound event remain wrapper responsibilities.
 * This local slot fence does not qualify external writers, crashes or multiple
 * processes. Binding swaps a pending slot for its actual journal actor footprint.
 */
export function createNativeActorCapacityReservations(projectID: string) {
  if (!projectID) throw new Error("Actor capacity requires the trusted project ID")
  const reserve = (mission: MissionMap, existingChildID?: string): NativeActorCapacityReservation => {
    const { actors, coordinator } = checkedActors(projectID, mission)
    const scope = JSON.stringify([projectID, mission.projectCanonical, mission.id,
      coordinator.location.directory, coordinator.location.workspaceID ?? null])
    const missionID = mission.id, canonical = mission.projectCanonical, revision = mission.revision
    const coordinatorIdentity = actorIdentity(coordinator)
    const initialActors = new Map([...actors].map(([id, actor]) => [id, actorIdentity(actor)]))
    const existing = existingChildID === undefined ? undefined : actors.get(existingChildID)
    if (existingChildID !== undefined && (!existing || existing.kind !== "specialist" || !sameLocation(existing, coordinator))) throw new Error("Reuse actor is unknown, foreign or not an owned specialist")
    const newActor = existingChildID === undefined
    const state = reservations.get(scope) ?? { pending: new Set<symbol>(), consumedChildren: new Set<string>() }
    if (newActor && actors.size + state.pending.size >= MISSION_MAX_ACTORS) throw new Error("Mission native actor capacity reached before child creation")
    const token = Symbol("native-actor-slot")
    if (newActor) { state.pending.add(token); reservations.set(scope, state) }
    let status: "pending" | "bound" | "released" = "pending"
    let boundChildID: string | undefined
    let boundIdentity: string | undefined
    const removeSlot = () => {
      state.pending.delete(token)
      if (!state.pending.size && reservations.get(scope) === state) reservations.delete(scope)
    }
    const bound = (childID: string, freshSnapshot: MissionMap | MissionSnapshot) => {
      if (status === "released") throw new Error("Actor capacity reservation was released; no late binding")
      if (!childID || (existingChildID !== undefined && childID !== existingChildID)
        || (boundChildID !== undefined && childID !== boundChildID)) throw new Error("Actor capacity bound child identity mismatch")
      const fresh = freshMission(projectID, missionID, freshSnapshot)
      const current = checkedActors(projectID, fresh)
      if (fresh.id !== missionID || fresh.projectCanonical !== canonical || fresh.revision < revision
        || actorIdentity(current.coordinator) !== coordinatorIdentity) throw new Error("Actor capacity binding scope or coordinator changed")
      for (const [id, identity] of initialActors) {
        const actor = current.actors.get(id)
        if (!actor || actorIdentity(actor) !== identity) throw new Error("Actor capacity original inventory identity changed")
      }
      const child = current.actors.get(childID)
      if (!child || child.kind !== "specialist" || !sameLocation(child, current.coordinator)
        || (newActor && initialActors.has(childID))
        || (boundIdentity !== undefined && actorIdentity(child) !== boundIdentity)) throw new Error("Actual bound actor is unknown, foreign or mismatched")
      if (status === "bound") return // Idempotent observation, never free another slot.
      if (newActor) {
        if (state.consumedChildren.has(childID)) throw new Error("Another reservation already consumed this bound actor")
        if (current.actors.size + state.pending.size - 1 > MISSION_MAX_ACTORS) throw new Error("Actor capacity changed while native creation was in flight")
        state.consumedChildren.add(childID)
        removeSlot()
      }
      boundChildID = childID; boundIdentity = actorIdentity(child); status = "bound"
    }
    const release = () => {
      if (status === "released") return
      if (newActor && status === "pending") removeSlot()
      status = "released"
    }
    return { bound, release }
  }
  return { reserve }
}
