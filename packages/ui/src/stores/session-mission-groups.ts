import { createSignal } from "solid-js"
import type { Session } from "../types/session"
import type { SessionThread } from "./session-tree"
import { readClientLayoutValue, writeClientLayoutValue } from "./client-state"

// Mission roots carry the native `codenomad.mission` session marker written by
// the Missions server (coordinator roots and independent task roots, kind
// "actor"). Native subagent children have a parent and keep native nesting.
export const MISSION_GROUP_ROW_ID = "codenomad:missions-group"
const OPEN_GROUPS_STORAGE_KEY = "opencode-session-mission-groups-open-v1"
const MAX_STORED_OPEN_GROUPS = 32
const TITLE_PREFIX = /^\s*Mission(?:\s+coordinator\s*:|\s*·)\s*/i

export interface MissionSessionMarker { missionID: string; kind: string }

export function readMissionMarker(session: Pick<Session, "metadata"> | undefined): MissionSessionMarker | null {
  const marker = (session?.metadata as Record<string, unknown> | undefined)?.["codenomad.mission"]
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null
  const { missionID, kind } = marker as Record<string, unknown>
  return typeof missionID === "string" && missionID && typeof kind === "string" ? { missionID, kind } : null
}

export function isMissionRootSession(session: Pick<Session, "metadata" | "parentId"> | undefined): boolean {
  return Boolean(session && !session.parentId && readMissionMarker(session))
}

/** Display-only: the stored native title keeps its prefix for search and rename. */
export function missionSessionTitle(title: string): string {
  return title.replace(TITLE_PREFIX, "").trim() || title
}

const byActivity = (a: SessionThread, b: SessionThread) =>
  b.latestUpdated - a.latestUpdated || b.session.id.localeCompare(a.session.id)

/** Splits root threads into ordinary families and Mission entries. Each Mission
 * coordinator nests its independent task roots; task roots whose coordinator is
 * not loaded remain direct Mission entries. Input order is kept for ordinary rows. */
export function partitionMissionThreads(threads: readonly SessionThread[]): { ordinary: SessionThread[]; missions: SessionThread[] } {
  const ordinary: SessionThread[] = []
  const coordinators = new Map<string, SessionThread>()
  const tasks = new Map<string, SessionThread[]>()
  for (const thread of threads) {
    const marker = thread.session.parentId ? null : readMissionMarker(thread.session)
    if (!marker) ordinary.push(thread)
    else if (marker.kind === "coordinator" && !coordinators.has(marker.missionID)) coordinators.set(marker.missionID, thread)
    else tasks.set(marker.missionID, [...(tasks.get(marker.missionID) ?? []), thread])
  }
  const missions: SessionThread[] = []
  for (const [missionID, coordinator] of coordinators) {
    const owned = tasks.get(missionID)
    tasks.delete(missionID)
    if (!owned?.length) { missions.push(coordinator); continue }
    const children = [...owned, ...coordinator.children].sort(byActivity)
    missions.push({
      ...coordinator, children, hasChildren: true,
      latestUpdated: Math.max(coordinator.latestUpdated, ...owned.map((task) => task.latestUpdated)),
    })
  }
  for (const orphaned of tasks.values()) missions.push(...orphaned)
  return { ordinary, missions: missions.sort(byActivity) }
}

/** Coordinator id under which a Mission root is nested in the group, if loaded. */
export function missionCoordinatorFor(instanceSessions: Map<string, Session>, root: Session): string | null {
  const marker = readMissionMarker(root)
  if (!marker || marker.kind === "coordinator" || root.parentId) return null
  for (const candidate of instanceSessions.values()) {
    const other = candidate.parentId ? null : readMissionMarker(candidate)
    if (other?.kind === "coordinator" && other.missionID === marker.missionID) return candidate.id
  }
  return null
}

const [version, setVersion] = createSignal(0)
let openGroups: string[] | null = null

function storedOpenGroups(): string[] {
  version()
  openGroups ??= (readClientLayoutValue(OPEN_GROUPS_STORAGE_KEY) ?? "").split("\n").filter(Boolean)
  return openGroups
}

/** Collapsed by default; the open state persists per instance in the window layout. */
export function isMissionGroupOpen(instanceId: string): boolean {
  return storedOpenGroups().includes(instanceId)
}

export function setMissionGroupOpen(instanceId: string, open: boolean): void {
  const current = storedOpenGroups()
  if (current.includes(instanceId) === open) return
  const next = open
    ? [instanceId, ...current].slice(0, MAX_STORED_OPEN_GROUPS)
    : current.filter((id) => id !== instanceId)
  openGroups = next
  writeClientLayoutValue(OPEN_GROUPS_STORAGE_KEY, next.join("\n"))
  setVersion((value) => value + 1)
}
