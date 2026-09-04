export const MISSION_SCHEMA_VERSION = 1 as const
export const MISSION_MAX_ACTORS = 8
export const MISSION_MAX_EVENTS = 2_000
export const MISSION_MAX_MISSIONS = 20
export const MISSION_MAX_TASKS = 96

export type MissionTemplateId = "custom" | "pocock-fix-bug" | "wayfinder"
export type MissionStatus = "active" | "completed" | "failed"
export type MissionTaskStatus =
  | "blocked"
  | "ready"
  | "dispatching"
  | "queued"
  | "completed"
  | "needs-input"
  | "failed"
export type MissionReportOutcome = "completed" | "blocked" | "failed"
export type MissionActorRuntimeStatus = "working" | "idle" | "unknown"

export interface MissionLocation {
  directory: string
  workspaceID?: string
}

export interface MissionActor {
  sessionId: string
  kind: "coordinator" | "specialist"
  managed: boolean
  title: string
  roles: string[]
  location: MissionLocation
  joinedAt: number
  runtimeStatus?: MissionActorRuntimeStatus
}

export interface MissionReport {
  id: string
  taskKey: string
  sessionId: string
  outcome: MissionReportOutcome
  summary: string
  evidence: string[]
  next: string[]
  createdAt: number
}

export interface MissionTask {
  id: string
  key: string
  title: string
  brief: string
  role: string
  blockedBy: string[]
  status: MissionTaskStatus
  actorSessionId?: string
  admissionId?: string
  delivery?: "queue" | "steer"
  createdAt: number
  updatedAt: number
  report?: MissionReport
}

export interface MissionMap {
  version: typeof MISSION_SCHEMA_VERSION
  id: string
  projectID: string
  projectCanonical: string
  objective: string
  notes?: string
  template: MissionTemplateId
  status: MissionStatus
  summary?: string
  coordinatorSessionId: string
  actors: MissionActor[]
  tasks: MissionTask[]
  reports: MissionReport[]
  frontier: string[]
  claims: string[]
  createdAt: number
  updatedAt: number
  revision: number
}

export interface MissionSnapshot {
  version: typeof MISSION_SCHEMA_VERSION
  projectID: string
  generatedAt: number
  missions: MissionMap[]
  discardedEvents: number
}

export interface MissionListAvailableResponse extends MissionSnapshot {
  available: true
}

export interface MissionListUnavailableResponse {
  available: false
  reason: "plugin-unavailable" | "workspace-unavailable"
  missions: []
}

export type MissionListResponse = MissionListAvailableResponse | MissionListUnavailableResponse

interface MissionEventBase {
  version: typeof MISSION_SCHEMA_VERSION
  id: string
  missionID: string
  projectID: string
  createdAt: number
}

export interface MissionCreatedEvent extends MissionEventBase {
  type: "mission.created"
  projectCanonical: string
  objective: string
  notes?: string
  template: MissionTemplateId
  coordinator: {
    sessionID: string
    title: string
    location: MissionLocation
  }
}

export interface MissionTaskCreatedEvent extends MissionEventBase {
  type: "task.created"
  task: {
    id: string
    key: string
    title: string
    brief: string
    role: string
    blockedBy: string[]
  }
}

export interface MissionTaskDispatchingEvent extends MissionEventBase {
  type: "task.dispatching"
  taskKey: string
  actor: {
    sessionID: string
    title: string
    location: MissionLocation
    managed: boolean
  }
  admissionID: string
  delivery: "queue" | "steer"
}

export interface MissionTaskDispatchedEvent extends MissionEventBase {
  type: "task.dispatched"
  taskKey: string
}

export interface MissionTaskReportedEvent extends MissionEventBase {
  type: "task.reported"
  report: MissionReport
}

export interface MissionReportNotifiedEvent extends MissionEventBase {
  type: "report.notified"
  reportID: string
  admissionID: string
}

export interface MissionFinishedEvent extends MissionEventBase {
  type: "mission.finished"
  outcome: "completed" | "failed"
  summary: string
}

export type MissionEvent =
  | MissionCreatedEvent
  | MissionTaskCreatedEvent
  | MissionTaskDispatchingEvent
  | MissionTaskDispatchedEvent
  | MissionTaskReportedEvent
  | MissionReportNotifiedEvent
  | MissionFinishedEvent

export function reduceMissionEvents(events: readonly MissionEvent[], now = Date.now()): MissionSnapshot {
  const ordered = [...events].sort(compareEvents)
  const discarded = { count: 0 }
  const groups = new Map<string, MissionEvent[]>()
  for (const event of ordered) {
    const group = groups.get(event.missionID) ?? []
    group.push(event)
    groups.set(event.missionID, group)
  }

  const missions = [...groups.values()].flatMap((group) => {
    const mission = reduceMission(group, discarded)
    return mission ? [mission] : []
  }).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MISSION_MAX_MISSIONS)

  return {
    version: MISSION_SCHEMA_VERSION,
    projectID: missions[0]?.projectID ?? events[0]?.projectID ?? "",
    generatedAt: now,
    missions,
    discardedEvents: discarded.count + Math.max(0, groups.size - MISSION_MAX_MISSIONS),
  }
}

function reduceMission(events: readonly MissionEvent[], discarded: { count: number }): MissionMap | undefined {
  const created = events.find((event): event is MissionCreatedEvent => event.type === "mission.created")
  if (!created) {
    discarded.count += events.length
    return undefined
  }

  const tasks = new Map<string, MissionTask>()
  const actors = new Map<string, MissionActor>()
  const reports: MissionReport[] = []
  let status: MissionStatus = "active"
  let updatedAt = created.createdAt

  actors.set(created.coordinator.sessionID, {
    sessionId: created.coordinator.sessionID,
    kind: "coordinator",
    managed: false,
    title: created.coordinator.title,
    roles: ["coordinator"],
    location: created.coordinator.location,
    joinedAt: created.createdAt,
  })

  for (const event of events) {
    updatedAt = Math.max(updatedAt, event.createdAt)
    if (event.projectID !== created.projectID || event.missionID !== created.missionID) {
      discarded.count += 1
      continue
    }
    if (event.type === "task.created") {
      if (tasks.has(event.task.key) || tasks.size >= MISSION_MAX_TASKS) {
        discarded.count += 1
        continue
      }
      tasks.set(event.task.key, {
        ...event.task,
        blockedBy: [...new Set(event.task.blockedBy)],
        status: "ready",
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      })
      continue
    }
    if (event.type === "task.dispatching") {
      const task = tasks.get(event.taskKey)
      if (!task || task.report) {
        discarded.count += 1
        continue
      }
      task.actorSessionId = event.actor.sessionID
      task.admissionId = event.admissionID
      task.delivery = event.delivery
      task.status = "dispatching"
      task.updatedAt = event.createdAt
      const existing = actors.get(event.actor.sessionID)
      if (existing) {
        if (!existing.roles.includes(task.role)) existing.roles.push(task.role)
      } else if (actors.size < MISSION_MAX_ACTORS) {
        actors.set(event.actor.sessionID, {
          sessionId: event.actor.sessionID,
          kind: "specialist",
          managed: event.actor.managed,
          title: event.actor.title,
          roles: [task.role],
          location: event.actor.location,
          joinedAt: event.createdAt,
        })
      } else {
        discarded.count += 1
      }
      continue
    }
    if (event.type === "task.dispatched") {
      const task = tasks.get(event.taskKey)
      if (!task || !task.actorSessionId || task.report) {
        discarded.count += 1
        continue
      }
      task.status = "queued"
      task.updatedAt = event.createdAt
      continue
    }
    if (event.type === "task.reported") {
      const task = tasks.get(event.report.taskKey)
      if (!task || task.report || task.actorSessionId !== event.report.sessionId) {
        discarded.count += 1
        continue
      }
      task.report = event.report
      task.status = event.report.outcome === "completed"
        ? "completed"
        : event.report.outcome === "blocked" ? "needs-input" : "failed"
      task.updatedAt = event.createdAt
      reports.push(event.report)
      continue
    }
    if (event.type === "mission.finished") status = event.outcome
  }

  for (const task of tasks.values()) {
    if (task.status !== "ready") continue
    const waiting = task.blockedBy.some((key) => tasks.get(key)?.status !== "completed")
    task.status = waiting ? "blocked" : "ready"
  }

  const taskList = [...tasks.values()].sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key))
  return {
    version: MISSION_SCHEMA_VERSION,
    id: created.missionID,
    projectID: created.projectID,
    projectCanonical: created.projectCanonical,
    objective: created.objective,
    notes: created.notes,
    template: created.template,
    status,
    summary: [...events].reverse().find((event): event is MissionFinishedEvent => event.type === "mission.finished")?.summary,
    coordinatorSessionId: created.coordinator.sessionID,
    actors: [...actors.values()].sort((left, right) => left.joinedAt - right.joinedAt),
    tasks: taskList,
    reports: reports.sort((left, right) => left.createdAt - right.createdAt),
    frontier: taskList.filter((task) => task.status === "ready").map((task) => task.key),
    claims: taskList.filter((task) => task.status === "dispatching" || task.status === "queued").map((task) => task.key),
    createdAt: created.createdAt,
    updatedAt,
    revision: events.length,
  }
}

function compareEvents(left: MissionEvent, right: MissionEvent): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
