import { Show, createEffect, createMemo } from "solid-js"
import { Eye, RefreshCw } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { instances } from "../stores/instances"
import { getOpenCodeInstanceGeneration } from "../stores/opencode-data"
import { createMissionViewFence } from "../lib/mission-view-fence"
import { missionAcceptsMessage, sendMissionCoordinatorMessage } from "../lib/mission-coordinator-message"
import { missionBriefingRequestText } from "../lib/mission-briefing-request"
import { missionBriefingRequest, setMissionBriefingRequest } from "../stores/mission-briefing-request"
import { missionBriefingFreshness } from "./mission-briefing-model"

export function MissionBriefing(props: {
  instanceId: string; mission: MissionMap; active: boolean; disabled?: boolean
  onReadOverview: () => void; reading?: boolean
  onOpenCoordinator: () => void
}) {
  const { t, locale } = useI18n()
  const identity = () => JSON.stringify([props.instanceId, instances().get(props.instanceId)?.folder,
    instances().get(props.instanceId)?.metadata?.project?.id, props.mission.projectID, props.mission.id, props.mission.coordinatorSessionId])
  const request = () => missionBriefingRequest(identity())
  const answered = () => Boolean(request()?.briefingId || request() && props.mission.briefing?.requestID === request()?.requestID)
  createEffect(() => {
    const original = request(), value = props.mission.briefing
    if (original && !original.briefingId && value?.requestID === original.requestID)
      setMissionBriefingRequest(identity(), { ...original, briefingId: value.id })
  })
  const waiting = () => !answered() && request() && ["preparing", "sending", "admitted", "uncertain"].includes(request()!.state)
  const freshness = createMemo(() => missionBriefingFreshness(props.mission))
  const capture = createMissionViewFence(identity, () => props.active && !props.disabled)
  const ask = async () => {
    if (waiting() || props.disabled || !props.active || !missionAcceptsMessage(props.mission)) return
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
  return <section class="mission-briefing" aria-label={t("missions.briefing.title")}>
    <header><h3>{t("missions.briefing.title")}</h3><div class="window-actions">
      <Show when={props.mission.briefing || props.mission.summary}><button type="button" class="mission-control-icon-button icon-toggle"
        aria-label={t("missions.briefing.title")} title={t("missions.briefing.title")} aria-pressed={Boolean(props.reading)}
        onClick={props.onReadOverview}><Eye class="h-3.5 w-3.5" aria-hidden="true" /></button></Show>
      <Show when={props.mission.status === "active"}><button type="button" class="window-text-button"
        disabled={props.disabled || !props.active || !missionAcceptsMessage(props.mission) || Boolean(waiting())}
        onClick={() => void ask()}><RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />{t("missions.briefing.request")}</button></Show>
    </div></header>
    <Show when={!props.mission.summary}>
      <Show when={props.mission.briefing} fallback={<p class="mission-briefing-empty">{t("missions.briefing.empty")}</p>}>{value => <>
        <p class="mission-briefing-meta">{t("missions.briefing.authored")} · <time dateTime={new Date(value().createdAt).toISOString()}>{new Date(value().createdAt).toLocaleString(locale())}</time></p>
        <Show when={freshness().changed}><p class="mission-briefing-stale" role="status">{t(freshness().results
          ? freshness().results === 1 ? "missions.briefing.newResults.one" : "missions.briefing.newResults.other"
          : "missions.briefing.changed", { count: freshness().results })}</p></Show>
      </>}</Show>
    </Show>
    <Show when={props.mission.status === "active" && !missionAcceptsMessage(props.mission)}><p class="mission-briefing-meta">{t("missions.briefing.inactive")}</p></Show>
    <Show when={request() && !answered()}><p role={request()?.state === "error" || request()?.state === "uncertain" ? "alert" : "status"}
      class="mission-briefing-feedback">{t(`missions.briefing.request.${request()!.state}`)}</p></Show>
    <Show when={request() && !answered() && ["admitted", "uncertain"].includes(request()!.state)}>
      <button type="button" class="window-text-button" disabled={props.disabled || !props.active}
        onClick={props.onOpenCoordinator}>{t("missions.control.openCoordinator")}</button>
      <button type="button" class="window-text-button" disabled={props.disabled || !props.active || !missionAcceptsMessage(props.mission)}
        onClick={() => { if (window.confirm(t("missions.briefing.newConfirm"))) {
          setMissionBriefingRequest(identity(), { requestID: request()!.requestID, state: "error" })
          void ask()
        } }}>{t("missions.briefing.newRequest")}</button>
    </Show>
  </section>
}
