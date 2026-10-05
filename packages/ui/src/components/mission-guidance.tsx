import { ArrowUpRight, MessageSquare } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { serverApi } from "../lib/api-client"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { hydrateRestoredSessionChain } from "../stores/sessions"
import { sendMessage } from "../stores/session-actions"
import { missionGuidanceDraft, setMissionGuidanceDraft } from "../stores/mission-guidance"
import { MissionDisclosure } from "./mission-disclosure"

/** Normal user prompt to the coordinator, never a plan edit, synthetic report,
 * assignment replay or automatic resume of a paused Mission. */
export function MissionGuidance(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled?: boolean
  onOpenActor: (id: string) => Promise<void>
}) {
  const { t } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id,
    props.mission.projectID, props.mission.id, props.mission.coordinatorSessionId])
  const draft = () => missionGuidanceDraft(identity())
  const running = (mission: MissionMap) => mission.status === "active" && (!mission.runState || mission.runState === "running")
  const busy = () => ["preparing", "sending"].includes(draft().state)
  const capture = createMissionViewFence(identity, () => props.active && !props.disabled)
  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || draft().state === "uncertain" || props.disabled || !running(props.mission) || !draft().text.trim()) return
    const key = identity(), original = draft(), text = original.text.trim()
    const instanceId = props.instanceId, missionId = props.mission.id, coordinator = props.mission.coordinatorSessionId
    const owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const viewCurrent = capture()
    const current = () => viewCurrent() && !props.disabled && running(props.mission)
      && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    let attempted = false
    setMissionGuidanceDraft(key, { text: original.text, state: "preparing" })
    try {
      // Display status is not prompt admission. Refresh the Mission and hydrate
      // only its exact root, without selecting it or altering any composer draft.
      const snapshot = await serverApi.fetchMissions(instanceId)
      const mission = snapshot.missions.find(value => value.id === missionId)
      if (!current() || !snapshot.available || !mission || !running(mission)
        || mission.coordinatorSessionId !== coordinator || mission.projectID !== props.mission.projectID) throw new Error("Mission changed")
      await hydrateRestoredSessionChain(instanceId, [coordinator], undefined, current)
      if (!current()) throw new Error("Mission view changed")
      attempted = true
      setMissionGuidanceDraft(key, { text: original.text, state: "sending" })
      const messageId = await sendMessage(instanceId, coordinator, text, [], {
        delivery: "steer", preserveNativeProfile: true, admissionCurrent: current,
      })
      // Update the original identity even after navigation, never the new mission.
      setMissionGuidanceDraft(key, { text: "", state: "admitted", messageId })
    } catch {
      // A lost acknowledgement might follow admission. Preserve the text and
      // prohibit replay; inspect the coordinator before explicitly starting anew.
      setMissionGuidanceDraft(key, { text: original.text, state: attempted ? "uncertain" : "error" })
    }
  }
  return <MissionDisclosure missionId={props.mission.id} name="guidance" defaultOpen={false}
    title={<><MessageSquare class="h-4 w-4" aria-hidden="true" /><span>{t("missions.control.guidance.title")}</span></>}>
    <form class="mission-guidance" onSubmit={send}>
      <p>{t("missions.control.guidance.hint")}</p>
      <label>{t("missions.control.guidance.label")}
        <textarea maxLength={20_000} value={draft().text} disabled={busy() || draft().state === "uncertain"}
          onInput={event => setMissionGuidanceDraft(identity(), { text: event.currentTarget.value, state: "draft" })} />
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <button type="submit" class="window-action button-primary" disabled={props.disabled || !props.active || !running(props.mission)
          || busy() || draft().state === "uncertain" || !draft().text.trim()}>{t("missions.control.guidance.send")}</button>
        <button type="button" class="window-action" onClick={() => void props.onOpenActor(props.mission.coordinatorSessionId)}>
          <ArrowUpRight class="h-4 w-4" aria-hidden="true" />{t("missions.control.openCoordinator")}
        </button>
      </div>
      <p role={draft().state === "uncertain" || draft().state === "error" ? "alert" : "status"}>
        {t(!running(props.mission) ? "missions.control.guidance.inactive" : `missions.control.guidance.${draft().state}`)}
      </p>
      <button type="button" class="window-action" hidden={draft().state !== "uncertain"}
        onClick={() => setMissionGuidanceDraft(identity(), { text: "", state: "draft" })}>{t("missions.control.guidance.new")}</button>
    </form>
  </MissionDisclosure>
}
