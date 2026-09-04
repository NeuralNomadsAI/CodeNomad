import path from "node:path"
import type { JsonValue, SessionMetadata } from "@opencode-ai/client"

import { MissionJournal, stableToken, type MissionStorage } from "./journal"
import {
  MISSION_MAX_ACTORS,
  MISSION_MAX_TASKS,
  MISSION_SCHEMA_VERSION,
  type MissionActor,
  type MissionEvent,
  type MissionMap,
  type MissionReport,
  type MissionSnapshot,
} from "./model"
import { buildActorContext, buildAssignmentPrompt, getMissionRecipe, missionRecipeCatalog } from "./recipes"
import { validateMissionDelegationPolicy, validateMissionReportArtifact } from "./contracts"
import type {
  MissionDelegateInput,
  MissionInspectInput,
  MissionInspection,
  MissionProject,
  MissionReportInput,
  MissionSessionAdapter,
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
  }) {
    this.journal = new MissionJournal(options.storage, options.project.id, options.project.canonical, options.now)
  }

  snapshot(): Promise<MissionSnapshot> {
    return this.journal.snapshot()
  }

  async inspect(sessionID: string, input: MissionInspectInput, operationID: string): Promise<MissionInspection> {
    const caller = await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    if (input.start) {
      const missionID = `msn_${stableToken(`${this.options.project.id}\0${sessionID}\0${operationID}`, 24)}`
      const replay = snapshot.missions.find((mission) => mission.id === missionID)
      if (replay) return this.inspection(replay, sessionID)
      const active = this.membership(snapshot, sessionID)
      if (active?.status === "active") throw new MissionControlError("This session already belongs to an active mission", "already-member")
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

  async delegate(sessionID: string, input: MissionDelegateInput): Promise<{ disposition: "blocked" | "dispatched" | "existing"; mission: MissionMap }> {
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
      })
    } catch (error) {
      throw new MissionControlError(error instanceof Error ? error.message : "Mission role policy failed", "invalid-role-policy")
    }

    let task = mission.tasks.find((candidate) => candidate.key === input.taskKey)
    if (!task) {
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
      if (!same) throw new MissionControlError("Task key already exists with a different contract", "task-conflict")
    }

    if (task.report || task.status === "queued") return { disposition: "existing", mission }
    if (task.status === "blocked") return { disposition: "blocked", mission }
    if (task.status === "dispatching") {
      mission = await this.finishDispatch(mission, task.key)
      return { disposition: "dispatched", mission }
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

  async report(sessionID: string, input: MissionReportInput): Promise<{ disposition: "reported" | "finished" | "existing"; mission: MissionMap }> {
    await this.ownedRootSession(sessionID)
    let snapshot = await this.snapshot()
    let mission = this.selectMission(snapshot, sessionID, input.missionID)
    if (!mission) throw new MissionControlError("No mission is associated with this session", "mission-not-found")

    if (input.final) {
      this.assertCoordinator(mission, sessionID)
      if (mission.status !== "active") return { disposition: "existing", mission }
      if (input.outcome === "blocked") throw new MissionControlError("A final mission outcome must be completed or failed", "invalid-final-outcome")
      if (input.outcome === "completed" && mission.tasks.some((task) => task.status !== "completed")) {
        throw new MissionControlError("Every mission task must be complete before a green finish", "open-tasks")
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
    if (task.report) {
      await this.notifyCoordinator(mission, task.report)
      return { disposition: "existing", mission: this.requireMission(await this.snapshot(), mission.id) }
    }
    if (task.status !== "queued" && task.status !== "dispatching") {
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
    const session = await this.ensureActorSession(mission, actor, task.role, task.title)
    this.assertOwnedRoot(session)
    await this.options.sessions.prompt({
      sessionID: session.id,
      id: task.admissionId,
      text: buildAssignmentPrompt(mission, task),
      metadata: this.metadata(mission.id, "assignment", { taskKey: task.key, role: task.role }),
      delivery: task.delivery,
      resume: true,
    })
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

  private async ensureActorSession(mission: MissionMap, actor: MissionActor, role: string, taskTitle: string): Promise<NativeMissionSession> {
    try {
      return await this.options.sessions.get({ sessionID: actor.sessionId })
    } catch (getError) {
      if (!actor.managed) throw new MissionControlError("Target session no longer exists", "target-missing")
      try {
        return await this.options.sessions.create({
          id: actor.sessionId,
          title: actor.title || `Mission · ${role}: ${taskTitle}`,
          location: actor.location,
          metadata: this.metadata(mission.id, "actor", { role }),
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
    const admissionID = this.messageID(`report\0${report.id}`)
    await this.options.sessions.synthetic({
      sessionID: mission.coordinatorSessionId,
      id: admissionID,
      text: `Mission report received for “${report.taskKey}” from ${report.sessionId}. Outcome: ${report.outcome}.\n\n${report.summary}`,
      description: "CodeNomad mission report",
      metadata: this.metadata(mission.id, "report", {
        taskKey: report.taskKey,
        reportID: report.id,
        fromSessionID: report.sessionId,
      }),
      delivery: "queue",
      resume: true,
    })
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

  private async emitChanged(missionID: string, snapshot: MissionSnapshot): Promise<void> {
    const revision = snapshot.missions.find((mission) => mission.id === missionID)?.revision ?? 0
    await this.options.changed?.(missionID, revision).catch(() => undefined)
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
