import { Show, createUniqueId } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { missionAcceptsMessage, sendMissionCoordinatorMessage } from "../lib/mission-coordinator-message"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { missionGuidanceDraft, missionGuidanceText, setMissionGuidanceDraft, type MissionGuidanceDraft } from "../stores/mission-guidance"

/** "Write to the coordinator": a normal user prompt, never a plan edit,
 * synthetic report, assignment replay or automatic resume of a paused Mission. */
export function MissionGuidance(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled?: boolean
}) {
  const { t } = useI18n()
  const fieldId = createUniqueId()
  const identity = () => JSON.stringify([props.instanceId, instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id,
    props.mission.projectID, props.mission.id, props.mission.coordinatorSessionId])
  const draft = () => missionGuidanceDraft(identity())
  const running = missionAcceptsMessage
  const busy = () => ["preparing", "sending"].includes(draft().state)
  const frozen = () => busy() || draft().state === "uncertain"
  const edit = (value: Partial<MissionGuidanceDraft>) => {
    if (!frozen()) setMissionGuidanceDraft(identity(), { ...draft(), ...value, state: "draft", messageId: undefined })
  }
  const capture = createMissionViewFence(identity, () => props.active && !props.disabled)
  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || draft().state === "uncertain" || props.disabled || !running(props.mission) || !draft().text.trim()) return
    const key = identity(), original = { ...draft() }
    const task = props.mission.tasks.find(value => value.id === original.taskId)
    if (original.taskId && !task) return
    const text = missionGuidanceText(original, {
      intent: original.intent ? t(`missions.control.guidance.intent.${original.intent}`) : undefined,
      task: task ? t("missions.control.guidance.taskContext", { task: task.title, key: task.key }) : undefined,
    })
    const instanceId = props.instanceId
    const owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId)
    const viewCurrent = capture()
    const current = () => viewCurrent() && !props.disabled && running(props.mission)
      && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    setMissionGuidanceDraft(key, { ...original, state: "preparing" })
    const result = await sendMissionCoordinatorMessage({ instanceId, mission: props.mission, current,
      text: mission => {
        if (task && !mission.tasks.some(value => value.id === task.id && value.key === task.key)) throw new Error("Task changed")
        return text
      }, onSending: () => setMissionGuidanceDraft(key, { ...original, state: "sending" }),
    })
    // Always settle the original identity, even after navigation.
    setMissionGuidanceDraft(key, result.state === "admitted" ? { text: "", ...result } : { ...original, ...result })
  }
  const invalidTask = () => Boolean(draft().taskId && !props.mission.tasks.some(task => task.id === draft().taskId))
  return <form class="mission-guidance" onSubmit={send}>
    <label for={fieldId}>{t("missionsPanel.guidance.label")}</label>
    <div class="mission-guidance-field">
      <textarea id={fieldId} rows={2} maxLength={20_000} value={draft().text} disabled={frozen()}
        placeholder={t("missionsPanel.guidance.placeholder")}
        onInput={event => edit({ text: event.currentTarget.value })}
        onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      <button type="submit" class="window-action button-primary" disabled={props.disabled || !props.active || !running(props.mission)
        || frozen() || !draft().text.trim() || invalidTask()}>{t("missionsPanel.guidance.send")}</button>
    </div>
    <Show when={!running(props.mission) || draft().state !== "draft"}>
      <p role={draft().state === "uncertain" || draft().state === "error" ? "alert" : "status"}>
        {t(!running(props.mission) ? "missions.control.guidance.inactive" : `missions.control.guidance.${draft().state}`)}
      </p>
    </Show>
    <Show when={invalidTask()}><p role="alert">{t("missions.control.guidance.task.unavailable")}</p></Show>
    <button type="button" class="window-text-button" hidden={draft().state !== "uncertain"}
      onClick={() => setMissionGuidanceDraft(identity(), { text: "", state: "draft" })}>{t("missions.control.guidance.new")}</button>
  </form>
}
