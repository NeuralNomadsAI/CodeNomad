import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { Play, Pause, Square, RotateCcw, SearchCheck } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { isRejectedLifecycleIntent, type MissionLifecycleInput } from "../lib/mission-lifecycle-request"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { instances } from "../stores/instances"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"
import { MissionProfileSummary } from "./mission-profile-summary"

export function MissionLifecycleControls(props: { instanceId: string; mission: MissionMap; disabled?: boolean }) {
  const { t } = useI18n()
  const [refreshing, setRefreshing] = createSignal(false)
  const [confirmStop, setConfirmStop] = createSignal(false)
  const confirmationId = createUniqueId()
  let stopButton: HTMLButtonElement | undefined
  const location = () => {
    const instance = instances().get(props.instanceId)
    return { directory: instance?.folder, proxyPath: instance?.proxyPath,
      projectID: instance?.metadata?.project?.id, snapshotProjectID: missionStore.state(props.instanceId).projectID }
  }
  const identity = createMemo(() => missionLifecycleSource(props.instanceId, props.mission, location()))
  const retry = () => missionLifecycleIntents.retry(identity())
  const busy = () => missionLifecycleIntents.busy(identity()) || refreshing()
  const active = () => missionStore.demandedInstanceIds().includes(props.instanceId)
  createEffect(() => { identity(); props.mission.revision; active(); setConfirmStop(false) })
  let alive = true, epoch = 0, attempt = 0
  createEffect(() => { identity(); epoch++; setRefreshing(false) })
  onCleanup(() => { alive = false; epoch++ })
  const pending = () => Boolean(props.mission.control?.pending.length)
  const state = () => props.mission.runState ?? "running"
  const terminal = () => props.mission.status !== "active"
  const durableRequest = (): MissionLifecycleInput | undefined => {
    const operation = props.mission.control
    return operation?.pending.length ? { action: operation.action, expectedRevision: operation.expectedRevision, requestId: operation.requestID } : undefined
  }
  const retryBlocked = () => {
    const request = durableRequest() ?? retry()?.input
    return !request || !missionLifecycleIntents.canReserve(identity(), props.mission.id, request)
  }
  const full = () => !missionLifecycleIntents.available()
  async function checkStatus() {
    if (busy() || !active() || props.disabled) return
    const scope = identity(), startedEpoch = epoch
    setRefreshing(true)
    try { await missionStore.refresh(props.instanceId) }
    finally { if (alive && scope === identity() && startedEpoch === epoch) setRefreshing(false) }
  }
  const cancelStop = () => { setConfirmStop(false); stopButton?.focus() }
  async function act(action: "start" | "pause" | "stop", replay = false) {
    if (props.disabled || busy() || !active() || (!replay && retry() && !pending()) || (replay && !pending() && !retry())) return
    const instanceId = props.instanceId, scope = identity(), sourceLocation = location(), startedEpoch = epoch
    const owned = () => alive && identity() === scope && epoch === startedEpoch
    const mission = props.mission
    if (!replay && full()) return
    const input = replay ? durableRequest() ?? retry()?.input
      : { action, expectedRevision: mission.revision, requestId: crypto.randomUUID() }
    if (!input) return
    const intent = missionLifecycleIntents.reserve(scope, mission.id, input)
    if (!intent || !missionLifecycleIntents.start(intent)) return
    const startedAttempt = ++attempt, initialControlID = mission.control?.id
    const current = () => {
      const control = props.mission.control
      const sameOperation = !control || control.id === initialControlID || (control.requestID === intent.input.requestId
        && control.action === intent.input.action && control.expectedRevision === intent.input.expectedRevision)
      return owned() && active() && attempt === startedAttempt && sameOperation
    }
    let outcome: "acknowledged" | "rejected" | "unknown" = "unknown"
    try {
      const result = await serverApi.controlMission(instanceId, mission.id, intent.input)
      const acknowledged = result?.mission
      if (acknowledged && missionLifecycleSource(instanceId, acknowledged, sourceLocation) === scope) outcome = "acknowledged"
    } catch (error) {
      if (isRejectedLifecycleIntent(error)) outcome = "rejected"
    } finally {
      // The exact operation owns bookkeeping, not its mounted/visible reader.
      // Late ACKs may settle that record, never another request or a new view.
      const matched = missionLifecycleIntents.finish(intent, outcome)
      if (matched && current()) {
        setRefreshing(true)
        try { await missionStore.refresh(instanceId) }
        finally { if (owned()) setRefreshing(false) }
      }
    }
  }
  return <Show when={!terminal() || pending() || retry() || busy()}><div class="mission-lifecycle">
    <Show when={state() === "prepared" && !terminal()}><MissionProfileSummary profiles={props.mission.profiles} template={props.mission.template} /></Show>
    <div class="mission-lifecycle-actions">
      <button type="button" class="mission-control-icon-button" classList={{ "mission-lifecycle-start": state() === "prepared" }} aria-label={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        title={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        disabled={props.disabled || busy() || full() || Boolean(retry()) || pending() || terminal() || state() === "running"} onClick={() => void act("start")}><Play class="h-4 w-4" aria-hidden="true" /><Show when={state() === "prepared"}><span>{t("missions.control.run.start")}</span></Show></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.pause")} title={t("missions.control.run.pause")}
        disabled={props.disabled || busy() || full() || Boolean(retry()) || pending() || terminal() || state() !== "running"} onClick={() => void act("pause")}><Pause class="h-4 w-4" /></button>
      <button ref={stopButton} type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.stop")} title={t("missions.control.run.stop")}
        aria-expanded={confirmStop()} aria-controls={confirmStop() ? confirmationId : undefined}
        disabled={props.disabled || busy() || full() || Boolean(retry() && !pending()) || terminal()} onClick={() => setConfirmStop(value => !value)}><Square class="h-4 w-4" aria-hidden="true" /></button>
      <Show when={pending() || retry()}>
        <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.checkStatus")} title={t("missions.control.checkStatus")}
          disabled={props.disabled || busy()} onClick={() => void checkStatus()}><SearchCheck class="h-4 w-4" aria-hidden="true" /></button>
        <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.retry")} title={t("missions.control.retry")}
          disabled={props.disabled || busy() || retryBlocked()} onClick={() => void act(props.mission.control?.action ?? retry()?.input.action ?? "start", true)}><RotateCcw class="h-4 w-4" aria-hidden="true" /></button>
      </Show>
    </div>
    <Show when={confirmStop()}><div id={confirmationId} class="mission-stop-confirmation" role="group" aria-label={t("missions.control.run.stopConfirm")}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelStop() } }}>
      <span>{t("missions.control.run.stopConfirm")}</span>
      <button type="button" class="window-text-button" disabled={props.disabled || busy() || terminal()} onClick={() => { setConfirmStop(false); void act("stop") }}>{t("missions.control.run.stop")}</button>
      <button type="button" class="window-text-button" onClick={cancelStop}>{t("missions.control.cancel")}</button>
    </div></Show>
    <Show when={busy()}><small role="status">{t("missions.control.mutation.pending")}</small></Show>
    <Show when={!busy() && (pending() || retry() || full())}><small role="alert">{t("missions.control.run.error")}</small></Show>
  </div></Show>
}
