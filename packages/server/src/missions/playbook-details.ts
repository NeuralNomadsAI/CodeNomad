import type { MissionTemplateId } from "./model"
import type { MissionTaskMode } from "./task-execution-mode"

/** `GET /api/missions/playbooks`: the playbook texts Missions prompts are assembled from (`recipes.ts`). */
export interface MissionPlaybookDetails {
  taskMode: MissionTaskMode
  /** Each playbook as its coordinator and task actors receive it under this task mode. */
  playbooks: Array<{
    id: MissionTemplateId; title: string; summary: string; sequence: string[]; coordinator: string
    roles: Array<{ id: string; title: string; purpose: string; instructions: string; reportContract?: string }>
  }>
  /** Appended to every coordinator's playbook contract. */
  coordinator: string[]
  /** Appended for one-time missions only. */
  oneTimeCoordinator: string
  /** Appended to every task assignment after its role contract. */
  task: string[]
}
