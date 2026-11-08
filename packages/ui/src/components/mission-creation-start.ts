import { createRoot, getOwner, onCleanup, runWithOwner } from "solid-js"
import type { MissionPanelMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
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
    const view = props.captureView(), client = instances().get(props.instanceId)?.client
    const generation = getOpenCodeInstanceGeneration(props.instanceId)
    const current = () => alive && requested && view() && props.active()
      && instances().get(props.instanceId)?.client === client && getOpenCodeInstanceGeneration(props.instanceId) === generation
    let consumed = false
    return async (created: MissionPanelMap | UnifiedMissionSchedule) => {
      if (consumed) return
      consumed = true
      if (!current()) return
      try {
        if ("configuration" in created) {
          if (created.kind !== "schedule" || created.state !== "paused" || created.firstPlayedAt !== null) return
          let dispose = () => {}
          try {
            const controls = runWithOwner(owner, () => createRoot(cleanup => {
              dispose = cleanup
              return createMissionScheduleControls({ ...props, document: () => created, active: current,
                enabled: () => true, refreshVersion: () => 0, onDeleted: () => {}, captureOperation: () => current })
            }))!
            await controls.startCreated()
          } finally { dispose() }
        } else {
          const instance = instances().get(props.instanceId)
          const location = { directory: instance?.folder, proxyPath: instance?.proxyPath,
            projectID: instance?.metadata?.project?.id, snapshotProjectID: missionStore.state(props.instanceId).projectID }
          const source = missionLifecycleSource(props.instanceId, created, location)
          if (created.status !== "active" || created.runState !== "prepared" || created.control?.pending.length
            || created.panelControl?.pending || missionLifecycleIntents.retry(source) || missionLifecycleIntents.busy(source)) return
          const intent = missionLifecycleIntents.reserve(source, created.id,
            { action: "start", requestId: crypto.randomUUID(), expectedRevision: created.revision })
          if (!intent || !missionLifecycleIntents.start(intent)) return
          let outcome: "acknowledged" | "rejected" | "unknown" = "unknown"
          try {
            const result = await serverApi.controlMission(props.instanceId, created.id, intent.input)
            const mission = result?.mission, control = mission?.control
            if (mission && missionLifecycleSource(props.instanceId, mission, location) === source
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
