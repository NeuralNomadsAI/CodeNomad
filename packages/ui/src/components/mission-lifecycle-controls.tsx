import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Play, Pause, Square, RefreshCw } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { isRejectedLifecycleIntent, type MissionLifecycleInput } from "../lib/mission-lifecycle-request"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { instances } from "../stores/instances"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"

export function MissionLifecycleControls(props: { instanceId: string; mission: MissionMap; disabled?: boolean }) {
  const { t } = useI18n()
  const [refreshing, setRefreshing] = createSignal(false)
  const location = () => {
    const instance = instances().get(props.instanceId)
    return { directory: instance?.folder, proxyPath: instance?.proxyPath,
      projectID: instance?.metadata?.project?.id, snapshotProjectID: missionStore.state(props.instanceId).projectID }
  }
  const identity = createMemo(() => missionLifecycleSource(props.instanceId, props.mission, location()))
  const retry = () => missionLifecycleIntents.retry(identity())
  const busy = () => missionLifecycleIntents.busy(identity()) || refreshing()
  const active = () => missionStore.demandedInstanceIds().includes(props.instanceId)
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
  return <div class="mission-lifecycle">
    <div class="mission-lifecycle-actions">
      <button type="button" class="mission-control-icon-button" aria-label={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        title={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        disabled={props.disabled || busy() || full() || Boolean(retry()) || pending() || terminal() || state() === "running"} onClick={() => void act("start")}><Play class="h-4 w-4" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.pause")} title={t("missions.control.run.pause")}
        disabled={props.disabled || busy() || full() || Boolean(retry()) || pending() || terminal() || state() !== "running"} onClick={() => void act("pause")}><Pause class="h-4 w-4" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.stop")} title={t("missions.control.run.stop")}
        disabled={props.disabled || busy() || full() || Boolean(retry() && !pending()) || terminal()} onClick={() => void act("stop")}><Square class="h-4 w-4" /></button>
      <Show when={pending() || retry()}>
        <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.retry")} title={t("missions.control.retry")}
          disabled={props.disabled || busy() || retryBlocked()} onClick={() => void act(props.mission.control?.action ?? retry()?.input.action ?? "start", true)}><RefreshCw class="h-4 w-4" /></button>
      </Show>
    </div>
    <Show when={busy()}><small role="status">{t("missions.control.mutation.pending")}</small></Show>
    <Show when={!busy() && (pending() || retry() || full())}><small role="alert">{t("missions.control.run.error")}</small></Show>
  </div>
}
