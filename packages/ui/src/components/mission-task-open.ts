import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { missionStore } from "../stores/missions"

/** Opens the reader on the task `key` names. A one-time mission's compact map that does not
 * hold it reads it by key first (`loadTasks`); the reader opens it only if its target is
 * still the one it had, and stays unchanged when the mission has no such task. */
export async function openMissionTask(instanceId: string, scope: string, mission: () => MissionPanelMap | undefined, key: string,
  recurrence?: MissionReaderTarget["recurrence"]): Promise<void> {
  const find = () => mission()?.tasks.find(task => task.key === key)
  const before = JSON.stringify(missionProjectView(scope).reader ?? null), value = mission()
  if (!find() && value?.taskPage && !recurrence) await missionStore.loadTasks(instanceId, value.id, { keys: [key] })
  const task = find(), owner = mission()
  if (!task || !owner || JSON.stringify(missionProjectView(scope).reader ?? null) !== before) return
  updateMissionProjectView(scope, { reader: { missionId: owner.id, kind: "task", itemId: task.id, recurrence } })
}
