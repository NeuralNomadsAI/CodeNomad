import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { JsonValue, SessionMetadata } from "@opencode/client"

import { MissionJournal, stableToken, type MissionStorage } from "./journal"
import {
  MISSION_MAX_ACTORS,
  MISSION_MAX_MISSIONS,
  MISSION_MAX_TASKS,
  MISSION_SCHEMA_VERSION,
  type MissionActor,
  type MissionEvent,
  type MissionMap,
  type MissionReport,
  type MissionRevisedEvent,
  type MissionSnapshot,
} from "./model"
import { buildActorContext, getMissionRecipe, missionRecipeCatalog } from "./recipes"
import { assignmentInput, reportInput } from "./inputs"
import { reportNotificationID } from "./receipt-identity"
import { resolvePocockImplementerSessionID, validateMissionCompletionPolicy, validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"
import { runMissionExclusive } from "./exclusive"
import { matchesExecution, sameExecution } from "./execution"
import { sameLocation } from "../opencode/compatibility/location"
import { missionRecoveryInput, type MissionRecoveryInput } from "./recovery-input"
import { MissionControlError } from "./control-error"
import { deleteMission, missionCleanupTarget } from "./session-cleanup"
import { controlMission } from "./lifecycle"
import { missionIsRunning, type MissionLifecycleInput } from "./lifecycle-model"
import { normalizeTaskDeclaration, taskContractReferenceSchema, validateTaskActorChoice, validateTaskAdmissionGraph, type TaskContractReference } from "./task-declaration"
import { parseMissionProfiles, sameMissionProfiles, validateMissionProfiles, type MissionProfiles } from "./playbook-profiles"
import { hasUnsettledNativeExecution } from "./native-call-observation"
import { sameExecutionMode } from "./task-execution-mode"
import { coordinatorReadout } from "./coordinator-readout"
import { isCoordinatorNotificationReport, parseNativeCall, sameNativeCall } from "./native-report-provenance"
export { MissionControlError } from "./control-error"
import type {
  MissionDelegateInput,
  MissionDeclareInput,
  MissionCreateInput,
  MissionUpdateInput,
  MissionDeleteInput,
  MissionReviseInput,
  MissionInspectInput,
  MissionInspection,
  MissionProject,
  MissionReportInput,
  MissionSessionAdapter,
  MissionInputTransport,
  NativeMissionSession,
  MissionManagedRootCreation,
  MissionNativeReportRequest,
  MissionNativeReportAuthorization,
} from "./control-types"

const MISSION_NOTIFICATION_BATCH_SIZE = 10

export interface MissionNotificationRetryResult {
  attempted: number
  failed: number
  cursor?: string
}

export class MissionControl {
  private readonly journal: MissionJournal
  private lastTimestamp = 0

  constructor(private readonly options: {
    project: MissionProject
    storage: MissionStorage
    sessions: MissionSessionAdapter
    now?: () => number
    changed?: (missionID: string, revision: number) => Promise<void>
    validateExecution?: (input: MissionDelegateInput, coordinatorID: string) => Promise<void>
    validateProfiles?: (profiles: MissionProfiles | undefined, directory: string) => Promise<void>
    transport?: MissionInputTransport
    createManagedRoot?: MissionManagedRootCreation
    isActive?: () => boolean
    authorizeNativeReport?: MissionNativeReportAuthorization
  }) {
    this.journal = new MissionJournal(options.storage, options.project.id, options.project.canonical, options.now)
  }

  snapshot(): Promise<MissionSnapshot> {
    return this.journal.snapshot()
  }

  create(input: MissionCreateInput): Promise<{ mission: MissionMap }> {
    const request = structuredClone(input)
    return this.mutate(() => this.createCurrent(request))
  }

  private async createCurrent(input: MissionCreateInput): Promise<{ mission: MissionMap }> {
    input = structuredClone(input)
    try { input.profiles = parseMissionProfiles(input.profiles); validateMissionProfiles(input.template, input.profiles) }
    catch { throw new MissionControlError("Invalid Mission profile selection", "invalid-execution") }
    const missionID = `msn_${stableToken(`${this.options.project.id}\0${input.requestID}`, 24)}`
    const eventID = this.eventID(missionID, "created")
    const existingEvent = await this.journal.event(missionID, eventID)
    let snapshot = await this.snapshot()
    const existing = snapshot.missions.find((mission) => mission.id === missionID)
    if (existingEvent) {
      if (existingEvent.type !== "mission.created" || existingEvent.objective !== input.objective
        || existingEvent.notes !== input.notes || existingEvent.template !== input.template || Boolean(existingEvent.prepared) !== Boolean(input.prepared)
        || !sameMissionProfiles(existingEvent.profiles, input.profiles)
        || (input.coordinatorSessionID !== undefined && existingEvent.coordinator.sessionID !== input.coordinatorSessionID)) {
        throw new MissionControlError("Creation request ID was already used with a different mission", "request-conflict")
      }
      if (!existing) throw new MissionControlError("Mission was deleted and cannot be recreated", "mission-deleted")
      if (input.expectedCoordinatorLocation && !sameLocation(existingEvent.coordinator.location, input.expectedCoordinatorLocation)) {
        throw new MissionControlError("Coordinator moved from its admitted creation location", "foreign-session")
      }
      return { mission: existing }
    }
    if (snapshot.missions.length >= MISSION_MAX_MISSIONS) throw new MissionControlError("Project mission limit reached", "mission-limit")
    await this.journal.assertCanAppend()
    try { await this.options.validateProfiles?.(input.profiles, input.expectedCoordinatorLocation?.directory ?? this.options.project.location.directory) }
    catch { throw new MissionControlError("Mission profiles do not match the owned native catalog", "invalid-execution") }

    let coordinator: NativeMissionSession
    if (input.coordinatorSessionID) {
      coordinator = await this.ownedRootSession(input.coordinatorSessionID)
      if (snapshot.missions.some((mission) => (mission.status === "active" || mission.control?.pending.includes(coordinator.id))
        && mission.actors.some((actor) => actor.sessionId === coordinator.id))) {
        throw new MissionControlError("Coordinator session already belongs to an active mission", "already-member")
      }
    } else {
      const sessionID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
      try {
        coordinator = await this.options.sessions.get({ sessionID })
      } catch {
        this.assertActive()
        coordinator = await this.options.sessions.create({
          id: sessionID,
          title: `Mission coordinator: ${input.objective}`.slice(0, 160),
          location: this.options.project.location,
          metadata: this.metadata(missionID, "coordinator", { role: "coordinator" }),
          ...input.profiles?.coordinator,
        })
      }
      this.assertOwnedRoot(coordinator)
      if (coordinator.id !== sessionID || !sameLocation(coordinator.location, this.options.project.location)) {
        throw new MissionControlError("Created coordinator differs from requested root", "foreign-session")
      }
    }

    if (input.expectedCoordinatorLocation) {
      coordinator = await this.ownedRootSession(coordinator.id)
      if (!sameLocation(coordinator.location, input.expectedCoordinatorLocation)) {
        throw new MissionControlError("Coordinator moved from its admitted creation location", "foreign-session")
      }
    }

    if (!matchesExecution(input.profiles?.coordinator, coordinator)) {
      throw new MissionControlError("Coordinator does not have the requested native profile", "invalid-execution")
    }
    const createdAt = this.timestamp(snapshot)
    this.assertActive()
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: eventID,
      type: "mission.created",
      missionID,
      projectID: this.options.project.id,
      projectCanonical: this.options.project.canonical,
      objective: input.objective,
      notes: input.notes,
      template: input.template,
      ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
      requestID: input.requestID,
      ...(input.prepared === undefined ? {} : { prepared: input.prepared }),
      coordinator: { sessionID: coordinator.id, title: coordinator.title ?? "Mission coordinator", location: coordinator.location },
      createdAt,
    })
    snapshot = await this.snapshot()
    await this.emitChanged(missionID, snapshot)
    return { mission: this.requireMission(snapshot, missionID) }
  }

  update(input: MissionUpdateInput): Promise<{ mission: MissionMap }> {
    return this.mutate(() => this.updateCurrent(input))
  }

  lifecycle(input: MissionLifecycleInput): Promise<{ mission: MissionMap }> {
    return this.mutate(() => controlMission(input, {
      journal: this.journal, transport: this.options.transport, isActive: this.options.isActive,
      timestamp: snapshot => this.timestamp(snapshot),
      changed: async (missionID, revision) => this.emitChanged(missionID, await this.snapshot(), revision),
    }))
  }

  recover(input: MissionRecoveryInput): Promise<{ mission: MissionMap; admitted: true }> {
    return this.mutate(async () => {
      const mission = this.requireMission(await this.snapshot(), input.missionID)
      const notification = missionRecoveryInput(mission, input)
      for (const sessionID of new Set([mission.coordinatorSessionId, notification.sessionID])) {
        const session = await this.ownedRootSession(sessionID)
        const actor = mission.actors.find(actor => actor.sessionId === sessionID)
        if (!actor || !sameLocation(session.location, actor.location)) throw new MissionControlError("Mission actor moved", "foreign-session")
      }
      // Production recovery must use the authenticated backend's fresh native
      // observations, environment and fences. Never fall back to ctx.synthetic.
      if (!this.options.transport) throw new MissionControlError("Recovery admission unavailable", "recovery-unknown")
      await this.options.transport.synthetic(mission.coordinatorSessionId, notification)
      return { mission: this.requireMission(await this.snapshot(), mission.id), admitted: true }
    })
  }

  private async updateCurrent(input: MissionUpdateInput): Promise<{ mission: MissionMap }> {
    const eventID = this.eventID(input.missionID, `updated-${input.requestID}`)
    const previous = await this.journal.event(input.missionID, eventID)
    let snapshot = await this.snapshot()
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionID)
    if (previous) {
      if (previous.type !== "mission.updated" || previous.objective !== input.objective
        || previous.notesSpecified !== (input.notes !== undefined)
        || (input.notes !== undefined && previous.notes !== input.notes)
        || previous.expectedRevision !== input.expectedRevision) throw new MissionControlError("Update request ID was already used with a different edit", "request-conflict")
      if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
      return { mission }
    }
    if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
    if (mission.status !== "active") throw new MissionControlError("Only active missions can be edited", "mission-finished")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before editing", "revision-conflict")
    const notes = input.notes === undefined ? mission.notes : input.notes
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.updated", missionID: mission.id,
      projectID: mission.projectID, requestID: input.requestID, expectedRevision: input.expectedRevision,
      objective: input.objective, notes, notesSpecified: input.notes !== undefined, createdAt: this.timestamp(snapshot),
    })
    snapshot = await this.snapshot()
    await this.emitChanged(mission.id, snapshot)
    return { mission: this.requireMission(snapshot, mission.id) }
  }

  delete(input: MissionDeleteInput): Promise<{ deleted: true }> {
    return this.mutate(() => deleteMission(input, {
      journal: this.journal, sessions: this.options.sessions, transport: this.options.transport, isActive: this.options.isActive,
      timestamp: (snapshot) => this.timestamp(snapshot),
      changed: async (missionID, revision) => this.emitChanged(missionID, await this.snapshot(), revision),
    }))
  }

  cleanupTarget(input: { missionID: string; deletionID: string; sessionID: string }) {
    return missionCleanupTarget(this.journal, input)
  }

  revise(sessionID: string, input: MissionReviseInput): Promise<{ mission: MissionMap }> {
    return this.mutate(() => this.reviseCurrent(sessionID, input))
  }

  private async reviseCurrent(sessionID: string, input: MissionReviseInput): Promise<{ mission: MissionMap }> {
    input = normalizeRevisionDependencies(input)
    await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
    this.assertCoordinator(mission, sessionID)
    const roleProfiles = mission.profiles?.roles
    input = { ...input, addTasks: input.addTasks.map(task => task.execution === undefined && roleProfiles?.[task.role] !== undefined
      ? { ...task, execution: structuredClone(roleProfiles[task.role]) } : task) }
    const eventID = this.eventID(mission.id, `revised-${input.requestID}`)
    const previous = await this.journal.event(mission.id, eventID)
    if (previous) {
      if (previous.type !== "mission.revised" || previous.actorSessionID !== sessionID
        || previous.expectedRevision !== input.expectedRevision || !sameRevisionRequest(previous, input)) {
        throw new MissionControlError("Revision request ID was already used with a different change", "request-conflict")
      }
      return { mission }
    }
    if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
    if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before revising", "revision-conflict")
    const addedTasks = await this.validateRevision(mission, input, sessionID)
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: eventID,
      type: "mission.revised",
      missionID: mission.id,
      projectID: mission.projectID,
      requestID: input.requestID,
      expectedRevision: input.expectedRevision,
      actorSessionID: sessionID,
      reason: input.reason,
      ...(input.objective === undefined ? {} : { objective: input.objective }),
      notesSpecified: input.notes !== undefined,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      retiredTasks: input.retireTasks,
      addedTasks,
      dependencyUpdates: input.dependencyUpdates,
      createdAt: this.timestamp(snapshot),
    })
    snapshot = await this.snapshot()
    mission = this.requireMission(snapshot, mission.id)
    await this.emitChanged(mission.id, snapshot)
    return { mission }
  }

  private async validateRevision(mission: MissionMap, input: MissionReviseInput, coordinatorID: string) {
    if (input.objective === undefined && input.notes === undefined && input.retireTasks.length === 0
      && input.addTasks.length === 0 && input.dependencyUpdates.length === 0) {
      throw new MissionControlError("A revision must change the objective, notes, tasks, or dependencies", "empty-revision")
    }
    if (mission.tasks.length + input.addTasks.length > MISSION_MAX_TASKS) {
      throw new MissionControlError("Mission task limit reached", "task-limit")
    }

    const current = new Map(mission.tasks.map((task) => [task.key, task]))
    const retired = new Map<string, string | undefined>()
    for (const item of input.retireTasks) {
      const task = current.get(item.taskKey)
      if (!task || task.status === "withdrawn") throw new MissionControlError(`Cannot retire unknown or already withdrawn task: ${item.taskKey}`, "invalid-revision")
      if (retired.has(item.taskKey)) throw new MissionControlError(`Task is retired more than once: ${item.taskKey}`, "invalid-revision")
      retired.set(item.taskKey, item.replacementTaskKey)
    }

    const addKeys = new Set<string>()
    const addedTasks: Array<MissionRevisedEvent["addedTasks"][number]> = []
    const addInputs = new Map(input.addTasks.map((task) => [task.taskKey, task]))
    if (addInputs.size !== input.addTasks.length) throw new MissionControlError("Added task keys must be unique", "invalid-revision")
    const policyTasks: Array<Pick<MissionMap["tasks"][number],
      "key" | "role" | "status" | "blockedBy" | "actorSessionId" | "replacedByTaskKey" | "executionMode">> = [
      ...mission.tasks.filter(task => !retired.has(task.key)).map(task => ({ ...task,
        blockedBy: input.dependencyUpdates.find(update => update.taskKey === task.key)?.blockedBy ?? task.blockedBy })),
      ...input.addTasks.map(task => ({ key: task.taskKey, role: task.role, status: "ready" as const,
        blockedBy: task.blockedBy, actorSessionId: undefined, replacedByTaskKey: undefined, executionMode: task.executionMode })),
    ]
    for (const item of input.addTasks) {
      if (current.has(item.taskKey) || addKeys.has(item.taskKey)) throw new MissionControlError(`Task key already exists: ${item.taskKey}`, "task-conflict")
      addKeys.add(item.taskKey)
      if (item.replacesTaskKey !== undefined && (!retired.has(item.replacesTaskKey) || retired.get(item.replacesTaskKey) !== item.taskKey)) {
        throw new MissionControlError(`Replacement ${item.taskKey} must match a retired task`, "invalid-revision")
      }
      const taskInput: MissionDelegateInput = {
        taskKey: item.taskKey, title: item.title, brief: item.brief, role: item.role,
        blockedBy: item.blockedBy, delivery: "queue", execution: item.execution, executionMode: item.executionMode,
      }
      try {
        validateMissionDelegationPolicy({
          template: mission.template,
          role: item.role,
          targetSessionID: item.role === "resolver" && item.executionMode?.kind !== "native"
            ? resolvePocockImplementerSessionID(policyTasks, item.blockedBy)
            : undefined,
          blockedBy: item.blockedBy,
          tasks: policyTasks,
          executionMode: item.executionMode,
          phase: "declaration",
        })
        validateTaskActorChoice({ tasks: [...mission.tasks, ...policyTasks] }, item)
        await this.options.validateExecution?.(taskInput, coordinatorID)
      } catch (error) {
        throw new MissionControlError(error instanceof Error ? error.message : "Replacement task contract is invalid", "invalid-role-policy")
      }
      addedTasks.push({
        id: `tsk_${stableToken(`${mission.id}\0${item.taskKey}`, 24)}`,
        key: item.taskKey, title: item.title, brief: item.brief, role: item.role,
        ...(item.execution === undefined ? {} : { execution: item.execution }),
        ...(item.executionMode === undefined ? {} : { executionMode: item.executionMode }),
        blockedBy: [...item.blockedBy], ...(item.replacesTaskKey === undefined ? {} : { replacesTaskKey: item.replacesTaskKey }),
      })
    }
    for (const [oldKey, replacementKey] of retired) {
      if (replacementKey !== undefined && !addKeys.has(replacementKey)) {
        throw new MissionControlError(`Replacement task does not exist: ${replacementKey}`, "invalid-revision")
      }
    }
    if ([...retired.values()].filter((value) => value !== undefined).length !== input.addTasks.filter(task => task.replacesTaskKey !== undefined).length) {
      throw new MissionControlError("Every replacement task must replace exactly one retired task", "invalid-revision")
    }

    const dependencyTargets = new Set<string>()
    for (const update of input.dependencyUpdates) {
      const task = current.get(update.taskKey)
      if (!task || retired.has(update.taskKey) || dependencyTargets.has(update.taskKey)) {
        throw new MissionControlError(`Invalid or duplicate dependency update: ${update.taskKey}`, "invalid-revision")
      }
      if (task.status !== "ready" && task.status !== "blocked") {
        throw new MissionControlError(`Cannot change dependencies after dispatch: ${update.taskKey}`, "invalid-revision")
      }
      dependencyTargets.add(update.taskKey)
    }
    for (const task of mission.tasks) {
      if (retired.has(task.key) || task.status === "withdrawn") continue
      if (task.blockedBy.some((key) => retired.has(key)) && !dependencyTargets.has(task.key)) {
        throw new MissionControlError(`Dependency update required for ${task.key}`, "dependency-update-required")
      }
    }

    const planned = new Map<string, { blockedBy: string[]; retired: boolean }>()
    for (const task of mission.tasks) {
      if (retired.has(task.key) || task.status === "withdrawn") continue
      const update = input.dependencyUpdates.find((item) => item.taskKey === task.key)
      planned.set(task.key, { blockedBy: update?.blockedBy ?? task.blockedBy, retired: false })
    }
    for (const task of addedTasks) planned.set(task.key, { blockedBy: task.blockedBy, retired: false })
    for (const [taskKey, task] of planned) {
      if (task.blockedBy.includes(taskKey) || new Set(task.blockedBy).size !== task.blockedBy.length) {
        throw new MissionControlError(`Invalid dependency list for ${taskKey}`, "invalid-revision")
      }
      const unknown = task.blockedBy.find((key) => !planned.has(key))
      if (unknown) throw new MissionControlError(`Dependency ${unknown} is unknown, retired, or being removed`, "invalid-blocker")
    }
    assertAcyclicDependencies(planned)
    validateTaskAdmissionGraph([
      ...mission.tasks.filter(task => !retired.has(task.key)).map(task => ({ ...task,
        blockedBy: input.dependencyUpdates.find(update => update.taskKey === task.key)?.blockedBy ?? task.blockedBy })),
      ...addedTasks.map(task => ({ ...task, status: "ready" as const })),
    ])
    return addedTasks
  }

  /** Declaration never creates, moves, prompts or selects a native session. */
  declare(sessionID: string, raw: MissionDeclareInput): Promise<{
    disposition: "declared" | "existing"; mission: MissionMap; contract: TaskContractReference
  }> {
    let input = normalizeTaskDeclaration(raw)
    return this.mutate(async () => {
      await this.ownedRootSession(sessionID)
      let snapshot = await this.snapshot()
      if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable) {
        throw new MissionControlError("Damaged Mission journal cannot authorize task declarations", "invalid-journal")
      }
      let mission = this.selectMission(snapshot, sessionID, input.missionID)
      if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
      this.assertCoordinator(mission, sessionID)
      input = { ...input, execution: input.execution ?? structuredClone(mission.profiles?.roles?.[input.role]) }
      const coordinator = await this.ownedRootSession(sessionID)
      const coordinatorActor = mission.actors.find(actor => actor.sessionId === sessionID)
      if (!coordinatorActor || !sameLocation(coordinator.location, coordinatorActor.location)) {
        throw new MissionControlError("Coordinator moved", "foreign-session")
      }
      if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
      if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
      let task = mission.tasks.find(task => task.key === input.taskKey)
      const disposition = task ? "existing" as const : "declared" as const
      if (task) {
        if (task.title !== input.title || task.brief !== input.brief || task.role !== input.role
          || !equalStrings([...task.blockedBy].sort(), input.blockedBy)
          || !sameExecution(task.execution, input.execution) || !sameExecutionMode(task.executionMode, input.executionMode)) {
          throw new MissionControlError("Task key already exists with a different contract", "task-conflict")
        }
        if (task.status === "withdrawn") throw new MissionControlError("Task was withdrawn; declare a new task key", "task-withdrawn")
      } else {
        if (mission.tasks.length >= MISSION_MAX_TASKS) throw new MissionControlError("Mission task limit reached", "task-limit")
        validateTaskAdmissionGraph([...mission.tasks, { key: input.taskKey, blockedBy: input.blockedBy,
          executionMode: input.executionMode, status: "ready" }])
        validateTaskActorChoice(mission, input)
        try {
          validateMissionDelegationPolicy({ template: mission.template, role: input.role, blockedBy: input.blockedBy,
            tasks: mission.tasks, executionMode: input.executionMode, phase: "declaration" })
          await this.options.validateExecution?.({ ...input, delivery: "queue" }, sessionID)
        } catch (error) {
          throw new MissionControlError(error instanceof Error ? error.message : "Mission role policy failed", "invalid-role-policy")
        }
        const coordinator = await this.ownedRootSession(sessionID)
        const actor = mission.actors.find(actor => actor.sessionId === sessionID)
        if (!actor || !sameLocation(coordinator.location, actor.location)) throw new MissionControlError("Coordinator moved", "foreign-session")
        this.assertActive()
        await this.journal.append({ version: MISSION_SCHEMA_VERSION, id: this.eventID(mission.id, `task-${input.taskKey}-created`),
          type: "task.created", missionID: mission.id, projectID: mission.projectID,
          task: { id: `tsk_${stableToken(`${mission.id}\0${input.taskKey}`, 24)}`, key: input.taskKey,
            title: input.title, brief: input.brief, role: input.role, blockedBy: input.blockedBy,
            execution: input.execution, executionMode: input.executionMode }, createdAt: this.timestamp(snapshot) })
        snapshot = await this.snapshot()
        mission = this.requireMission(snapshot, mission.id)
        task = mission.tasks.find(task => task.key === input.taskKey)
        if (!task || !sameExecutionMode(task.executionMode, input.executionMode)) throw new MissionControlError("Task declaration was not accepted", "invalid-journal")
        await this.emitChanged(mission.id, snapshot)
      }
      if (!Number.isSafeInteger(task.contractGeneration) || task.contractGeneration! < 1) throw new MissionControlError("Task generation unavailable", "invalid-journal")
      return { disposition, mission, contract: { missionID: mission.id, taskKey: task.key, generation: task.contractGeneration! } }
    })
  }

  inspect(sessionID: string, input: MissionInspectInput, operationID: string): Promise<MissionInspection> {
    if (!input.start) return this.inspectCurrent(sessionID, input, operationID)
    return this.mutate(() => this.inspectCurrent(sessionID, input, operationID))
  }

  private async inspectCurrent(sessionID: string, input: MissionInspectInput, operationID: string): Promise<MissionInspection> {
    input = structuredClone(input)
    const caller = await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    if (input.start) {
      try { input.start.profiles = parseMissionProfiles(input.start.profiles); validateMissionProfiles(input.start.template, input.start.profiles) }
      catch { throw new MissionControlError("Invalid Mission profile selection", "invalid-execution") }
      const missionID = `msn_${stableToken(`${this.options.project.id}\0${sessionID}\0${operationID}`, 24)}`
      const replay = snapshot.missions.find((mission) => mission.id === missionID)
      if (replay) {
        if (replay.template !== input.start.template || replay.objective !== input.start.objective
          || replay.notes !== input.start.notes || !sameMissionProfiles(replay.profiles, input.start.profiles)) {
          throw new MissionControlError("Creation request ID was already used with a different mission", "request-conflict")
        }
        return this.inspection(replay, sessionID)
      }
      const active = this.membership(snapshot, sessionID)
      if (active?.status === "active" || active?.control?.pending.includes(sessionID)) throw new MissionControlError("This session already belongs to an active mission", "already-member")
      if (snapshot.missions.length >= MISSION_MAX_MISSIONS) {
        throw new MissionControlError("Project mission limit reached", "mission-limit")
      }
      try { await this.options.validateProfiles?.(input.start.profiles, caller.location.directory) }
      catch { throw new MissionControlError("Mission profiles do not match the owned native catalog", "invalid-execution") }
      const fresh = await this.ownedRootSession(sessionID)
      if (!sameLocation(caller.location, fresh.location) || !matchesExecution(input.start.profiles?.coordinator, fresh)) {
        throw new MissionControlError("Coordinator moved or differs from the requested native profile", "invalid-execution")
      }
      const event: MissionEvent = {
        version: MISSION_SCHEMA_VERSION,
        id: this.eventID(missionID, "created"),
        type: "mission.created",
        missionID,
        projectID: this.options.project.id,
        projectCanonical: this.options.project.canonical,
        objective: input.start.objective,
        notes: input.start.notes,
        template: input.start.template,
        ...(input.start.profiles === undefined ? {} : { profiles: input.start.profiles }),
        coordinator: {
          sessionID,
          title: caller.title ?? "Mission coordinator",
          location: caller.location,
        },
        createdAt: this.timestamp(snapshot),
      }
      await this.journal.append(event)
      snapshot = await this.snapshot()
      await this.emitChanged(missionID, snapshot)
      return this.inspection(this.requireMission(snapshot, missionID), sessionID)
    }

    const mission = this.selectMission(snapshot, sessionID, input.missionID)
    return mission ? this.inspection(mission, sessionID) : {
      mission: null,
      actor: null,
      templates: missionRecipeCatalog(),
    }
  }

  delegate(sessionID: string, input: MissionDelegateInput): Promise<{ disposition: "blocked" | "dispatched" | "existing"; mission: MissionMap }> {
    return this.mutate(() => this.delegateCurrent(sessionID, input))
  }

  private async delegateCurrent(sessionID: string, input: MissionDelegateInput): Promise<{ disposition: "blocked" | "dispatched" | "existing"; mission: MissionMap }> {
    await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
    this.assertCoordinator(mission, sessionID)
    input = { ...input, execution: input.execution ?? structuredClone(mission.profiles?.roles?.[input.role]) }
    if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
    if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
    const blockedBy = normalizeBlockedBy(input.blockedBy)
    try {
      validateMissionDelegationPolicy({
        template: mission.template,
        role: input.role,
        targetSessionID: input.targetSessionID,
        blockedBy,
        tasks: mission.tasks,
        executionMode: input.executionMode,
      })
    } catch (error) {
      throw new MissionControlError(error instanceof Error ? error.message : "Mission role policy failed", "invalid-role-policy")
    }

    let task = mission.tasks.find((candidate) => candidate.key === input.taskKey)
    if (input.executionMode?.kind === "native" || task?.executionMode?.kind === "native") {
      throw new MissionControlError("Native tasks execute through the native subagent tool, not root dispatch", "native-execution-required")
    }
    if (!task) {
      if (input.targetSessionID) await this.ownedRootSession(input.targetSessionID)
      await this.options.validateExecution?.(input, sessionID)
      if (mission.tasks.length >= MISSION_MAX_TASKS) throw new MissionControlError("Mission task limit reached", "task-limit")
      if (blockedBy.includes(input.taskKey)) throw new MissionControlError("A task cannot block itself", "invalid-blocker")
      const existingTasks = mission.tasks
      const unknownBlocker = blockedBy.find((key) => !existingTasks.some((candidate) => candidate.key === key))
      if (unknownBlocker) throw new MissionControlError(`Unknown blocker: ${unknownBlocker}`, "invalid-blocker")
      await this.journal.append({
        version: MISSION_SCHEMA_VERSION,
        id: this.eventID(mission.id, `task-${input.taskKey}-created`),
        type: "task.created",
        missionID: mission.id,
        projectID: mission.projectID,
        task: {
          id: `tsk_${stableToken(`${mission.id}\0${input.taskKey}`, 24)}`,
          key: input.taskKey,
          title: input.title,
          brief: input.brief,
          role: input.role,
          ...(input.execution === undefined ? {} : { execution: input.execution }),
          ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
          blockedBy,
        },
        createdAt: this.timestamp(snapshot),
      })
      snapshot = await this.snapshot()
      mission = this.requireMission(snapshot, mission.id)
      task = mission.tasks.find((candidate) => candidate.key === input.taskKey)!
      await this.emitChanged(mission.id, snapshot)
    } else {
      const same = task.title === input.title && task.brief === input.brief && task.role === input.role
        && equalStrings(task.blockedBy, blockedBy)
        && sameExecution(task.execution, input.execution)
        && sameExecutionMode(task.executionMode, input.executionMode)
      if (!same) throw new MissionControlError("Task key already exists with a different contract", "task-conflict")
    }

    if (task.status === "withdrawn") throw new MissionControlError("This task was withdrawn; create new work with a new task key", "task-withdrawn")
    if (task.report || task.status === "queued") return { disposition: "existing", mission }
    if (task.status === "blocked") return { disposition: "blocked", mission }
    if (task.status === "dispatching") {
      mission = await this.finishDispatch(mission, task.key)
      return { disposition: "dispatched", mission }
    }

    if (input.targetSessionID) {
      const target = await this.ownedRootSession(input.targetSessionID)
      if (!matchesExecution(task.execution, target)) {
        throw new MissionControlError("Target agent/model differs from the task contract; select another actor instead of switching a busy session", "execution-conflict")
      }
    }
    const actor = await this.selectActor(snapshot, mission, sessionID, task, input.targetSessionID)
    const admissionID = this.messageID(`assignment\0${mission.id}\0${task.key}`)
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: this.eventID(mission.id, `task-${task.key}-dispatching`),
      type: "task.dispatching",
      missionID: mission.id,
      projectID: mission.projectID,
      taskKey: task.key,
      actor,
      admissionID,
      delivery: input.delivery,
      createdAt: this.timestamp(snapshot),
    })
    snapshot = await this.snapshot()
    mission = this.requireMission(snapshot, mission.id)
    await this.emitChanged(mission.id, snapshot)
    mission = await this.finishDispatch(mission, task.key)
    return { disposition: "dispatched", mission }
  }

  report(sessionID: string, input: MissionReportInput): Promise<{ disposition: "reported" | "finished" | "existing"; mission: MissionMap }> {
    return this.mutate(() => this.reportCurrent(sessionID, input))
  }

  async reportNative(request: MissionNativeReportRequest, input: MissionReportInput): Promise<{
    disposition: "reported" | "finished" | "existing"; mission: MissionMap
  }> {
    if (!this.options.authorizeNativeReport) throw new MissionControlError("Native report authority unavailable", "policy-unqualified")
    request = structuredClone(request)
    input = structuredClone(input)
    request.contract = taskContractReferenceSchema.parse(request.contract)
    if (input.final || (input.missionID !== undefined && input.missionID !== request.contract.missionID)
      || (input.taskKey !== undefined && input.taskKey !== request.contract.taskKey)) {
      throw new MissionControlError("Native report must identify its exact task, never finalization", "invalid-report-contract")
    }
    // Never nest an authority-store transaction inside the shared business lock.
    const proof = await this.options.authorizeNativeReport(structuredClone(request))
    const call = parseNativeCall(proof.call)
    if (!call || call.generation !== request.contract.generation) throw new MissionControlError("Native report generation differs", "invalid-report-contract")
    const current = () => {
      this.assertActive()
      const result: unknown = proof.current()
      if (result !== true) {
        if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {})
        throw new MissionControlError("Native report publication guard must be synchronous", "policy-unqualified")
      }
    }
    current()
    return this.mutate(() => this.reportCurrent(request.sessionID,
      { ...input, missionID: request.contract.missionID, taskKey: request.contract.taskKey }, { call, current }))
  }

  retryPendingNotifications(isActive: () => boolean = () => true, after?: string): Promise<MissionNotificationRetryResult> {
    return this.mutate(async () => {
      if (!isActive()) return { attempted: 0, failed: 0 }
      const snapshot = await this.snapshot()
      if (snapshot.notificationUnavailable || snapshot.controlUnavailable) throw new Error("Mission notification evidence unavailable; damaged journal")
      const pending = snapshot.missions
        .filter(mission => missionIsRunning(mission) && !mission.control?.pending.length)
        .flatMap((mission) => mission.reports
          .filter((report) => isCoordinatorNotificationReport(report) && report.notificationStatus !== "admitted")
          .map((report) => ({ missionID: mission.id, report, cursor: `${mission.id}\0${report.id}` })))
        .sort((left, right) => left.cursor.localeCompare(right.cursor))
      if (pending.length === 0) return { attempted: 0, failed: 0 }
      const first = after ? pending.findIndex((item) => item.cursor > after) : 0
      const start = first < 0 ? 0 : first
      const batch = Array.from({ length: Math.min(MISSION_NOTIFICATION_BATCH_SIZE, pending.length) }, (_, index) =>
        pending[(start + index) % pending.length]!)
      let attempted = 0
      let failed = 0
      let cursor: string | undefined
      for (const item of batch) {
        if (!isActive()) break
        cursor = item.cursor
        attempted += 1
        try {
          await this.notifyCoordinator(this.requireMission(await this.snapshot(), item.missionID), item.report, isActive)
        } catch {
          // Keep failed durable outbox entries pending; later bounded passes retry them.
          failed += 1
        }
      }
      return { attempted, failed, cursor }
    })
  }

  private async reportCurrent(sessionID: string, input: MissionReportInput,
    native?: { call: import("./model").MissionNativeBinding; current(): void }): Promise<{ disposition: "reported" | "finished" | "existing"; mission: MissionMap }> {
    native?.current()
    const caller = native ? await this.ownedSession(sessionID) : await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
    const actor = mission.actors.find(actor => actor.sessionId === sessionID)
    if (!actor || !sameLocation(caller.location, actor.location)) {
      throw new MissionControlError("Mission actor moved from its admitted location", "foreign-session")
    }

    if (input.final) {
      if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable) {
        throw new MissionControlError("Damaged Mission journal cannot authorize finalization", "invalid-journal")
      }
      this.assertCoordinator(mission, sessionID)
      if (mission.status !== "active") return { disposition: "existing", mission }
      if (!missionIsRunning(mission)) throw new MissionControlError("Mission is not running", "mission-not-running")
      if (mission.control?.pending.length) throw new MissionControlError("Native mission control is pending", "control-pending")
      if (input.outcome === "blocked") throw new MissionControlError("A final mission outcome must be completed or failed", "invalid-final-outcome")
      if (input.outcome === "completed" && mission.template === "wayfinder"
        && mission.tasks.some(task => task.role === "decision" && task.executionMode?.kind === "native" && task.status === "completed")) {
        // Cached Forms and question outputs have no durable Form ID/principal
        // producer in the supported ABI. Preserve evidence, never infer a human
        // decision from model JSON or an originating-human grant lease.
        throw new MissionControlError("Durable native human-decision evidence unavailable", "policy-unqualified")
      }
      if (mission.tasks.some(hasUnsettledNativeExecution)) {
        throw new MissionControlError("Native work needs an observed invocation end before the mission can finish", "outstanding-execution")
      }
      if (mission.tasks.some((task) => task.outstandingExecution)) {
        throw new MissionControlError("Withdrawn work needs a terminal report before the mission can finish", "outstanding-execution")
      }
      if (input.outcome === "completed" && mission.tasks.some((task) => task.status !== "completed" && task.status !== "withdrawn")) {
        throw new MissionControlError("Every mission task must be complete before a green finish", "open-tasks")
      }
      try {
        validateMissionCompletionPolicy({ template: mission.template, outcome: input.outcome, tasks: mission.tasks })
      } catch (error) {
        throw new MissionControlError(error instanceof Error ? error.message : "Mission completion policy failed", "invalid-role-policy")
      }
      await this.journal.append({
        version: MISSION_SCHEMA_VERSION,
        id: this.eventID(mission.id, "finished"),
        type: "mission.finished",
        missionID: mission.id,
        projectID: mission.projectID,
        outcome: input.outcome,
        summary: input.summary,
        createdAt: this.timestamp(snapshot),
      })
      snapshot = await this.snapshot()
      mission = this.requireMission(snapshot, mission.id)
      await this.emitChanged(mission.id, snapshot)
      return { disposition: "finished", mission }
    }

    const declared = input.taskKey && mission.tasks.find(task => task.key === input.taskKey)
    if (!native && sessionID === mission.coordinatorSessionId && declared && declared.executionMode?.kind === "native") {
      const readout = coordinatorReadout(snapshot, mission, declared, input, this.timestamp(snapshot))
      if (readout.existing) return { disposition: "existing", mission }
      const fresh = await this.ownedRootSession(sessionID)
      if (!sameLocation(fresh.location, caller.location)) throw new MissionControlError("Coordinator moved during readout", "foreign-session")
      this.assertActive()
      await this.journal.append({ version: MISSION_SCHEMA_VERSION,
        id: this.eventID(mission.id, `task-${declared.key}-coordinator-readout`), type: "task.reported",
        missionID: mission.id, projectID: mission.projectID, report: readout.report, createdAt: readout.report.createdAt })
      snapshot = await this.snapshot()
      mission = this.requireMission(snapshot, mission.id)
      if (!mission.reports.some(report => report.id === readout.report.id)) throw new MissionControlError("Coordinator readout was not accepted", "invalid-journal")
      await this.emitChanged(mission.id, snapshot)
      return { disposition: "reported", mission }
    }
    const task = this.reportTask(mission, sessionID, input.taskKey)
    if (native) {
      const mode = task.executionMode
      const parentSessionID = mode?.kind === "native" && mode.parentTaskKey !== null
        ? mission.tasks.find(parent => parent.key === mode.parentTaskKey)?.actorSessionId : mission.coordinatorSessionId
      if (mode?.kind !== "native" || task.contractGeneration !== native.call.generation
        || caller.parentID !== parentSessionID || native.call.parentSessionID !== parentSessionID) {
        throw new MissionControlError("Native report actor, parent or generation differs", "invalid-report-contract")
      }
      const parent = await this.ownedSession(parentSessionID!)
      if (!sameLocation(parent.location, caller.location)) throw new MissionControlError("Native report family moved", "foreign-session")
      const history = await this.journal.events()
      const admitted = history.events.some(event => event.missionID === mission!.id
        && (event.type === "task.native-bound" || event.type === "task.native-call-started")
        && event.taskKey === task.key && sameNativeCall(event.binding, native.call)
        && (event.type === "task.native-bound" ? event.actor.sessionID : event.childSessionID) === sessionID)
      const historical = task.status === "withdrawn" || mission.status === "stopped"
      if (history.discardedEvents || snapshot.discardedEvents || !admitted
        || (!historical && !sameNativeCall(task.nativeExecution?.binding, native.call))) {
        throw new MissionControlError("Native report invocation was not accepted", "invalid-report-contract")
      }
      if (mission.template === "wayfinder" && task.role === "decision" && input.outcome === "completed") {
        try { validateMissionReportArtifact({ template: mission.template, role: task.role, outcome: input.outcome,
          artifact: input.artifact, nativeDecision: { contract: { missionID: mission.id, taskKey: task.key, generation: native.call.generation },
            call: native.call, sessionID } }) }
        catch { throw new MissionControlError("Native decision report requires exact Form provenance", "invalid-report-contract") }
        // The observation reader intentionally returns only unknown/unqualified.
        // There is no authenticated durable human-reply producer to admit this
        // completed decision. Do not replace it with a callback/boolean receipt.
        throw new MissionControlError("Durable native human-decision evidence unavailable", "policy-unqualified")
      }
      const previous = mission.reports.find(report => report.taskKey === task.key && sameNativeCall(report.nativeCall, native.call))
      if (previous) {
        let artifact
        try { artifact = validateMissionReportArtifact({ template: mission.template, role: task.role, outcome: input.outcome, artifact: input.artifact }) }
        catch (error) { throw new MissionControlError(error instanceof Error ? error.message : "Mission report contract failed", "invalid-report-contract") }
        if (previous.outcome !== input.outcome || previous.summary !== input.summary
          || !isDeepStrictEqual(previous.evidence, input.evidence) || !isDeepStrictEqual(previous.next, input.next)
          || !isDeepStrictEqual(previous.artifact, artifact)) {
          throw new MissionControlError("Native report invocation already has different immutable evidence", "request-conflict")
        }
        native.current()
        return { disposition: "existing", mission }
      }
      if (task.report && !historical) throw new MissionControlError("Task already has a business report; use a new task contract for new work", "request-conflict")
      native.current()
    }
    const lateReport = task.lateReports?.at(-1)
    if (lateReport && !native) {
      await this.notifySavedReport(mission, lateReport)
      return { disposition: "existing", mission: this.requireMission(await this.snapshot(), mission.id) }
    }
    if (task.report && !native) {
      await this.notifySavedReport(mission, task.report)
      return { disposition: "existing", mission: this.requireMission(await this.snapshot(), mission.id) }
    }
    const late = task.status === "withdrawn" || mission.status === "stopped"
    if (late && !task.admissionId && !native) throw new MissionControlError("The assigned task has not been dispatched", "task-not-dispatched")
    if (!late && task.status !== "queued" && task.status !== "dispatching") {
      throw new MissionControlError("The assigned task has not been dispatched", "task-not-dispatched")
    }

    let artifact
    try {
      artifact = validateMissionReportArtifact({
        template: mission.template,
        role: task.role,
        outcome: input.outcome,
        artifact: input.artifact,
      })
    } catch (error) {
      throw new MissionControlError(error instanceof Error ? error.message : "Mission report contract failed", "invalid-report-contract")
    }
    const report: MissionReport = {
      id: `rpt_${stableToken(`${mission.id}\0${task.key}${native ? `\0${JSON.stringify(native.call)}` : ""}`, 24)}`,
      taskKey: task.key,
      sessionId: sessionID,
      outcome: input.outcome,
      summary: input.summary,
      evidence: input.evidence,
      next: input.next,
      artifact,
      ...(late ? { late: true } : {}),
      ...(native ? { nativeCall: native.call, delivery: "native-return" as const } : {}),
      createdAt: this.timestamp(snapshot),
    }
    if (native) {
      const actual = await this.ownedSession(sessionID)
      const parent = await this.ownedSession(native.call.parentSessionID)
      if (actual.parentID !== native.call.parentSessionID || !sameLocation(actual.location, caller.location)
        || !sameLocation(actual.location, parent.location)) {
        throw new MissionControlError("Native report family moved during preparation", "foreign-session")
      }
    }
    native?.current()
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: this.eventID(mission.id, `task-${task.key}-reported${native ? `-${report.id}` : ""}`),
      type: "task.reported",
      missionID: mission.id,
      projectID: mission.projectID,
      report,
      createdAt: report.createdAt,
    }, native?.current)
    snapshot = await this.snapshot()
    mission = this.requireMission(snapshot, mission.id)
    if (native && !mission.reports.some(saved => saved.id === report.id && sameNativeCall(saved.nativeCall, native.call))) {
      throw new MissionControlError("Native report was not accepted by the business journal", "invalid-journal")
    }
    await this.emitChanged(mission.id, snapshot)
    await this.notifySavedReport(mission, report)
    return { disposition: "reported", mission: this.requireMission(await this.snapshot(), mission.id) }
  }

  async contextFor(sessionID: string): Promise<string | undefined> {
    const snapshot = await this.snapshot()
    const mission = this.membership(snapshot, sessionID)
    if (!mission || mission.status !== "active") return undefined
    if (!missionIsRunning(mission)) return `Mission ${mission.id} is ${mission.runState}. Do not continue mission work or create a replacement mission. Wait for the user's Play action. Saved reports may still be recorded without waking the coordinator.`
    return buildActorContext(mission, sessionID) || undefined
  }

  private async finishDispatch(mission: MissionMap, taskKey: string): Promise<MissionMap> {
    const task = mission.tasks.find((candidate) => candidate.key === taskKey)
    if (!task?.actorSessionId || !task.admissionId || !task.delivery) {
      throw new MissionControlError("Task dispatch intent is incomplete", "invalid-dispatch")
    }
    const actor = mission.actors.find((candidate) => candidate.sessionId === task.actorSessionId)
    if (!actor) throw new MissionControlError("Task actor is missing", "invalid-dispatch")
    const session = await this.ensureActorSession(mission, actor, task)
    this.assertActive()
    this.assertOwnedRoot(session)
    if (session.id !== actor.sessionId || !sameLocation(session.location, actor.location)) {
      throw new MissionControlError("Created actor differs from published root", "foreign-session")
    }
    if (!matchesExecution(task.execution, session)) {
      throw new MissionControlError("Actor agent/model changed since dispatch; restore its selection before retrying", "execution-conflict")
    }
    const prompt = assignmentInput(mission, task)
    if (this.options.transport) await this.options.transport.prompt(mission.coordinatorSessionId, prompt)
    else await this.options.sessions.prompt(prompt)
    const snapshot = await this.snapshot()
    this.assertActive()
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: this.eventID(mission.id, `task-${task.key}-dispatched`),
      type: "task.dispatched",
      missionID: mission.id,
      projectID: mission.projectID,
      taskKey: task.key,
      createdAt: this.timestamp(snapshot),
    })
    const updated = await this.snapshot()
    await this.emitChanged(mission.id, updated)
    return this.requireMission(updated, mission.id)
  }

  private async selectActor(
    snapshot: MissionSnapshot,
    mission: MissionMap,
    coordinatorID: string,
    task: MissionMap["tasks"][number],
    targetSessionID?: string,
  ): Promise<{ sessionID: string; title: string; location: MissionActor["location"]; managed: boolean }> {
    if (targetSessionID === coordinatorID) throw new MissionControlError("The coordinator cannot delegate a task to itself", "invalid-target")
    if (targetSessionID) {
      const target = await this.ownedRootSession(targetSessionID)
      if (mission.actors.length >= MISSION_MAX_ACTORS && !mission.actors.some((actor) => actor.sessionId === targetSessionID)) {
        throw new MissionControlError("Mission actor limit reached", "actor-limit")
      }
      const foreignMission = snapshot.missions.find((candidate) => (candidate.status === "active" || candidate.control?.pending.includes(targetSessionID))
        && candidate.id !== mission.id && candidate.actors.some((actor) => actor.sessionId === targetSessionID))
      if (foreignMission) throw new MissionControlError("Target session already belongs to another active mission", "target-claimed")
      return {
        sessionID: target.id,
        title: target.title ?? `${task.role}: ${task.title}`,
        location: target.location,
        managed: false,
      }
    }
    if (mission.actors.length >= MISSION_MAX_ACTORS) throw new MissionControlError("Mission actor limit reached", "actor-limit")
    return {
      sessionID: `ses_${stableToken(`${mission.id}\0task\0${task.id}`, 26)}`,
      title: `Mission · ${task.role}: ${task.title}`.slice(0, 160),
      location: (await this.ownedRootSession(coordinatorID)).location,
      managed: true,
    }
  }

  private async ensureActorSession(mission: MissionMap, actor: MissionActor, task: MissionMap["tasks"][number]): Promise<NativeMissionSession> {
    // Every managed desktop retry consults the held-operation capability, even
    // when a late root is now readable. GET existence cannot settle an ACK loss.
    if (actor.managed && this.options.createManagedRoot) {
      this.assertActive()
      return this.options.createManagedRoot(mission.coordinatorSessionId, { missionID: mission.id, taskKey: task.key })
    }
    try {
      return await this.options.sessions.get({ sessionID: actor.sessionId })
    } catch (getError) {
      if (!actor.managed) throw new MissionControlError("Target session no longer exists", "target-missing")
      this.assertActive()
      // Desktop creation must cross the same authenticated backend/fence as
      // prompts, but BEFORE creating the root. No native fallback on rejection.
      try {
        return await this.options.sessions.create({
          id: actor.sessionId,
          title: actor.title || `Mission · ${task.role}: ${task.title}`,
          location: actor.location,
          metadata: this.metadata(mission.id, "actor", { role: task.role }),
          ...task.execution,
        })
      } catch (createError) {
        try {
          return await this.options.sessions.get({ sessionID: actor.sessionId })
        } catch {
          throw createError instanceof Error ? createError : getError
        }
      }
    }
  }

  private async notifySavedReport(mission: MissionMap, report: MissionReport): Promise<void> {
    try { await this.notifyCoordinator(mission, report) }
    catch {
      // The report has already been committed. Its successful durable write must
      // not be reported as a failed tool because the owner/bridge disappeared or
      // the notification ACK was lost. The returned map exposes pending, and the
      // bounded outbox retries only that notification with its original native ID.
    }
  }

  private async notifyCoordinator(mission: MissionMap, report: MissionReport, isActive: () => boolean = () => true): Promise<void> {
    if (!isActive() || !isCoordinatorNotificationReport(report)) return
    const fresh = await this.snapshot()
    if (fresh.notificationUnavailable || fresh.controlUnavailable) throw new Error("Mission notification evidence unavailable; damaged journal")
    const currentMission = fresh.missions.find((candidate) => candidate.id === mission.id)
    const currentReport = currentMission?.reports.find((candidate) => candidate.id === report.id)
    if (!currentMission || !missionIsRunning(currentMission) || currentMission.control?.pending.length || !currentReport
      || !isCoordinatorNotificationReport(currentReport) || currentReport.notificationStatus === "admitted" || !isActive()) return
    const notification = reportInput(currentMission, currentReport)
    const admissionID = notification.id
    if (this.options.transport) await this.options.transport.synthetic(currentMission.coordinatorSessionId, notification)
    else await this.options.sessions.synthetic(notification)
    if (!isActive()) return
    const snapshot = await this.snapshot()
    if (snapshot.notificationUnavailable || snapshot.controlUnavailable) throw new Error("Mission notification evidence unavailable; damaged journal")
    const afterAdmission = snapshot.missions.find((candidate) => candidate.id === mission.id)
    if (!afterAdmission || afterAdmission.status !== "active"
      || afterAdmission.reports.find((candidate) => candidate.id === report.id)?.notificationStatus === "admitted") return
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: reportNotificationID(mission.id, report.id),
      type: "report.notified",
      missionID: mission.id,
      projectID: mission.projectID,
      reportID: report.id,
      admissionID,
      createdAt: Math.max(report.createdAt + 1, this.timestamp(snapshot)),
    })
    const updated = await this.snapshot()
    await this.emitChanged(mission.id, updated)
  }

  private reportTask(mission: MissionMap, sessionID: string, taskKey?: string) {
    const assigned = mission.tasks.filter((task) => task.actorSessionId === sessionID)
    const task = taskKey ? assigned.find((candidate) => candidate.key === taskKey) : assigned.filter((candidate) => !candidate.report)[0]
    if (!task) throw new MissionControlError("No matching task is assigned to this session", "task-not-found")
    if (!taskKey && assigned.filter((candidate) => !candidate.report).length !== 1) {
      throw new MissionControlError("taskKey is required when multiple assignments are open", "task-key-required")
    }
    return task
  }

  private async ownedRootSession(sessionID: string): Promise<NativeMissionSession> {
    const session = await this.ownedSession(sessionID)
    this.assertOwnedRoot(session)
    return session
  }

  private async ownedSession(sessionID: string): Promise<NativeMissionSession> {
    let session: NativeMissionSession
    try {
      session = await this.options.sessions.get({ sessionID })
    } catch {
      throw new MissionControlError("Session not found", "session-not-found")
    }
    if (session.id !== sessionID || session.projectID !== this.options.project.id
      || (session.projectID === "global" && !pathContains(this.options.project.canonical, session.location.directory))) {
      throw new MissionControlError("Session belongs to another project or identity", "foreign-session")
    }
    return session
  }

  private assertOwnedRoot(session: NativeMissionSession): void {
    if (session.parentID) throw new MissionControlError("Missions accept root sessions only", "child-session")
    if (session.projectID !== this.options.project.id) throw new MissionControlError("Session belongs to another project", "foreign-session")
    if (session.projectID === "global" && !pathContains(this.options.project.canonical, session.location.directory)) {
      throw new MissionControlError("Global session belongs to another location", "foreign-session")
    }
  }

  private selectMission(snapshot: MissionSnapshot, sessionID: string, missionID?: string): MissionMap | undefined {
    if (missionID) {
      const mission = snapshot.missions.find((candidate) => candidate.id === missionID)
      if (!mission || !mission.actors.some((actor) => actor.sessionId === sessionID)) {
        throw new MissionControlError("Mission is not visible to this session", "mission-not-found")
      }
      return mission
    }
    return this.membership(snapshot, sessionID)
  }

  private membership(snapshot: MissionSnapshot, sessionID: string): MissionMap | undefined {
    return snapshot.missions.find((mission) => mission.status === "active" && mission.actors.some((actor) => actor.sessionId === sessionID))
      ?? snapshot.missions.find((mission) => mission.actors.some((actor) => actor.sessionId === sessionID))
  }

  private inspection(mission: MissionMap, sessionID: string): MissionInspection {
    return {
      mission,
      actor: mission.actors.find((candidate) => candidate.sessionId === sessionID) ?? null,
      templates: missionRecipeCatalog(),
      playbook: getMissionRecipe(mission.template),
    }
  }

  private requireMission(snapshot: MissionSnapshot, missionID: string): MissionMap {
    const mission = snapshot.missions.find((candidate) => candidate.id === missionID)
    if (!mission) throw new MissionControlError("Mission journal could not be reconstructed", "invalid-journal")
    return mission
  }

  private assertCoordinator(mission: MissionMap, sessionID: string): void {
    if (mission.coordinatorSessionId !== sessionID) {
      throw new MissionControlError("Only the mission coordinator may change topology", "coordinator-only")
    }
  }

  private eventID(missionID: string, purpose: string): string {
    return `evt_${stableToken(`${missionID}\0${purpose}`, 28)}`
  }

  private messageID(purpose: string): string {
    return `msg_${stableToken(purpose, 28)}`
  }

  private timestamp(snapshot: MissionSnapshot): number {
    const now = this.options.now?.() ?? Date.now()
    const latest = snapshot.missions.reduce((value, mission) => Math.max(value, mission.updatedAt), 0)
    this.lastTimestamp = Math.max(now, latest + 1, this.lastTimestamp + 1)
    return this.lastTimestamp
  }

  private metadata(missionID: string, kind: string, extra: Record<string, JsonValue>): SessionMetadata {
    return { "codenomad.mission": { version: MISSION_SCHEMA_VERSION, missionID, kind, ...extra } }
  }

  private async emitChanged(missionID: string, snapshot: MissionSnapshot, revisionOverride?: number): Promise<void> {
    const revision = revisionOverride ?? snapshot.missions.find((mission) => mission.id === missionID)?.revision ?? 0
    await this.options.changed?.(missionID, revision).catch(() => undefined)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return runMissionExclusive(`mutation:${this.journal.projectToken}`, operation)
  }

  private assertActive(): void {
    if (this.options.isActive && !this.options.isActive()) throw new Error("CodeNomad Missions is no longer available")
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeBlockedBy(blockedBy: readonly string[]): string[] {
  return [...new Set(blockedBy)].sort()
}

function normalizeRevisionDependencies(input: MissionReviseInput): MissionReviseInput {
  return {
    ...input,
    addTasks: input.addTasks.map(task => {
      const { replacesTaskKey, ...declaration } = task
      return { ...normalizeTaskDeclaration(declaration), ...(replacesTaskKey === undefined ? {} : { replacesTaskKey }) }
    }),
    dependencyUpdates: input.dependencyUpdates.map(update => ({ ...update, blockedBy: normalizeBlockedBy(update.blockedBy) })),
  }
}

function normalizeRevisionEventDependencies(event: MissionRevisedEvent): MissionRevisedEvent {
  return {
    ...event,
    addedTasks: event.addedTasks.map(task => ({ ...task, blockedBy: normalizeBlockedBy(task.blockedBy) })),
    dependencyUpdates: event.dependencyUpdates.map(update => ({ ...update, blockedBy: normalizeBlockedBy(update.blockedBy) })),
  }
}

function sameRevisionRequest(event: MissionRevisedEvent, input: MissionReviseInput): boolean {
  event = normalizeRevisionEventDependencies(event)
  const added = event.addedTasks.map((task) => ({
    taskKey: task.key, title: task.title, brief: task.brief, role: task.role,
    ...(task.execution === undefined ? {} : { execution: task.execution }),
    ...(task.executionMode === undefined ? {} : { executionMode: task.executionMode }),
    blockedBy: task.blockedBy, ...(task.replacesTaskKey === undefined ? {} : { replacesTaskKey: task.replacesTaskKey }),
  }))
  return event.reason === input.reason && event.objective === input.objective
    && event.notesSpecified === (input.notes !== undefined) && event.notes === input.notes
    && isDeepStrictEqual(event.retiredTasks, input.retireTasks)
    && isDeepStrictEqual(added, input.addTasks)
    && isDeepStrictEqual(event.dependencyUpdates, input.dependencyUpdates)
}

function assertAcyclicDependencies(tasks: ReadonlyMap<string, { blockedBy: string[] }>): void {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new MissionControlError("Mission dependencies cannot contain a cycle", "dependency-cycle")
    if (visited.has(key)) return
    visiting.add(key)
    for (const dependency of tasks.get(key)?.blockedBy ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of tasks.keys()) visit(key)
}
