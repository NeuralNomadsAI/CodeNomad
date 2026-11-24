import type { MissionTemplateId } from "./model"
import type { MissionTaskMode } from "./task-execution-mode"

/** `GET /api/missions/playbooks`: each playbook (`recipes.ts`) with the complete texts its actors receive. */
export interface MissionPlaybookDetails {
  taskMode: MissionTaskMode
  /** Stand-ins for one mission's own data in `prompts`, by field. */
  placeholders: Record<"missionID" | "objective" | "notes" | "taskKey" | "taskTitle" | "taskBrief" | "blockedBy" | "taskStatus", string>
  playbooks: Array<{
    id: MissionTemplateId; title: string; summary: string; sequence: string[]; coordinator: string
    roles: Array<{ id: string; title: string; purpose: string; instructions: string; reportContract?: string }>
    prompts: {
      /** The coordinator's context on every turn: one-time missions, and daily runs. */
      coordinator: { once: string; daily: string }
      /** By role id: the assignment message and, with independent sessions, the context each turn of that session adds. */
      roles: Record<string, { assignment: string; session?: string }>
    }
  }>
}
