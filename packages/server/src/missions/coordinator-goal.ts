import { z } from "zod"
import { runMissionExclusive } from "./exclusive"
import type { MissionJsonValue, MissionMap } from "./model"

/** Exact pause reason emitted by OpenCode's built-in `/goal` plugin after a daemon restart. */
export const COORDINATOR_GOAL_RESTART_REASON = "The server restarted while the goal was active"
export const COORDINATOR_GOAL_MAX_RESTART_RESUMES = 3
export const COORDINATOR_GOAL_OBJECTIVE_MAX = 480
export const COORDINATOR_GOAL_STORAGE_PREFIX = "codenomad-missions/coordinator-goal-v1"
/** Window during which a queued `/goal` arming command waits for `rpc.opencode.goal.changed`. */
export const COORDINATOR_GOAL_ARMING_GRACE_MS = 60_000

const GOAL_CONTROL_WORDS = new Set(["pause", "resume", "clear", "status", "stop", "cancel", "help"])

export interface LiveCoordinatorGoal {
  id: string
  objective: string
  status: "active" | "paused" | "complete"
  reason?: string
  rounds: number
  maxRounds: number
  stalls?: number
  boot?: string
  updatedAt: number
}

export const liveCoordinatorGoalSchema = z.object({
  id: z.string().min(1).max(256),
  objective: z.string().max(64 * 1024),
  status: z.enum(["active", "paused", "complete"]),
  reason: z.string().max(16 * 1024).optional(),
  rounds: z.number().int().nonnegative(),
  maxRounds: z.number().int().nonnegative(),
  stalls: z.number().int().nonnegative().optional(),
  boot: z.string().min(1).max(256).optional(),
  updatedAt: z.number(),
})

export type CoordinatorGoalAction = "armed" | "arming" | "resumed-restart" | "resumed-mission" | "paused-mission" | "cleared"

export interface CoordinatorGoalRecord {
  version: 1
  missionID: string
  sessionID: string
  goalID?: string
  /** Set while a queued `/goal` arm command has been sent and its ID has not yet been observed. */
  armingAt?: number
  armingObjective?: string
  restartResumes: number
  lastResumedBoot?: string
  lastResumedPausedAt?: number
  pausedByMissionAt?: number
  lastAction?: CoordinatorGoalAction
  updatedAt: number
}

const coordinatorGoalRecordSchema = z.object({
  version: z.literal(1),
  missionID: z.string().min(1).max(128),
  sessionID: z.string().min(1).max(256),
  goalID: z.string().min(1).max(256).optional(),
  armingAt: z.number().int().nonnegative().optional(),
  armingObjective: z.string().min(1).max(COORDINATOR_GOAL_OBJECTIVE_MAX + 64).optional(),
  restartResumes: z.number().int().nonnegative().max(100),
  lastResumedBoot: z.string().min(1).max(256).optional(),
  lastResumedPausedAt: z.number().optional(),
  pausedByMissionAt: z.number().int().nonnegative().optional(),
  lastAction: z.enum(["armed", "arming", "resumed-restart", "resumed-mission", "paused-mission", "cleared"]).optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

export function coordinatorGoalRecordPrefix(projectToken: string): string {
  return `${COORDINATOR_GOAL_STORAGE_PREFIX}/${projectToken}/`
}

export function coordinatorGoalRecordKey(projectToken: string, missionID: string): string {
  return `${coordinatorGoalRecordPrefix(projectToken)}${missionID}`
}

export function parseCoordinatorGoalRecord(value: unknown, expectedMissionID?: string, expectedSessionID?: string): CoordinatorGoalRecord | undefined {
  const parsed = coordinatorGoalRecordSchema.safeParse(value)
  if (!parsed.success) return undefined
  if (expectedMissionID && parsed.data.missionID !== expectedMissionID) return undefined
  if (expectedSessionID && parsed.data.sessionID !== expectedSessionID) return undefined
  return parsed.data
}

/** Short, deterministic `/goal` objective derived from a Mission: bounded length, no outer
 * quotes or control words, and an explicit finalization cue for OpenCode's goal reviewer. */
export function coordinatorGoalObjective(mission: Pick<MissionMap, "title" | "objective">): string {
  const clean = (raw: string) => raw
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
  const suffix = "Finish the mission plan and call mission.report with final=true."
  const title = mission.title ? clean(mission.title) : ""
  const objective = clean(mission.objective)
  const rawBody = title && !objective.toLowerCase().startsWith(title.toLowerCase())
    ? `${title}: ${objective}`
    : (objective || title || "Complete the mission")
  const maxBody = COORDINATOR_GOAL_OBJECTIVE_MAX - suffix.length - 12
  let body = rawBody.length > maxBody ? `${rawBody.slice(0, Math.max(1, maxBody - 1)).trimEnd()}…` : rawBody
  if (GOAL_CONTROL_WORDS.has(body.toLowerCase())) body = `Mission: ${body}`
  return `Mission: ${body} — ${suffix}`.slice(0, COORDINATOR_GOAL_OBJECTIVE_MAX)
}

export type CoordinatorGoalDecision =
  | { kind: "noop"; reason: string }
  | { kind: "adopt-armed"; goalID: string }
  | { kind: "clear-mission-pause" }
  | { kind: "arm"; objective: string }
  | { kind: "pause"; goalID: string }
  | { kind: "resume-mission-pause"; goalID: string }
  | { kind: "resume-restart"; goalID: string; deadBoot?: string; pausedAt: number }
  | { kind: "clear"; goalID: string }
  /** The Mission is over and nothing is left to clear: its runtime record goes. */
  | { kind: "forget" }

/** Pure reconciliation decision for a Mission's coordinator `/goal`. Never touches foreign
 * goals, never re-arms a goal the user cleared while the Mission runs, and never auto-resumes
 * human/stall/maxRounds pauses. A Mission that ends drops its record, so a recovered one arms again. */
export function reconcileCoordinatorGoalDecision(
  mission: Pick<MissionMap, "id" | "title" | "objective" | "status" | "runState" | "control" | "coordinatorGoal" | "coordinatorSessionId">,
  record: CoordinatorGoalRecord | undefined,
  liveGoal: LiveCoordinatorGoal | null,
  now = Date.now(),
): CoordinatorGoalDecision {
  if (!mission.coordinatorGoal) return { kind: "noop", reason: "disabled" }
  if (mission.control?.pending?.length) return { kind: "noop", reason: "control-pending" }

  const ownedRecord = record && record.sessionID === mission.coordinatorSessionId ? record : undefined
  const ownedGoalID = ownedRecord?.goalID

  // Adopt a queued `/goal` arm once OpenCode materializes it with the matching objective.
  if (!ownedGoalID && ownedRecord?.armingAt !== undefined && liveGoal !== null && liveGoal.objective === ownedRecord.armingObjective) {
    return { kind: "adopt-armed", goalID: liveGoal.id }
  }

  const runState = mission.runState ?? "running"
  const terminal = mission.status !== "active" || runState === "stopped"
  if (terminal) {
    if (liveGoal !== null && ownedGoalID !== undefined && liveGoal.id === ownedGoalID && liveGoal.status !== "complete") {
      return { kind: "clear", goalID: liveGoal.id }
    }
    // A queued arm may still materialise after the Mission ended: keep its record until it is adopted and cleared.
    if (ownedRecord && (ownedRecord.armingAt === undefined || now - ownedRecord.armingAt >= COORDINATOR_GOAL_ARMING_GRACE_MS)) return { kind: "forget" }
    return { kind: "noop", reason: "terminal" }
  }

  // Foreign goal guard: never modify a `/goal` that this mission does not own.
  if (liveGoal !== null && ownedGoalID !== undefined && liveGoal.id !== ownedGoalID) {
    return { kind: "noop", reason: "foreign-goal" }
  }

  if (runState === "prepared") {
    return { kind: "noop", reason: "prepared" }
  }

  if (runState === "paused") {
    if (liveGoal !== null && ownedGoalID !== undefined && liveGoal.id === ownedGoalID && liveGoal.status === "active") {
      return { kind: "pause", goalID: liveGoal.id }
    }
    return { kind: "noop", reason: "mission-paused" }
  }

  // Active & running mission.
  if (!ownedGoalID) {
    if (liveGoal !== null) return { kind: "noop", reason: "foreign-goal" }
    if (ownedRecord?.lastAction === "cleared") return { kind: "noop", reason: "already-cleared" }
    if (ownedRecord?.armingAt !== undefined && now - ownedRecord.armingAt < COORDINATOR_GOAL_ARMING_GRACE_MS) {
      return { kind: "noop", reason: "arming-in-flight" }
    }
    return { kind: "arm", objective: coordinatorGoalObjective(mission) }
  }

  // Already armed previously.
  if (liveGoal === null) {
    // User cleared the goal manually: respect that choice and never re-arm.
    return { kind: "noop", reason: "user-cleared" }
  }

  if (liveGoal.status === "active" || liveGoal.status === "complete") {
    if (ownedRecord?.pausedByMissionAt !== undefined) return { kind: "clear-mission-pause" }
    return { kind: "noop", reason: liveGoal.status }
  }

  // liveGoal.status === "paused"
  if (ownedRecord?.pausedByMissionAt !== undefined) {
    return { kind: "resume-mission-pause", goalID: liveGoal.id }
  }

  if (liveGoal.reason === COORDINATOR_GOAL_RESTART_REASON) {
    if ((ownedRecord?.restartResumes ?? 0) >= COORDINATOR_GOAL_MAX_RESTART_RESUMES) {
      return { kind: "noop", reason: "restart-limit-reached" }
    }
    if (liveGoal.boot !== undefined && ownedRecord?.lastResumedBoot === liveGoal.boot) {
      return { kind: "noop", reason: "already-resumed-boot" }
    }
    if (ownedRecord?.lastResumedPausedAt === liveGoal.updatedAt) {
      return { kind: "noop", reason: "already-resumed-pause" }
    }
    return { kind: "resume-restart", goalID: liveGoal.id, deadBoot: liveGoal.boot, pausedAt: liveGoal.updatedAt }
  }

  return { kind: "noop", reason: "non-resumable-pause" }
}

export interface CoordinatorGoalReconcileAdapter {
  projectToken: string
  readRecord(key: string): Promise<MissionJsonValue | undefined>
  writeRecord(key: string, value: MissionJsonValue): Promise<void>
  removeRecord?(key: string): Promise<void>
  /** Returns the live goal, `null` when confirmed absent, or `"unavailable"` when the RPC cannot be read. */
  readGoal(sessionID: string): Promise<LiveCoordinatorGoal | null | "unavailable">
  runGoalCommand(sessionID: string, text: string, delivery: "queue" | "steer"): Promise<void>
  now?: () => number
}

export interface CoordinatorGoalReconcileResult {
  decision: CoordinatorGoalDecision
  record?: CoordinatorGoalRecord
}

/** Execute one serialized, idempotent reconcile pass for a mission. Durable dedupe state is
 * written BEFORE calling `/goal` so crashes or restarts never cause duplicate arm/resume loops. */
export async function reconcileCoordinatorGoal(
  mission: Pick<MissionMap, "id" | "title" | "objective" | "status" | "runState" | "control" | "coordinatorGoal" | "coordinatorSessionId">,
  adapter: CoordinatorGoalReconcileAdapter,
): Promise<CoordinatorGoalReconcileResult> {
  if (!mission.coordinatorGoal) return { decision: { kind: "noop", reason: "disabled" } }
  const key = coordinatorGoalRecordKey(adapter.projectToken, mission.id)
  return runMissionExclusive(`coordinator-goal:${adapter.projectToken}:${mission.id}`, async () => {
    const now = adapter.now?.() ?? Date.now()
    const raw = await adapter.readRecord(key)
    let record = parseCoordinatorGoalRecord(raw, mission.id, mission.coordinatorSessionId)
    const liveGoal = await adapter.readGoal(mission.coordinatorSessionId)
    if (liveGoal === "unavailable") return { decision: { kind: "noop", reason: "goal-rpc-unavailable" }, record }
    let decision = reconcileCoordinatorGoalDecision(mission, record, liveGoal, now)

    const save = async (next: CoordinatorGoalRecord): Promise<CoordinatorGoalRecord> => {
      await adapter.writeRecord(key, JSON.parse(JSON.stringify(next)) as MissionJsonValue)
      return next
    }
    const fresh: CoordinatorGoalRecord = { version: 1, missionID: mission.id, sessionID: mission.coordinatorSessionId, restartResumes: 0, updatedAt: now }

    if (decision.kind === "adopt-armed") {
      record = await save({ ...(record ?? fresh), goalID: decision.goalID, armingAt: undefined, armingObjective: undefined, lastAction: "armed", updatedAt: now })
      // The Mission may have paused or ended while its arm was queued: act on the adopted goal in this pass.
      const next = reconcileCoordinatorGoalDecision(mission, record, liveGoal, now)
      if (next.kind === "noop") return { decision, record }
      decision = next
    }
    const base = record ?? fresh

    switch (decision.kind) {
      case "noop":
      case "adopt-armed":
        return { decision, record }

      case "forget":
        await adapter.removeRecord?.(key)
        return { decision }

      case "clear-mission-pause": {
        const next = await save({
          ...base,
          pausedByMissionAt: undefined,
          updatedAt: now,
        })
        return { decision, record: next }
      }

      case "arm": {
        // Persist arming intent BEFORE sending `/goal` to prevent double-arming on concurrent runs.
        let saved = await save({
          ...base,
          armingAt: now,
          armingObjective: decision.objective,
          lastAction: "arming",
          updatedAt: now,
        })
        await adapter.runGoalCommand(mission.coordinatorSessionId, decision.objective, "queue")
        const after = await adapter.readGoal(mission.coordinatorSessionId).catch(() => "unavailable" as const)
        if (after && after !== "unavailable" && after.objective === decision.objective) {
          saved = await save({
            ...saved,
            goalID: after.id,
            armingAt: undefined,
            armingObjective: undefined,
            lastAction: "armed",
            updatedAt: adapter.now?.() ?? Date.now(),
          })
        }
        return { decision, record: saved }
      }

      case "pause": {
        const saved = await save({
          ...base,
          goalID: decision.goalID,
          pausedByMissionAt: now,
          lastAction: "paused-mission",
          updatedAt: now,
        })
        await adapter.runGoalCommand(mission.coordinatorSessionId, "pause", "steer")
        return { decision, record: saved }
      }

      case "resume-mission-pause": {
        // The pause mark outlives a failed command, so the next pass resumes again; resuming an active goal is harmless.
        await adapter.runGoalCommand(mission.coordinatorSessionId, "resume", "steer")
        const saved = await save({
          ...base,
          goalID: decision.goalID,
          pausedByMissionAt: undefined,
          lastAction: "resumed-mission",
          updatedAt: now,
        })
        return { decision, record: saved }
      }

      case "resume-restart": {
        // Persist incremented counter + dead boot BEFORE calling `/goal resume` (at-most-once per restart).
        const saved = await save({
          ...base,
          goalID: decision.goalID,
          restartResumes: base.restartResumes + 1,
          ...(decision.deadBoot === undefined ? {} : { lastResumedBoot: decision.deadBoot }),
          lastResumedPausedAt: decision.pausedAt,
          pausedByMissionAt: undefined,
          lastAction: "resumed-restart",
          updatedAt: now,
        })
        await adapter.runGoalCommand(mission.coordinatorSessionId, "resume", "steer")
        return { decision, record: saved }
      }

      case "clear": {
        const saved = await save({
          ...base,
          goalID: decision.goalID,
          pausedByMissionAt: undefined,
          armingAt: undefined,
          armingObjective: undefined,
          lastAction: "cleared",
          updatedAt: now,
        })
        await adapter.runGoalCommand(mission.coordinatorSessionId, "clear", "steer")
        const after = await adapter.readGoal(mission.coordinatorSessionId).catch(() => "unavailable" as const)
        if (after === null || (after !== "unavailable" && after.id !== decision.goalID)) {
          await adapter.removeRecord?.(key)
          return { decision }
        }
        return { decision, record: saved }
      }
    }
  })
}
