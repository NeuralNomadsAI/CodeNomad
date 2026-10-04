import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionLifecycleInput } from "../lib/mission-lifecycle-request"

export function missionLifecycleSource(instanceId: string, mission: MissionMap, location: {
  directory?: string; proxyPath?: string; projectID?: string; snapshotProjectID?: string
}): string {
  const coordinator = mission.actors?.find(actor => actor.kind === "coordinator" && actor.sessionId === mission.coordinatorSessionId)
  return JSON.stringify([instanceId, location.directory ?? null, location.proxyPath ?? null,
    location.projectID ?? mission.projectID, location.snapshotProjectID ?? mission.projectID, mission.id, mission.projectID,
    mission.projectCanonical, mission.coordinatorSessionId, coordinator?.location.directory ?? null, coordinator?.location.workspaceID ?? null])
}

interface Intent {
  readonly source: string
  readonly missionId: string
  readonly input: Readonly<MissionLifecycleInput>
}
const sameInput = (a: MissionLifecycleInput, b: MissionLifecycleInput) =>
  a.requestId === b.requestId && a.action === b.action && a.expectedRevision === b.expectedRevision
const key = (source: string, missionId: string, input: MissionLifecycleInput) => JSON.stringify([source, missionId, input.requestId])

export function createMissionLifecycleIntents(capacity = 64) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid lifecycle intent capacity")
  const records = new Map<string, Intent>(), running = new Set<Intent>()
  const [version, setVersion] = createSignal(0)
  const changed = () => setVersion(v => v + 1)
  const owns = (intent: Intent) => records.get(key(intent.source, intent.missionId, intent.input)) === intent
  const busy = (source: string) => { version(); return [...running].some(intent => intent.source === source) }
  const canReserve = (source: string, missionId: string, input: MissionLifecycleInput) => {
    version()
    const existing = records.get(key(source, missionId, input))
    return existing ? sameInput(existing.input, input) : records.size < capacity
  }
  return {
    available: () => { version(); return records.size < capacity },
    busy,
    retry: (source: string) => {
      version()
      let latest: Intent | undefined
      for (const intent of records.values()) if (intent.source === source) latest = intent
      return latest
    },
    canReserve,
    reserve(source: string, missionId: string, input: MissionLifecycleInput): Intent | undefined {
      if (!canReserve(source, missionId, input)) return undefined
      const id = key(source, missionId, input), existing = records.get(id)
      if (existing) return existing
      const intent = Object.freeze({ source, missionId, input: Object.freeze({ ...input }) })
      records.set(id, intent); changed()
      return intent
    },
    start(intent: Intent): boolean {
      if (!owns(intent) || busy(intent.source)) return false
      running.add(intent); changed()
      return true
    },
    finish(intent: Intent, outcome: "acknowledged" | "rejected" | "unknown"): boolean {
      if (!owns(intent)) return false
      running.delete(intent)
      if (outcome !== "unknown") records.delete(key(intent.source, intent.missionId, intent.input))
      changed()
      return true
    },
  }
}

// One renderer module instance per native window. Never persist, expire or evict
// unresolved inputs: at capacity, new reservations fail closed (including an
// untracked durable retry until another exact entry is resolved). No dispatcher.
export const missionLifecycleIntents = createMissionLifecycleIntents()
