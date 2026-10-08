import type { MissionExecution } from "./execution"
import { briefingSourcesExist, parseMissionBriefing, type MissionBriefing } from "./briefing"
export type { MissionBriefing, MissionBriefingItem } from "./briefing"
import type { MissionTaskExecutionMode } from "./task-execution-mode"
export type { MissionTaskExecutionMode } from "./task-execution-mode"
import { hasInvalidControlHistory, isReportReceipt } from "./receipt-identity"
import { hasInvalidReportNotificationHistory, isCoordinatorNotificationReport, sameNativeCall } from "./native-report-provenance"
import { hasUnsettledNativeExecution, parseNativeCallObservation, projectNativeCallObservation, type MissionNativeExecution, type NativeCallObservation } from "./native-call-observation"
import { nativeCallObservationID } from "./native-call-reconciliation"
import { projectLifecycle, type MissionControlRequestedEvent, type MissionControlAppliedEvent, type MissionRunState, type MissionLifecycleOperation } from "./lifecycle-model"

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
export type MissionStatus = "active" | "completed" | "failed" | "stopped"
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
export type MissionActorActivityState =
  | "running"
  | "queued"
  | "background"
  | "permission"
  | "form"
  | "idle-without-report"
  | "missing"
  | "unknown"

export interface MissionActorActivity {
  sessionId: string
  state: MissionActorActivityState
}

export interface MissionActivityProjection {
  generatedAt: number
  missions: Array<{
    missionId: string
    actors: MissionActorActivity[]
    /** Observed native membership for display only, never task/actor authority. */
    family?: {
      state: "observed" | "unknown"
      members: Array<{
        sessionId: string
        parentSessionId?: string
        actorSessionId: string
        taskKey?: string
        kind: "declared" | "ordinary"
      }>
    }
  }>
}

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
  nativeCall?: MissionNativeBinding
  delivery?: "coordinator-notification" | "native-return" | "coordinator-readout"
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
  executionMode?: MissionTaskExecutionMode
  /** Derived by the reducer; never accepted from task declarations. */
  contractGeneration?: number
  blockedBy: string[]
  replacesTaskKey?: string
  replacedByTaskKey?: string
  status: MissionTaskStatus
  actorSessionId?: string
  admissionId?: string
  delivery?: "queue" | "steer"
  nativeBinding?: MissionNativeBinding & { nativeReturned?: true }
  nativeExecution?: MissionNativeExecution
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
  profiles?: import("./playbook-profiles").MissionProfiles
  taskMode?: import("./task-execution-mode").MissionTaskMode
  status: MissionStatus
  runState?: MissionRunState
  control?: MissionLifecycleOperation
  controlUnavailable?: boolean
  notificationUnavailable?: boolean
  summary?: string
  briefing?: MissionBriefing
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

export type MissionCleanupReason = "children" | "shared" | "moved" | "identity" | "guarded"
export interface MissionCleanup {
  missionID: string
  deletionID: string
  requestID: string
  expectedRevision: number
  deleteManagedSessions: boolean
  objective: string
  removed: number
  retained: number
  pending: number
  reasons: MissionCleanupReason[]
  createdAt: number
}

export interface MissionSnapshot {
  controlUnavailable?: boolean
  notificationUnavailable?: boolean
  version: typeof MISSION_SCHEMA_VERSION
  projectID: string
  generatedAt: number
  missions: MissionMap[]
  discardedEvents: number
  cleanups?: MissionCleanup[]
  cleanupUnavailable?: boolean
}

export interface MissionListAvailableResponse extends MissionSnapshot {
  available: true
  activity: MissionActivityProjection
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
  profiles?: import("./playbook-profiles").MissionProfiles
  taskMode?: import("./task-execution-mode").MissionTaskMode
  coordinator: {
    sessionID: string
    title: string
    location: MissionLocation
  }
  requestID?: string
  prepared?: boolean
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
  deleteManagedSessions?: boolean
  cleanupTargets?: Array<{ sessionID: string; location: MissionLocation }>
}

export interface MissionSessionCleanedEvent extends MissionEventBase {
  type: "mission.session-cleaned"
  deletionID: string
  sessionID: string
  outcome: "removed" | "retained"
  reason?: MissionCleanupReason
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
    executionMode?: MissionTaskExecutionMode
    blockedBy: string[]
    replacesTaskKey?: string
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
    executionMode?: MissionTaskExecutionMode
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

/** Native tool identity, not an inbox admission or a business report receipt. */
export interface MissionNativeBinding {
  generation: number
  parentSessionID: string
  toolCallID: string
  parentMessageID: string
}

export interface MissionTaskNativeBoundEvent extends MissionEventBase {
  type: "task.native-bound"
  taskKey: string
  actor: MissionTaskDispatchingEvent["actor"]
  binding: MissionNativeBinding
}

export interface MissionTaskNativeReturnedEvent extends MissionEventBase {
  type: "task.native-returned"
  taskKey: string
  binding: MissionNativeBinding
  childSessionID: string
}

export interface MissionTaskNativeCallStartedEvent extends MissionEventBase {
  type: "task.native-call-started"
  taskKey: string
  childSessionID: string
  binding: MissionNativeBinding
}

export interface MissionTaskNativeCallEndedEvent extends MissionEventBase {
  type: "task.native-call-ended"
  taskKey: string
  childSessionID: string
  binding: MissionNativeBinding
  outcome: "returned" | "error"
}

export interface MissionTaskNativeCallObservedEvent extends MissionEventBase {
  type: "task.native-call-observed"
  taskKey: string
  childSessionID: string
  binding: MissionNativeBinding
  observation: NativeCallObservation
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
  /** Exact original control/message and durable native failure, not a task report. */
  nativeFailure?: { operationID: string; sessionID: string; messageID: string; evidenceID: string; inputDigest: string }
}

export interface MissionBriefedEvent extends MissionEventBase {
  type: "mission.briefed"
  actorSessionID: string
  briefing: MissionBriefing
}

export type MissionEvent =
  | MissionControlRequestedEvent
  | MissionControlAppliedEvent
  | MissionCreatedEvent
  | MissionUpdatedEvent
  | MissionDeletedEvent
  | MissionSessionCleanedEvent
  | MissionRevisedEvent
  | MissionTaskCreatedEvent
  | MissionTaskDispatchingEvent
  | MissionTaskDispatchedEvent
  | MissionTaskNativeBoundEvent
  | MissionTaskNativeReturnedEvent
  | MissionTaskNativeCallStartedEvent
  | MissionTaskNativeCallEndedEvent
  | MissionTaskNativeCallObservedEvent
  | MissionTaskReportedEvent
  | MissionReportNotifiedEvent
  | MissionFinishedEvent
  | MissionBriefedEvent

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
  }).sort((left, right) => right.updatedAt - left.updatedAt)

  return {
    version: MISSION_SCHEMA_VERSION,
    projectID: missions[0]?.projectID ?? events[0]?.projectID ?? "",
    generatedAt: now,
    missions: missions.slice(0, MISSION_MAX_MISSIONS),
    discardedEvents: discarded.count + Math.max(0, missions.length - MISSION_MAX_MISSIONS),
    ...(hasInvalidControlHistory(events) ? { controlUnavailable: true } : {}),
    ...(hasInvalidReportNotificationHistory(events) ? { notificationUnavailable: true } : {}),
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
  const nativeCallHistory = new Map<string, { toolCalls: Set<string>; messages: Set<string>; calls: MissionNativeBinding[] }>()
  // An old completed report cannot settle a later explicitly started call.
  const nativeReportedExecutions = new Set<string>()
  const actors = new Map<string, MissionActor>()
  const reports: MissionReport[] = []
  const history: MissionPlanChange[] = []
  let status: MissionStatus = "active"
  let objective = created.objective
  let notes = created.notes
  let briefing: MissionBriefing | undefined
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

  let stoppedForReports = false
  for (const event of events) {
    updatedAt = Math.max(updatedAt, event.createdAt)
    if (event.projectID !== created.projectID || event.missionID !== created.missionID) {
      discarded.count += 1
      continue
    }
    if (event.type === "mission.control-requested" && event.action === "stop") stoppedForReports = true
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
    if (event.type === "mission.briefed") {
      const value = parseMissionBriefing(event.briefing)
      const index = events.indexOf(event)
      const lifecycle = projectLifecycle(events.slice(0, index))
      if (!value || event.actorSessionID !== created.coordinator.sessionID || status !== "active" || stoppedForReports
        || value.id !== event.id || value.createdAt !== event.createdAt || value.basedOnRevision !== index
        || value.basedOnUpdatedAt !== Math.max(...events.slice(0, index).map(item => item.createdAt))
        || ["prepared", "paused", "stopped"].includes(lifecycle.runState ?? "running") || lifecycle.control?.pending.length
        || !briefingSourcesExist({ tasks: [...tasks.values()] }, value)) { discarded.count++; continue }
      briefing = value
      continue
    }
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
        const after = [...new Set(update.blockedBy)]
        if (after.length === task.blockedBy.length && after.every(key => task.blockedBy.includes(key))) continue
        // Active/report bindings cannot be revoked by a hostile direct event.
        const generation = task.contractGeneration
        if (task.actorSessionId || task.nativeBinding || task.admissionId || task.report
          || (task.status !== "ready" && task.status !== "blocked")
          || generation === undefined || !Number.isSafeInteger(generation) || generation < 1
          || generation >= Number.MAX_SAFE_INTEGER) { discarded.count += 1; continue }
        dependencyChanges.push({ taskKey: update.taskKey, before: [...task.blockedBy], after })
        task.blockedBy = after
        task.contractGeneration = generation + 1
        task.updatedAt = event.createdAt
      }
      for (const added of event.addedTasks) {
        if (tasks.has(added.key) || tasks.size >= MISSION_MAX_TASKS) { discarded.count += 1; continue }
        tasks.set(added.key, {
          ...added,
          contractGeneration: 1,
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
        contractGeneration: 1,
        blockedBy: [...new Set(event.task.blockedBy)],
        status: "ready",
        outstandingExecution: false,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      })
      continue
    }
    if (event.type === "task.native-bound") {
      const task = tasks.get(event.taskKey)
      const existing = actors.get(event.actor.sessionID)
      if (!task || task.status !== "ready" || task.report || task.actorSessionId || task.nativeBinding
        || task.executionMode?.kind === "independent"
        || stoppedForReports || event.binding.generation !== task.contractGeneration
        || task.blockedBy.some(key => tasks.get(key)?.status !== "completed")
        || !actors.has(event.binding.parentSessionID) || event.binding.parentSessionID === event.actor.sessionID
        || (existing && (existing.kind !== "specialist" || existing.managed !== event.actor.managed
          || existing.title !== event.actor.title || existing.location.directory !== event.actor.location.directory
          || existing.location.workspaceID !== event.actor.location.workspaceID))
        || (!existing && actors.size >= MISSION_MAX_ACTORS)) {
        discarded.count += 1
        continue
      }
      task.actorSessionId = event.actor.sessionID
      task.nativeBinding = { ...event.binding }
      task.nativeExecution = { binding: { ...event.binding } }
      nativeCallHistory.set(task.key, { toolCalls: new Set([event.binding.toolCallID]), messages: new Set([event.binding.parentMessageID]),
        calls: [{ ...event.binding }] })
      // Queued means business work awaits its explicit report, not inbox ACK.
      task.status = "queued"
      task.updatedAt = event.createdAt
      if (existing) {
        if (!existing.roles.includes(task.role)) existing.roles.push(task.role)
      } else {
        actors.set(event.actor.sessionID, {
          sessionId: event.actor.sessionID, kind: "specialist", managed: event.actor.managed,
          title: event.actor.title, roles: [task.role], location: event.actor.location, joinedAt: event.createdAt,
        })
      }
      continue
    }
    if (event.type === "task.native-call-started") {
      const task = tasks.get(event.taskKey)
      const original = task?.nativeBinding
      const history = nativeCallHistory.get(event.taskKey)
      if (!task || !original || !task.nativeExecution?.ended || hasUnsettledNativeExecution(task) || !history || stoppedForReports
        || task.status === "withdrawn" || task.actorSessionId !== event.childSessionID
        || !actors.has(event.childSessionID) || !actors.has(event.binding.parentSessionID)
        || event.binding.generation !== original.generation || event.binding.generation !== task.contractGeneration
        || event.binding.parentSessionID !== original.parentSessionID
        || history.toolCalls.has(event.binding.toolCallID) || history.messages.has(event.binding.parentMessageID)) {
        discarded.count += 1
        continue
      }
      task.nativeExecution = { binding: { ...event.binding } }
      history.toolCalls.add(event.binding.toolCallID)
      history.messages.add(event.binding.parentMessageID)
      history.calls.push({ ...event.binding })
      nativeReportedExecutions.delete(task.key)
      task.updatedAt = event.createdAt
      continue
    }
    if (event.type === "task.native-returned" || event.type === "task.native-call-ended") {
      const task = tasks.get(event.taskKey)
      const binding = task?.nativeBinding
      const execution = task?.nativeExecution
      if (!task || !binding || !execution || execution.ended || task.actorSessionId !== event.childSessionID
        || !sameNativeCall(execution.binding, event.binding)
        || (event.type === "task.native-returned" && !sameNativeCall(binding, event.binding))
        || (execution.launch && execution.launch.mode !== "foreground")) {
        discarded.count += 1
        continue
      }
      // Error is an observed executor termination, not OS descendant suspension.
      execution.ended = event.type === "task.native-returned" ? "returned" : event.outcome
      if (execution.ended === "returned" && sameNativeCall(binding, event.binding)) binding.nativeReturned = true
      task.updatedAt = event.createdAt
      continue
    }
    if (event.type === "task.native-call-observed") {
      const task = tasks.get(event.taskKey), execution = task?.nativeExecution
      const observation = parseNativeCallObservation(event.observation)
      if (!task || !execution || !observation || event.id !== nativeCallObservationID({ ...event, binding: event.binding }, observation)
        || task.actorSessionId !== event.childSessionID || event.binding.generation !== task.contractGeneration
        || !sameNativeCall(execution.binding, event.binding)
        || observation.source.sessionID !== (observation.kind === "child-uncorrelated" ? event.childSessionID : event.binding.parentSessionID)) {
        discarded.count += 1; continue
      }
      task.nativeExecution = projectNativeCallObservation(execution, observation)
      if (!task.nativeExecution.observationConflict && task.nativeExecution.launch?.mode === "foreground"
        && task.nativeExecution.ended === "returned" && task.nativeBinding && sameNativeCall(task.nativeBinding, event.binding)) task.nativeBinding.nativeReturned = true
      task.updatedAt = event.createdAt
      continue
    }
    if (event.type === "task.dispatching") {
      const task = tasks.get(event.taskKey)
      if (!task || task.report || task.nativeBinding) {
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
      if (!task || !task.actorSessionId || task.report || task.nativeBinding) {
        discarded.count += 1
        continue
      }
      task.status = "queued"
      task.updatedAt = event.createdAt
      continue
    }
    if (event.type === "task.reported") {
      const task = tasks.get(event.report.taskKey)
      const call = event.report.nativeCall
      const historical = Boolean((task?.status === "withdrawn" || stoppedForReports) && event.report.late)
      const readout = event.report.delivery === "coordinator-readout"
      if (!task || (readout ? event.report.sessionId !== created.coordinator.sessionID
        || task.executionMode?.kind !== "native" || Boolean(call) || historical
        || task.status === "blocked" || stoppedForReports : task.actorSessionId !== event.report.sessionId)
        || (task.executionMode?.kind === "native" && !call && !readout)
        || (event.report.delivery === "native-return" && !call)
        || (call && (task.executionMode?.kind === "independent" || !task.nativeBinding
          || call.generation !== task.contractGeneration
          || !nativeCallHistory.get(task.key)?.calls.some(binding => sameNativeCall(binding, call))
          || (!historical && !sameNativeCall(task.nativeExecution?.binding, call))
          || reports.some(report => report.id === event.report.id)))) {
        discarded.count += 1
        continue
      }
      // Historical invocation evidence cannot settle a different pending call.
      const reportsCurrentCall = !readout && task.nativeBinding && (!call || sameNativeCall(task.nativeExecution?.binding, call))
      if (historical && (!task.report || call)) {
        if (reportsCurrentCall) nativeReportedExecutions.add(task.key)
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
      if (reportsCurrentCall) nativeReportedExecutions.add(task.key)
      task.status = event.report.outcome === "completed"
        ? "completed"
        : event.report.outcome === "blocked" ? "needs-input" : "failed"
      task.updatedAt = event.createdAt
      reports.push(event.report)
      continue
    }
    if (event.type === "report.notified") {
      const report = reports.find(report => report.id === event.reportID)
      if (report && !isCoordinatorNotificationReport(report)) discarded.count += 1
      continue
    }
    if (event.type === "mission.finished") status = event.outcome
  }

  for (const task of tasks.values()) {
    task.outstandingExecution = task.status === "withdrawn" && Boolean(task.nativeBinding
      ? task.nativeExecution?.observationConflict || task.nativeExecution?.launch && task.nativeExecution.launch.mode !== "foreground" ? hasUnsettledNativeExecution(task)
        : !task.nativeExecution?.ended && !nativeReportedExecutions.has(task.key)
      : task.admissionId && !task.report && (task.lateReports?.length ?? 0) === 0)
    if (task.status === "ready") {
      const waiting = task.blockedBy.some((key) => tasks.get(key)?.status !== "completed")
      task.status = waiting ? "blocked" : "ready"
    }
  }

  const lifecycle = projectLifecycle(events)
  const firstStop = events.findIndex(event => event.type === "mission.control-requested" && event.action === "stop")
  const firstFinished = events.findIndex(event => event.type === "mission.finished")
  // Denial receipts in the normal final-report/native-settlement interval do
  // not rewrite the already recorded terminal result. A prior Stop remains terminal.
  const finishedBeforeStop = firstFinished >= 0 && firstFinished < firstStop
  if (lifecycle.runState === "stopped" && !finishedBeforeStop) {
    status = "stopped"
    for (const task of tasks.values()) {
      if (["ready", "blocked", "queued", "dispatching"].includes(task.status)) task.status = "withdrawn"
      task.outstandingExecution = Boolean(task.nativeBinding
        ? task.nativeExecution?.observationConflict || task.nativeExecution?.launch && task.nativeExecution.launch.mode !== "foreground" ? hasUnsettledNativeExecution(task)
          : !task.nativeExecution?.ended && !nativeReportedExecutions.has(task.key)
        : task.actorSessionId && lifecycle.control?.pending.includes(task.actorSessionId) && task.admissionId
          && !task.report && !task.lateReports?.length)
    }
  }
  const taskList = [...tasks.values()].sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key))
  const notificationStatus = (report: MissionReport): MissionReport => report.delivery === "coordinator-readout" ? { ...report } : ({
    ...report,
    // ponytail: scan the bounded 2,000-event journal; index only if profiling warrants it.
    notificationStatus: isCoordinatorNotificationReport(report)
      && events.some(event => isReportReceipt(event, created, report.id)) ? "admitted" : "pending",
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
    ...(briefing ? { briefing } : {}),
    template: created.template,
    taskMode: created.taskMode ?? "native",
    ...(created.profiles === undefined ? {} : { profiles: structuredClone(created.profiles) }),
    status,
    ...lifecycle,
    ...(hasInvalidReportNotificationHistory(events) ? { notificationUnavailable: true } : {}),
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

export function compareEvents(left: MissionEvent, right: MissionEvent): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}
