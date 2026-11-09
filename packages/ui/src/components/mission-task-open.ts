import type { MissionPanelMap } from "../../../server/src/api-types"
import { missionProjectView, updateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { missionStore } from "../stores/missions"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { markMissionTasksSeen } from "../stores/mission-task-seen"

/** Opens the reader on the task `key` names, selecting it. A one-time mission's compact map that does not
 * hold it reads it by key first (`loadTasks`); the reader opens it only if its target is
 * still the one it had, and stays unchanged when the mission has no such task. */
export async function openMissionTask(instanceId: string, scope: string, mission: () => MissionPanelMap | undefined, key: string,
  recurrence?: MissionReaderTarget["recurrence"], store = missionStore): Promise<void> {
  const find = () => mission()?.tasks.find(task => task.key === key)
   const before = missionProjectView(scope), value = mission()
   const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
   const source = JSON.stringify(value?.panelPassage)
  if (!find() && value?.taskPage && (!recurrence || value.panelPassage)) await store.loadTasks(instanceId, value.id, { keys: [key] })
  const task = find(), owner = mission()
   if (!task || !owner || owner.id !== value?.id || owner.projectID !== value.projectID || missionProjectView(scope) !== before
     || JSON.stringify(owner.panelPassage) !== source || instances().get(instanceId)?.client !== client
     || getOpenCodeInstanceGeneration(instanceId) !== generation) return
   // The reader shows the selection: the task it opens becomes the panel's selection too.
   markMissionTasksSeen(JSON.stringify([scope, owner.projectID]), owner.id, [task])
  updateMissionProjectView(scope, { reader: { missionId: owner.id, kind: "task", itemId: task.id, recurrence },
     selectedTask: { missionId: owner.id, taskId: task.id }, ...(recurrence
       ? recurrence.owner === "scheduled" ? { selectedScheduled: recurrence.scheduleID, selectedRecurrence: undefined, selected: undefined }
         : { selectedRecurrence: recurrence.scheduleID, selectedScheduled: undefined, selected: undefined }
       : { selected: owner.id, selectedScheduled: undefined, selectedRecurrence: undefined }) })
}
