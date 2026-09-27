import type { MissionExecution } from "./execution"

export const MISSION_SCHEMA_VERSION = 1 as const
export const MISSION_MAX_ACTORS = 8
export const MISSION_MAX_EVENTS = 2_000
export const MISSION_MAX_MISSIONS = 20
export const MISSION_MAX_TASKS = 96
export const MISSION_MAX_HISTORY = 50

export type MissionJsonValue = null | boolean | number | string | readonly MissionJsonValue[] | {
  readonly [key: string]: MissionJsonValue
}

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
  | "withdrawn"
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
  artifact?: MissionJsonValue
  late?: boolean
  notificationStatus?: "pending" | "admitted"
  createdAt: number
}

export interface MissionTask {
  id: string
  key: string
  title: string
  brief: string
  role: string
  execution?: MissionExecution
  blockedBy: string[]
  replacesTaskKey?: string
  replacedByTaskKey?: string
  status: MissionTaskStatus
  actorSessionId?: string
  admissionId?: string
  delivery?: "queue" | "steer"
  createdAt: number
  updatedAt: number
  report?: MissionReport
  lateReports?: MissionReport[]
  outstandingExecution: boolean
}

export interface MissionDependencyUpdate {
  taskKey: string
  blockedBy: string[]
}

export interface MissionDependencyChange {
  taskKey: string
  before: string[]
  after: string[]
}

export interface MissionRetiredTask {
  taskKey: string
  replacementTaskKey?: string
}

export interface MissionPlanChange {
  revision: number
  source?: "user" | "coordinator"
  actorSessionId?: string
  reason?: string
  objective?: { before: string; after: string }
  notes?: { before?: string; after?: string }
  addedTaskKeys: string[]
  retiredTasks: MissionRetiredTask[]
  dependencyUpdates: MissionDependencyChange[]
  createdAt: number
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
  history: MissionPlanChange[]
  historyTruncated: boolean
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
  requestID?: string
}

export interface MissionUpdatedEvent extends MissionEventBase {
  type: "mission.updated"
  requestID: string
  expectedRevision: number
  notesSpecified: boolean
  objective: string
  notes?: string
}

export interface MissionDeletedEvent extends MissionEventBase {
  type: "mission.deleted"
  requestID: string
  expectedRevision: number
}

export interface MissionRevisedEvent extends MissionEventBase {
  type: "mission.revised"
  requestID: string
  expectedRevision: number
  actorSessionID: string
  reason: string
  objective?: string
  notesSpecified: boolean
  notes?: string
  retiredTasks: MissionRetiredTask[]
  addedTasks: Array<{
    id: string
    key: string
    title: string
    brief: string
    role: string
    execution?: MissionExecution
    blockedBy: string[]
    replacesTaskKey: string
  }>
  dependencyUpdates: MissionDependencyUpdate[]
}

export interface MissionTaskCreatedEvent extends MissionEventBase {
  type: "task.created"
  task: {
    id: string
    key: string
    title: string
    brief: string
    role: string
    execution?: MissionExecution
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
  | MissionUpdatedEvent
  | MissionDeletedEvent
  | MissionRevisedEvent
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

  if (events.some((event) => event.type === "mission.deleted")) return undefined

  const tasks = new Map<string, MissionTask>()
  const actors = new Map<string, MissionActor>()
  const reports: MissionReport[] = []
  const notifiedReportIDs = new Set<string>()
  const history: MissionPlanChange[] = []
  let status: MissionStatus = "active"
  let objective = created.objective
  let notes = created.notes
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
    if (event.type === "mission.updated") {
      const previousObjective = objective
      const previousNotes = notes
      objective = event.objective
      notes = event.notes
      history.push({
        revision: event.expectedRevision + 1,
        source: "user",
        objective: { before: previousObjective, after: objective },
        ...(event.notesSpecified ? { notes: { before: previousNotes, after: notes } } : {}),
        addedTaskKeys: [],
        retiredTasks: [],
        dependencyUpdates: [],
        createdAt: event.createdAt,
      })
      continue
    }
    if (event.type === "mission.deleted") continue
    if (event.type === "mission.revised") {
      const previousObjective = objective
      const previousNotes = notes
      if (event.objective !== undefined) objective = event.objective
      if (event.notesSpecified) notes = event.notes
      for (const retired of event.retiredTasks) {
        const task = tasks.get(retired.taskKey)
        if (!task || task.status === "withdrawn") { discarded.count += 1; continue }
        task.status = "withdrawn"
        task.replacedByTaskKey = retired.replacementTaskKey
        task.updatedAt = event.createdAt
      }
      const dependencyChanges: MissionDependencyChange[] = []
      for (const update of event.dependencyUpdates) {
        const task = tasks.get(update.taskKey)
        if (!task || task.status === "withdrawn") { discarded.count += 1; continue }
        dependencyChanges.push({ taskKey: update.taskKey, before: [...task.blockedBy], after: [...update.blockedBy] })
        task.blockedBy = [...new Set(update.blockedBy)]
        task.updatedAt = event.createdAt
      }
      for (const added of event.addedTasks) {
        if (tasks.has(added.key) || tasks.size >= MISSION_MAX_TASKS) { discarded.count += 1; continue }
        tasks.set(added.key, {
          ...added,
          blockedBy: [...new Set(added.blockedBy)],
          status: "ready",
          outstandingExecution: false,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
        })
      }
      history.push({
        revision: event.expectedRevision + 1,
        source: "coordinator",
        actorSessionId: event.actorSessionID,
        reason: event.reason,
        ...(event.objective === undefined ? {} : { objective: { before: previousObjective, after: objective } }),
        ...(!event.notesSpecified ? {} : { notes: { before: previousNotes, after: notes } }),
        addedTaskKeys: event.addedTasks.map((task) => task.key),
        retiredTasks: event.retiredTasks.map((task) => ({ ...task })),
        dependencyUpdates: dependencyChanges,
        createdAt: event.createdAt,
      })
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
        outstandingExecution: false,
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
      if (!task || task.actorSessionId !== event.report.sessionId) {
        discarded.count += 1
        continue
      }
      if (task.status === "withdrawn" && event.report.late && !task.report) {
        task.lateReports = [...(task.lateReports ?? []), event.report]
        task.updatedAt = event.createdAt
        reports.push(event.report)
        continue
      }
      if (task.report || task.status === "withdrawn" || event.report.late) {
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
    if (event.type === "report.notified") {
      notifiedReportIDs.add(event.reportID)
      continue
    }
    if (event.type === "mission.finished") status = event.outcome
  }

  for (const task of tasks.values()) {
    task.outstandingExecution = task.status === "withdrawn" && Boolean(task.admissionId)
      && !task.report && (task.lateReports?.length ?? 0) === 0
    if (task.status === "ready") {
      const waiting = task.blockedBy.some((key) => tasks.get(key)?.status !== "completed")
      task.status = waiting ? "blocked" : "ready"
    }
  }

  const taskList = [...tasks.values()].sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key))
  const notificationStatus = (report: MissionReport): MissionReport => ({
    ...report,
    notificationStatus: notifiedReportIDs.has(report.id) ? "admitted" : "pending",
  })
  for (const task of taskList) {
    if (task.report) task.report = notificationStatus(task.report)
    if (task.lateReports) task.lateReports = task.lateReports.map(notificationStatus)
  }
  return {
    version: MISSION_SCHEMA_VERSION,
    id: created.missionID,
    projectID: created.projectID,
    projectCanonical: created.projectCanonical,
    objective,
    notes,
    template: created.template,
    status,
    summary: [...events].reverse().find((event): event is MissionFinishedEvent => event.type === "mission.finished")?.summary,
    coordinatorSessionId: created.coordinator.sessionID,
    actors: [...actors.values()].sort((left, right) => left.joinedAt - right.joinedAt),
    tasks: taskList,
    reports: reports.sort((left, right) => left.createdAt - right.createdAt).map(notificationStatus),
    frontier: taskList.filter((task) => task.status === "ready").map((task) => task.key),
    claims: taskList.filter((task) => task.status === "dispatching" || task.status === "queued").map((task) => task.key),
    createdAt: created.createdAt,
    updatedAt,
    revision: events.length,
    history: history.slice(-MISSION_MAX_HISTORY),
    historyTruncated: history.length > MISSION_MAX_HISTORY,
  }
}

function compareEvents(left: MissionEvent, right: MissionEvent): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
