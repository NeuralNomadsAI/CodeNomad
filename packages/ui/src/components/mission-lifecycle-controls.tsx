import { Show, createSignal } from "solid-js"
import { Play, Pause, Square, RefreshCw } from "lucide-solid"
import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"

export function MissionLifecycleControls(props: { instanceId: string; mission: MissionMap; disabled?: boolean }) {
  const { t } = useI18n()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)
  let retry: { missionId: string; action: "start" | "pause" | "stop"; expectedRevision: number; requestId: string } | undefined
  const pending = () => Boolean(props.mission.control?.pending.length)
  const state = () => props.mission.runState ?? "running"
  const terminal = () => props.mission.status !== "active"
  async function act(action: "start" | "pause" | "stop", replay = false) {
    if (busy()) return
    const mission = props.mission
    const operation = mission.control
    const request = replay && pending() && operation
      ? { missionId: mission.id, action: operation.action, expectedRevision: operation.expectedRevision, requestId: operation.requestID }
      : replay && retry?.missionId === mission.id ? retry
      : { missionId: mission.id, action, expectedRevision: mission.revision, requestId: crypto.randomUUID() }
    retry = request
    setBusy(true)
    setError(false)
    try {
      const { missionId, ...input } = request
      await serverApi.controlMission(props.instanceId, missionId, input)
      retry = undefined
    } catch { setError(true) }
    finally { await missionStore.refresh(props.instanceId); setBusy(false) }
  }
  return <div class="mission-lifecycle">
    <div class="mission-lifecycle-actions">
      <button type="button" class="mission-control-icon-button" aria-label={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        title={t(state() === "paused" ? "missions.control.run.resume" : "missions.control.run.start")}
        disabled={props.disabled || busy() || pending() || terminal() || state() === "running"} onClick={() => void act("start")}><Play class="h-4 w-4" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.pause")} title={t("missions.control.run.pause")}
        disabled={props.disabled || busy() || pending() || terminal() || state() !== "running"} onClick={() => void act("pause")}><Pause class="h-4 w-4" /></button>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.run.stop")} title={t("missions.control.run.stop")}
        disabled={props.disabled || busy() || terminal()} onClick={() => void act("stop")}><Square class="h-4 w-4" /></button>
      <Show when={pending() || error()}>
        <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.retry")} title={t("missions.control.retry")}
          disabled={props.disabled || busy()} onClick={() => void act(props.mission.control?.action ?? retry?.action ?? "start", true)}><RefreshCw class="h-4 w-4" /></button>
      </Show>
    </div>
    <Show when={busy()}><small role="status">{t("missions.control.mutation.pending")}</small></Show>
    <Show when={!busy() && (pending() || error())}><small role="alert">{t("missions.control.run.error")}</small></Show>
  </div>
}
