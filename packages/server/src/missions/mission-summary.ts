// Shared with the UI, which derives rows from the maps of a list without summaries: keep it free of Node modules.
import type { MissionMap } from "./model"
import { isFullMissionMap, type MissionPanelMap } from "./mission-panel-map"
import { MISSION_TITLE_MAX } from "./mission-title"

/** Missions a `list` read returns as full maps besides the open ones (the panel's selection and reader). */
export const MISSION_LIST_MAX_INCLUDE = 4
/** Code points kept of a summary's objective. A row title (`missionDisplayTitle`,
 * at most 500 points) reads the first sentence and whether it exceeds 500 points;
 * one more point keeps a cut right after punctuation from posing as its end. */
export const MISSION_SUMMARY_OBJECTIVE = 502

/** A panel row: what the picker shows and marks for a mission it holds no full map of. */
export interface MissionSummary {
  id: string
  title?: string
  /** Display label: whitespace runs collapsed (a newline kept), at most `MISSION_SUMMARY_OBJECTIVE` code points. */
  objective: string
  status: MissionMap["status"]
  runState?: MissionMap["runState"]
  coordinatorSessionId: string
  /** Declared actors: the native requests a row counts. */
  actorSessionIds: string[]
  updatedAt: number
  /** The map's `finishSequence`: the project-wide order of its finish. */
  finishSequence?: number
  revision: number
}

/** An objective's display label: whitespace runs collapsed (a newline kept), at most `MISSION_SUMMARY_OBJECTIVE` code points. */
export function missionObjectiveLabel(objective: string): string {
  return Array.from(objective.trim().replace(/\s+/g, run => run.includes("\n") ? "\n" : " ")).slice(0, MISSION_SUMMARY_OBJECTIVE).join("")
}

/** The objective label of either shape: a compact map's excerpt, or a full map's own. */
export function missionPanelObjective(map: MissionPanelMap): string {
  return isFullMissionMap(map) ? missionObjectiveLabel(map.objective) : map.excerpt ?? ""
}

export function missionSummary(mission: MissionMap | MissionPanelMap): MissionSummary {
  return {
    id: mission.id, ...(mission.title === undefined ? {} : { title: mission.title }),
    objective: missionPanelObjective(mission),
    status: mission.status, ...(mission.runState === undefined ? {} : { runState: mission.runState }),
    coordinatorSessionId: mission.coordinatorSessionId, actorSessionIds: mission.actors.map(actor => actor.sessionId), updatedAt: mission.updatedAt,
    ...(mission.finishSequence === undefined ? {} : { finishSequence: mission.finishSequence }), revision: mission.revision,
  }
}

export const missionSummarySchema = {
  type: "object", properties: {
    id: { type: "string" }, title: { type: "string", minLength: 1, maxLength: MISSION_TITLE_MAX },
    objective: { type: "string", maxLength: 2 * MISSION_SUMMARY_OBJECTIVE },
    status: { type: "string", enum: ["active", "completed", "failed", "stopped"] },
    runState: { type: "string", enum: ["prepared", "running", "paused", "stopped"] },
    coordinatorSessionId: { type: "string" }, actorSessionIds: { type: "array", items: { type: "string" } },
    updatedAt: { type: "number" }, finishSequence: { type: "integer", minimum: 1 }, revision: { type: "number" },
  }, required: ["id", "objective", "status", "coordinatorSessionId", "actorSessionIds", "updatedAt", "revision"], additionalProperties: false,
} as const
