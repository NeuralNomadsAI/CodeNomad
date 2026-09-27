import path from "node:path"
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
import { validateMissionCompletionPolicy, validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"
import { runMissionExclusive } from "./exclusive"
import { matchesExecution, sameExecution } from "./execution"
import type {
  MissionDelegateInput,
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
} from "./control-types"

export class MissionControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "MissionControlError"
  }
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
    transport?: MissionInputTransport
  }) {
    this.journal = new MissionJournal(options.storage, options.project.id, options.project.canonical, options.now)
  }

  snapshot(): Promise<MissionSnapshot> {
    return this.journal.snapshot()
  }

  create(input: MissionCreateInput): Promise<{ mission: MissionMap }> {
    return this.mutate(() => this.createCurrent(input))
  }

  private async createCurrent(input: MissionCreateInput): Promise<{ mission: MissionMap }> {
    const missionID = `msn_${stableToken(`${this.options.project.id}\0${input.requestID}`, 24)}`
    const eventID = this.eventID(missionID, "created")
    const existingEvent = await this.journal.event(missionID, eventID)
    let snapshot = await this.snapshot()
    const existing = snapshot.missions.find((mission) => mission.id === missionID)
    if (existingEvent) {
      if (existingEvent.type !== "mission.created" || existingEvent.objective !== input.objective
        || existingEvent.notes !== input.notes || existingEvent.template !== input.template
        || (input.coordinatorSessionID !== undefined && existingEvent.coordinator.sessionID !== input.coordinatorSessionID)) {
        throw new MissionControlError("Creation request ID was already used with a different mission", "request-conflict")
      }
      if (!existing) throw new MissionControlError("Mission was deleted and cannot be recreated", "mission-deleted")
      return { mission: existing }
    }
    if (snapshot.missions.length >= MISSION_MAX_MISSIONS) throw new MissionControlError("Project mission limit reached", "mission-limit")
    await this.journal.assertCanAppend()

    let coordinator: NativeMissionSession
    if (input.coordinatorSessionID) {
      coordinator = await this.ownedRootSession(input.coordinatorSessionID)
      if (snapshot.missions.some((mission) => mission.status === "active"
        && mission.actors.some((actor) => actor.sessionId === coordinator.id))) {
        throw new MissionControlError("Coordinator session already belongs to an active mission", "already-member")
      }
    } else {
      const sessionID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
      try {
        coordinator = await this.options.sessions.get({ sessionID })
      } catch {
        coordinator = await this.options.sessions.create({
          id: sessionID,
          title: `Mission coordinator: ${input.objective}`.slice(0, 160),
          location: this.options.project.location,
          metadata: this.metadata(missionID, "coordinator", { role: "coordinator" }),
        })
      }
      this.assertOwnedRoot(coordinator)
    }

    const createdAt = this.timestamp(snapshot)
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
      requestID: input.requestID,
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
    return this.mutate(() => this.deleteCurrent(input))
  }

  revise(sessionID: string, input: MissionReviseInput): Promise<{ mission: MissionMap }> {
    return this.mutate(() => this.reviseCurrent(sessionID, input))
  }

  private async reviseCurrent(sessionID: string, input: MissionReviseInput): Promise<{ mission: MissionMap }> {
    await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")
    this.assertCoordinator(mission, sessionID)
    const eventID = this.eventID(mission.id, `revised-${input.requestID}`)
    const previous = await this.journal.event(mission.id, eventID)
    if (previous) {
      if (previous.type !== "mission.revised" || previous.actorSessionID !== sessionID
        || previous.expectedRevision !== input.expectedRevision || !sameRevisionRequest(previous, input)) {
        throw new MissionControlError("Revision request ID was already used with a different change", "request-conflict")
      }
      return { mission }
    }
    if (mission.status !== "active") throw new MissionControlError("The mission is already finished", "mission-finished")
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
    if (addInputs.size !== input.addTasks.length) throw new MissionControlError("Replacement task keys must be unique", "invalid-revision")
    for (const item of input.addTasks) {
      if (current.has(item.taskKey) || addKeys.has(item.taskKey)) throw new MissionControlError(`Task key already exists: ${item.taskKey}`, "task-conflict")
      addKeys.add(item.taskKey)
      if (!retired.has(item.replacesTaskKey) || retired.get(item.replacesTaskKey) !== item.taskKey) {
        throw new MissionControlError(`Replacement ${item.taskKey} must match a retired task`, "invalid-revision")
      }
      const taskInput: MissionDelegateInput = {
        taskKey: item.taskKey, title: item.title, brief: item.brief, role: item.role,
        blockedBy: item.blockedBy, delivery: "queue", execution: item.execution,
      }
      try {
        validateMissionDelegationPolicy({
          template: mission.template,
          role: item.role,
          targetSessionID: item.role === "resolver"
            ? mission.actors.find((actor) => actor.roles.includes("implementer"))?.sessionId
            : undefined,
          actors: mission.actors,
          tasks: mission.tasks.filter((task) => !retired.has(task.key)).map(({ role, status }) => ({ role, status }))
            .concat(addedTasks.map(({ role }) => ({ role, status: "ready" as const }))),
        })
        await this.options.validateExecution?.(taskInput, coordinatorID)
      } catch (error) {
        throw new MissionControlError(error instanceof Error ? error.message : "Replacement task contract is invalid", "invalid-role-policy")
      }
      addedTasks.push({
        id: `tsk_${stableToken(`${mission.id}\0${item.taskKey}`, 24)}`,
        key: item.taskKey, title: item.title, brief: item.brief, role: item.role,
        ...(item.execution === undefined ? {} : { execution: item.execution }),
        blockedBy: [...item.blockedBy], replacesTaskKey: item.replacesTaskKey,
      })
    }
    for (const [oldKey, replacementKey] of retired) {
      if (replacementKey !== undefined && !addKeys.has(replacementKey)) {
        throw new MissionControlError(`Replacement task does not exist: ${replacementKey}`, "invalid-revision")
      }
    }
    if ([...retired.values()].filter((value) => value !== undefined).length !== addKeys.size) {
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
    return addedTasks
  }

  private async deleteCurrent(input: MissionDeleteInput): Promise<{ deleted: true }> {
    const eventID = this.eventID(input.missionID, `deleted-${input.requestID}`)
    const previous = await this.journal.event(input.missionID, eventID)
    const snapshot = await this.snapshot()
    const mission = snapshot.missions.find((candidate) => candidate.id === input.missionID)
    if (previous) {
      if (previous.type !== "mission.deleted" || previous.expectedRevision !== input.expectedRevision) {
        throw new MissionControlError("Delete request ID was already used with a different request", "request-conflict")
      }
      return { deleted: true }
    }
    if (!mission) throw new MissionControlError("Mission not found", "mission-not-found")
    if (mission.revision !== input.expectedRevision) throw new MissionControlError("Mission changed; reload before deleting", "revision-conflict")
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION, id: eventID, type: "mission.deleted", missionID: mission.id,
      projectID: mission.projectID, requestID: input.requestID, expectedRevision: input.expectedRevision,
      createdAt: this.timestamp(snapshot),
    })
    await this.emitChanged(mission.id, await this.snapshot(), input.expectedRevision + 1)
    return { deleted: true }
  }

  inspect(sessionID: string, input: MissionInspectInput, operationID: string): Promise<MissionInspection> {
    if (!input.start) return this.inspectCurrent(sessionID, input, operationID)
    return this.mutate(() => this.inspectCurrent(sessionID, input, operationID))
  }

  private async inspectCurrent(sessionID: string, input: MissionInspectInput, operationID: string): Promise<MissionInspection> {
    const caller = await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    if (input.start) {
      const missionID = `msn_${stableToken(`${this.options.project.id}\0${sessionID}\0${operationID}`, 24)}`
      const replay = snapshot.missions.find((mission) => mission.id === missionID)
      if (replay) return this.inspection(replay, sessionID)
      const active = this.membership(snapshot, sessionID)
      if (active?.status === "active") throw new MissionControlError("This session already belongs to an active mission", "already-member")
      if (snapshot.missions.length >= MISSION_MAX_MISSIONS) {
        throw new MissionControlError("Project mission limit reached", "mission-limit")
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
    if (mission.status !== "active") throw new MissionControlError("The mission is already finished", "mission-finished")
    try {
      validateMissionDelegationPolicy({
        template: mission.template,
        role: input.role,
        targetSessionID: input.targetSessionID,
        actors: mission.actors,
        tasks: mission.tasks,
      })
    } catch (error) {
      throw new MissionControlError(error instanceof Error ? error.message : "Mission role policy failed", "invalid-role-policy")
    }

    let task = mission.tasks.find((candidate) => candidate.key === input.taskKey)
    if (!task) {
      if (input.targetSessionID) await this.ownedRootSession(input.targetSessionID)
      await this.options.validateExecution?.(input, sessionID)
      if (mission.tasks.length >= MISSION_MAX_TASKS) throw new MissionControlError("Mission task limit reached", "task-limit")
      if (input.blockedBy.includes(input.taskKey)) throw new MissionControlError("A task cannot block itself", "invalid-blocker")
      const existingTasks = mission.tasks
      const unknownBlocker = input.blockedBy.find((key) => !existingTasks.some((candidate) => candidate.key === key))
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
          blockedBy: input.blockedBy,
        },
        createdAt: this.timestamp(snapshot),
      })
      snapshot = await this.snapshot()
      mission = this.requireMission(snapshot, mission.id)
      task = mission.tasks.find((candidate) => candidate.key === input.taskKey)!
      await this.emitChanged(mission.id, snapshot)
    } else {
      const same = task.title === input.title && task.brief === input.brief && task.role === input.role
        && equalStrings(task.blockedBy, input.blockedBy)
        && sameExecution(task.execution, input.execution)
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
    const actor = await this.selectActor(snapshot, mission, sessionID, task.role, task.title, input.targetSessionID)
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

  private async reportCurrent(sessionID: string, input: MissionReportInput): Promise<{ disposition: "reported" | "finished" | "existing"; mission: MissionMap }> {
    await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")

    if (input.final) {
      this.assertCoordinator(mission, sessionID)
      if (mission.status !== "active") return { disposition: "existing", mission }
      if (input.outcome === "blocked") throw new MissionControlError("A final mission outcome must be completed or failed", "invalid-final-outcome")
      if (mission.tasks.some((task) => task.outstandingExecution)) {
        throw new MissionControlError("Withdrawn native work needs a terminal report before the mission can finish", "outstanding-execution")
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

    const task = this.reportTask(mission, sessionID, input.taskKey)
    const lateReport = task.lateReports?.at(-1)
    if (lateReport) {
      await this.notifyCoordinator(mission, lateReport)
      return { disposition: "existing", mission: this.requireMission(await this.snapshot(), mission.id) }
    }
    if (task.report) {
      await this.notifyCoordinator(mission, task.report)
      return { disposition: "existing", mission: this.requireMission(await this.snapshot(), mission.id) }
    }
    const late = task.status === "withdrawn"
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
      id: `rpt_${stableToken(`${mission.id}\0${task.key}`, 24)}`,
      taskKey: task.key,
      sessionId: sessionID,
      outcome: input.outcome,
      summary: input.summary,
      evidence: input.evidence,
      next: input.next,
      artifact,
      ...(late ? { late: true } : {}),
      createdAt: this.timestamp(snapshot),
    }
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: this.eventID(mission.id, `task-${task.key}-reported`),
      type: "task.reported",
      missionID: mission.id,
      projectID: mission.projectID,
      report,
      createdAt: report.createdAt,
    })
    snapshot = await this.snapshot()
    mission = this.requireMission(snapshot, mission.id)
    await this.emitChanged(mission.id, snapshot)
    await this.notifyCoordinator(mission, report)
    return { disposition: "reported", mission: this.requireMission(await this.snapshot(), mission.id) }
  }

  async contextFor(sessionID: string): Promise<string | undefined> {
    const snapshot = await this.snapshot()
    const mission = this.membership(snapshot, sessionID)
    if (!mission || mission.status !== "active") return undefined
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
    this.assertOwnedRoot(session)
    if (!matchesExecution(task.execution, session)) {
      throw new MissionControlError("Actor agent/model changed since dispatch; restore its selection before retrying", "execution-conflict")
    }
    const prompt = assignmentInput(mission, task)
    if (this.options.transport) await this.options.transport.prompt(mission.coordinatorSessionId, prompt)
    else await this.options.sessions.prompt(prompt)
    const snapshot = await this.snapshot()
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
    role: string,
    taskTitle: string,
    targetSessionID?: string,
  ): Promise<{ sessionID: string; title: string; location: MissionActor["location"]; managed: boolean }> {
    if (targetSessionID === coordinatorID) throw new MissionControlError("The coordinator cannot delegate a task to itself", "invalid-target")
    if (targetSessionID) {
      const target = await this.ownedRootSession(targetSessionID)
      if (mission.actors.length >= MISSION_MAX_ACTORS && !mission.actors.some((actor) => actor.sessionId === targetSessionID)) {
        throw new MissionControlError("Mission actor limit reached", "actor-limit")
      }
      const foreignMission = snapshot.missions.find((candidate) => candidate.status === "active"
        && candidate.id !== mission.id && candidate.actors.some((actor) => actor.sessionId === targetSessionID))
      if (foreignMission) throw new MissionControlError("Target session already belongs to another active mission", "target-claimed")
      return {
        sessionID: target.id,
        title: target.title ?? `${role}: ${taskTitle}`,
        location: target.location,
        managed: false,
      }
    }
    if (mission.actors.length >= MISSION_MAX_ACTORS) throw new MissionControlError("Mission actor limit reached", "actor-limit")
    return {
      sessionID: `ses_${stableToken(`${mission.id}\0${role}\0${taskTitle}\0${mission.tasks.length}`, 26)}`,
      title: `Mission · ${role}: ${taskTitle}`.slice(0, 160),
      location: (await this.ownedRootSession(coordinatorID)).location,
      managed: true,
    }
  }

  private async ensureActorSession(mission: MissionMap, actor: MissionActor, task: MissionMap["tasks"][number]): Promise<NativeMissionSession> {
    try {
      return await this.options.sessions.get({ sessionID: actor.sessionId })
    } catch (getError) {
      if (!actor.managed) throw new MissionControlError("Target session no longer exists", "target-missing")
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

  private async notifyCoordinator(mission: MissionMap, report: MissionReport): Promise<void> {
    const notification = reportInput(mission, report)
    const admissionID = notification.id
    if (this.options.transport) await this.options.transport.synthetic(mission.coordinatorSessionId, notification)
    else await this.options.sessions.synthetic(notification)
    const snapshot = await this.snapshot()
    await this.journal.append({
      version: MISSION_SCHEMA_VERSION,
      id: this.eventID(mission.id, `report-${report.id}-notified`),
      type: "report.notified",
      missionID: mission.id,
      projectID: mission.projectID,
      reportID: report.id,
      admissionID,
      createdAt: report.createdAt + 1,
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
    let session: NativeMissionSession
    try {
      session = await this.options.sessions.get({ sessionID })
    } catch {
      throw new MissionControlError("Session not found", "session-not-found")
    }
    this.assertOwnedRoot(session)
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
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameRevisionRequest(event: MissionRevisedEvent, input: MissionReviseInput): boolean {
  const added = event.addedTasks.map((task) => ({
    taskKey: task.key, title: task.title, brief: task.brief, role: task.role,
    ...(task.execution === undefined ? {} : { execution: task.execution }),
    blockedBy: task.blockedBy, replacesTaskKey: task.replacesTaskKey,
  }))
  return event.reason === input.reason && event.objective === input.objective
    && event.notesSpecified === (input.notes !== undefined) && event.notes === input.notes
    && JSON.stringify(event.retiredTasks) === JSON.stringify(input.retireTasks)
    && JSON.stringify(added) === JSON.stringify(input.addTasks)
    && JSON.stringify(event.dependencyUpdates) === JSON.stringify(input.dependencyUpdates)
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
