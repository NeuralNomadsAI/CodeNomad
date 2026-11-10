import { createRoot, getOwner, onCleanup, runWithOwner } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { backendOf } from "../lib/backend-client"
import { captureBackendOperation } from "../lib/backend-operation"
import { isRejectedLifecycleIntent } from "../lib/mission-lifecycle-request"
import { instances } from "../stores/instances"
import { missionStore } from "../stores/missions"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import type { UnifiedMissionSchedule } from "../stores/mission-schedules"
import { createMissionScheduleControls } from "./mission-schedule-controls"

/** Capture before creating; call the returned continuation only for a direct,
 * positive creation ACK. Unknown/recovered creations never invoke it. */
export function createMissionCreationStart(props: { instanceId: string; projectID?: string; directory: string;
  active: () => boolean; captureView: () => (() => boolean); refresh: () => void }) {
  const owner = getOwner()
  let alive = true
  onCleanup(() => { alive = false })
  return (requested: boolean) => {
    // Use the selected controls' exact project/directory key for every retained receipt.
    const instanceId = props.instanceId, projectID = props.projectID, directory = props.directory
    const view = props.captureView(), client = instances().get(instanceId)?.client
    const operation = captureBackendOperation(instanceId)
    const generation = getOpenCodeInstanceGeneration(instanceId)
    const current = () => operation.current() && alive && requested && view() && props.active()
      && props.instanceId === instanceId && props.projectID === projectID && props.directory === directory
      && instances().get(instanceId)?.client === client && getOpenCodeInstanceGeneration(instanceId) === generation
    let consumed = false
    return async (created: MissionPanelMap | UnifiedMissionSchedule) => {
      if (consumed) return
      consumed = true
      if (!current()) return
      try {
        if ("configuration" in created) {
          if (!projectID || created.kind !== "schedule" || created.state !== "paused" || created.firstPlayedAt !== null) return
          let dispose = () => {}
          try {
            const controls = runWithOwner(owner, () => createRoot(cleanup => {
              dispose = cleanup
              return createMissionScheduleControls({ instanceId, projectID, directory, document: () => created, active: current,
                enabled: () => true, refreshVersion: () => 0, refresh: props.refresh, onDeleted: () => {}, captureOperation: () => current })
            }))!
            await controls.startCreated()
          } finally { dispose() }
        } else {
          const instance = instances().get(instanceId)
          const location = { directory: instance?.folder, proxyPath: instance?.proxyPath,
            projectID: instance?.metadata?.project?.id, snapshotProjectID: missionStore.state(instanceId).projectID }
          const source = missionLifecycleSource(instanceId, created, location)
          if (created.status !== "active" || created.runState !== "prepared" || created.control?.pending.length
            || created.panelControl?.pending || missionLifecycleIntents.retry(source) || missionLifecycleIntents.busy(source)) return
          const intent = missionLifecycleIntents.reserve(source, created.id,
            { action: "start", requestId: crypto.randomUUID(), expectedRevision: created.revision })
          if (!intent || !missionLifecycleIntents.start(intent)) return
          let outcome: "acknowledged" | "rejected" | "unknown" = "unknown"
          try {
            const result = await backendOf(instanceId).api.controlMission(instanceId, created.id, intent.input)
            const mission = result?.mission, control = mission?.control
            if (mission && missionLifecycleSource(instanceId, mission, location) === source
              && control?.requestID === intent.input.requestId && control.action === "start"
              && control.expectedRevision === intent.input.expectedRevision && control.pending.length === 0) outcome = "acknowledged"
          } catch (error) {
            if (isRejectedLifecycleIntent(error)) outcome = "rejected"
          } finally { missionLifecycleIntents.finish(intent, outcome) }
        }
      } catch { /* Unsent failures leave the created object available for explicit Play. */ }
      finally { if (current()) props.refresh() }
    }
  }
}
