import { createHash } from "node:crypto"
import { compactMissionMap, missionPanelReports } from "./mission-compact-map"
import { contentDigest } from "./content-digest"
import { missionActivityContext } from "./mission-activity-context"
import type { MissionMap } from "./model"

/** Small root fields stay exact; all other values remain reachable by exact field.
 * Descriptors preserve wide extensions without embedding actor-scale collections. */
export function missionPanelHeader(mission: MissionMap) {
  const map = compactMissionMap(mission), values = { ...map, claims: mission.claims, frontier: mission.frontier,
    reports: missionPanelReports(mission), tasks: mission.tasks } as unknown as Record<string, unknown>
  const root: Record<string, unknown> = {}, collections: Record<string, { characters: number; digest: string; total: number; array: boolean }> = {}
  const eager = new Set(["version", "id", "projectID", "projectCanonical", "title", "template", "status", "runState", "finishSequence", "coordinatorSessionId",
    "revision", "createdAt", "updatedAt", "historyTruncated", "controlUnavailable", "notificationUnavailable", "excerpt", "bodies", "briefing", "briefingResponses", "profiles", "taskMode", "preparedBy"])
  const deferred = new Set(["actors", "tasks", "reports", "history", "claims", "frontier", "control", "actorEvidence", "taskPage"])
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (key === "tasks") continue // the task source has its own order/window contract
    const text = JSON.stringify(value)
    if (eager.has(key) && (key === "projectCanonical" || text.length <= 32_768) || !eager.has(key) && !deferred.has(key) && text.length <= 4096) root[key] = value
    else collections[key] = { characters: text.length, digest: contentDigest(text), total: Array.isArray(value) ? value.length : 1, array: Array.isArray(value) }
  }
  const context = missionActivityContext(mission, { discardedEvents: 0, controlUnavailable: false, notificationUnavailable: false, cleanupUnavailable: false }), control = context.control
  Object.assign(collections.actors, { order: context.actorPage.order })
  // Keep the exact version of the full task array without constructing one
  // JSON string containing every task body.
  const taskDigest = createHash("sha256").update("[", "utf16le")
  for (const [index, task] of mission.tasks.entries()) {
    if (index) taskDigest.update(",", "utf16le")
    taskDigest.update(JSON.stringify(task), "utf16le")
  }
  taskDigest.update("]", "utf16le")
  const tasks = { page: map.taskPage!, pins: map.tasks.filter(task => task.order! >= (map.taskPage?.end ?? 0)).map(task => task.id),
    reportPins: map.reports.filter(report => !map.tasks.some(task => task.key === report.taskKey)).map(report => report.id),
    version: contentDigest(`${taskDigest.digest("base64url")}\0${collections.reports.digest}`) }
  const coordinator = mission.actors.find(actor => actor.kind === "coordinator" && actor.sessionId === mission.coordinatorSessionId)
  return { root, collections, tasks, ...(coordinator ? { coordinator: { ...coordinator, location: { ...coordinator.location }, roles: [...coordinator.roles] } } : {}), ...(control ? { control } : {}) }
}

export function attachPanelHeaderDocument(header: ReturnType<typeof missionPanelHeader>, document: MissionMap["document"]) {
  if (!document) return header
  const text = JSON.stringify(document)
  return text.length <= 4096 ? { ...header, root: { ...header.root, document } } : {
    ...header, collections: { ...header.collections, document: { characters: text.length, digest: contentDigest(text), total: 1, array: false } },
  }
}
