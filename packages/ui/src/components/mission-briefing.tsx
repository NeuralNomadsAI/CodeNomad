import { Show, createEffect } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { missionAcceptsMessage, sendMissionCoordinatorMessage } from "../lib/mission-coordinator-message"
import { missionBriefingRequestText } from "../lib/mission-briefing-request"
import { missionBriefingRequest, setMissionBriefingRequest } from "../stores/mission-briefing-request"

/** The explicit "Request an update" briefing request. Its state is keyed by the
 * exact Mission identity, so the row menu and the card share one request. */
export function createMissionBriefingRequest(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled?: boolean; readOnly?: boolean
}) {
  const { t, locale } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id, props.mission.projectID, props.mission.id, props.mission.coordinatorSessionId])
  const request = () => missionBriefingRequest(identity())
  // Only an accepted briefing carrying this exact request ID answers it, even when
  // a later (e.g. automatic) briefing superseded it before this view read it.
  const response = () => {
    const original = request(), latest = props.mission.briefing
    if (!original) return undefined
    if (latest?.requestID === original.requestID) return latest.id
    return props.mission.briefingResponses?.find(item => item.requestID === original.requestID)?.briefingID
  }
  const answered = () => Boolean(request()?.briefingId || response())
  createEffect(() => {
    const original = request(), briefingId = response()
    if (original && !original.briefingId && briefingId) setMissionBriefingRequest(identity(), { ...original, briefingId })
  })
  const waiting = () => !answered() && Boolean(request()) && ["preparing", "sending", "admitted", "uncertain"].includes(request()!.state)
  const capture = createMissionViewFence(identity, () => props.active && !props.disabled)
  const available = () => !props.readOnly && props.mission.status === "active" && missionAcceptsMessage(props.mission)
  const ask = async () => {
    if (!available() || waiting() || props.disabled || !props.active) return
    const key = identity(), instanceId = props.instanceId, mission = props.mission
    const original = { requestID: crypto.randomUUID(), state: "preparing" as const }
    const owner = instances().get(instanceId)?.client, generation = getOpenCodeInstanceGeneration(instanceId), viewCurrent = capture()
    const current = () => viewCurrent() && !props.disabled && missionAcceptsMessage(props.mission)
      && missionBriefingRequest(key)?.requestID === original.requestID
      && instances().get(instanceId)?.client === owner && getOpenCodeInstanceGeneration(instanceId) === generation
    setMissionBriefingRequest(key, original)
    const language = locale()
    const result = await sendMissionCoordinatorMessage({ instanceId, mission, current,
      text: fresh => missionBriefingRequestText(fresh, original.requestID, language),
      onSending: () => {
        const latest = missionBriefingRequest(key)
        if (latest?.requestID === original.requestID) setMissionBriefingRequest(key, { ...latest, state: "sending" })
      },
    })
    const latest = missionBriefingRequest(key)
    if (latest?.requestID === original.requestID) setMissionBriefingRequest(key, { ...latest, ...result })
  }
  /** Uncertain or admitted requests stay visible by identity and are never resent automatically. */
  const feedback = (onOpenCoordinator: () => void) => <Show when={!props.readOnly && request() && !answered()}>
    <div class="mission-briefing-feedback">
      <p role={request()?.state === "error" || request()?.state === "uncertain" ? "alert" : "status"}>{t(`missions.briefing.request.${request()!.state}`)}</p>
      <Show when={["admitted", "uncertain"].includes(request()!.state)}>
        <button type="button" class="window-text-button" disabled={props.disabled || !props.active}
          onClick={onOpenCoordinator}>{t("missions.control.openCoordinator")}</button>
        <button type="button" class="window-text-button" disabled={props.disabled || !props.active || !available()}
          onClick={() => { if (window.confirm(t("missions.briefing.newConfirm"))) {
            setMissionBriefingRequest(identity(), { requestID: request()!.requestID, state: "error" })
            void ask()
          } }}>{t("missions.briefing.newRequest")}</button>
      </Show>
    </div>
  </Show>
  return { available, waiting, ask, feedback, state: () => answered() ? undefined : request()?.state }
}
