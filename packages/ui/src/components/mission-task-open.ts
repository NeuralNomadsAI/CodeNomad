import type { MissionPanelMap } from "../../../server/src/api-types"
import { navigateMissionProjectView, type MissionReaderTarget } from "../stores/mission-view-state"
import { missionStore } from "../stores/missions"
import { captureBackendOperation } from "../lib/backend-operation"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { markMissionTasksSeen } from "../stores/mission-task-seen"
import { beginGesture } from "../stores/session-surface"

/** Read a missing task by key, then select it under the original gesture and source. */
export async function openMissionTask(instanceId: string, scope: string, mission: () => MissionPanelMap | undefined, key: string,
  recurrence?: MissionReaderTarget["recurrence"], store = missionStore): Promise<void> {
  const operation = captureBackendOperation(instanceId)
  if (!operation.current()) return
  const intent = beginGesture({ instanceId, sessionId: null })
  const find = () => mission()?.tasks.find(task => task.key === key)
  const value = mission()
  const client = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
  const source = JSON.stringify(value?.panelPassage)
  if (!find() && value?.taskPage && (!recurrence || value.panelPassage)) await store.loadTasks(instanceId, value.id, { keys: [key] })
  const task = find(), owner = mission()
  if (!operation.current() || !intent.current() || !task || !owner || owner.id !== value?.id || owner.projectID !== value.projectID
    || JSON.stringify(owner.panelPassage) !== source || instances().get(instanceId)?.client !== client
    || getOpenCodeInstanceGeneration(instanceId) !== generation) return
  // The reader shows the selection: the task it opens becomes the panel's selection too.
  markMissionTasksSeen(JSON.stringify([scope, owner.projectID]), owner.id, [task])
  navigateMissionProjectView(instanceId, { reader: { missionId: owner.id, kind: "task", itemId: task.id, recurrence },
    selectedTask: { missionId: owner.id, taskId: task.id }, ...(recurrence
      ? { selectedScheduled: recurrence.scheduleID, selected: undefined } : { selected: owner.id, selectedScheduled: undefined }) }, intent)
}
