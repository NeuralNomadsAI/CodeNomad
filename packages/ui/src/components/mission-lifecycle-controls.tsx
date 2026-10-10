import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { isRejectedLifecycleIntent, type MissionLifecycleInput } from "../lib/mission-lifecycle-request"
import { useI18n } from "../lib/i18n"
import { missionStore } from "../stores/missions"
import { instances } from "../stores/instances"
import { showConfirmDialog } from "../stores/alerts"
import { missionLifecycleIntents, missionLifecycleSource } from "../stores/mission-lifecycle-intents"
import type { ActionOverflowMenuItem } from "./action-overflow-menu"

export interface MissionPrimaryAction { key: string; label: string; ariaLabel?: string; disabled?: boolean; onSelect: () => void | Promise<void> }

/** Play/Pause/Stop for one Mission row: one contextual primary action, the rest
 * for the row's overflow menu. Unresolved requests are checked, never resent. */
export function createMissionLifecycle(props: { instanceId: string; mission: MissionMap; disabled?: boolean }) {
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
  const unresolved = () => pending() || Boolean(retry())
  const durableRequest = (): MissionLifecycleInput | undefined => {
    const operation = props.mission.control
    return operation?.pending.length ? { action: operation.action, expectedRevision: operation.expectedRevision, requestId: operation.requestID } : undefined
  }
  const retryBlocked = () => {
    const request = durableRequest() ?? retry()?.input
    return !request || !missionLifecycleIntents.canReserve(identity(), props.mission.id, request)
  }
  const full = () => !missionLifecycleIntents.available()
  const blocked = () => Boolean(props.disabled) || busy() || full() || !active()
  async function checkStatus() {
    if (busy() || !active() || props.disabled) return
    const scope = identity(), startedEpoch = epoch
    setRefreshing(true)
    try { await missionStore.refresh(props.instanceId) }
    finally { if (alive && scope === identity() && startedEpoch === epoch) setRefreshing(false) }
  }
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
  async function confirmStop() {
    if (blocked() || terminal()) return
    const scope = identity(), revision = props.mission.revision
    const confirmed = await showConfirmDialog(t("missions.control.run.stopConfirm"), { variant: "warning",
      confirmLabel: t("missions.control.run.stop"), cancelLabel: t("missions.control.cancel") })
    // The confirmation belongs to the exact Mission revision it described.
    if (confirmed && alive && identity() === scope && props.mission.revision === revision) await act("stop")
  }
  const primary = (): MissionPrimaryAction | undefined => {
    if (unresolved()) return { key: "check", label: t("missionsPanel.action.checkStatus"), ariaLabel: t("missions.control.checkStatus"), disabled: Boolean(props.disabled) || busy(), onSelect: checkStatus }
    if (terminal()) return undefined
    const disabled = blocked() || pending()
    if (state() === "prepared") return { key: "start", label: t("missionsPanel.action.start"), ariaLabel: t("missions.control.run.start"), disabled, onSelect: () => act("start") }
    if (state() === "paused") return { key: "resume", label: t("missionsPanel.action.resume"), ariaLabel: t("missions.control.run.resume"), disabled, onSelect: () => act("start") }
    return { key: "pause", label: t("missionsPanel.action.pause"), ariaLabel: t("missions.control.run.pause"), disabled, onSelect: () => act("pause") }
  }
  const stop = (): MissionPrimaryAction | undefined => !terminal() && !(retry() && !pending())
    ? { key: "stop", label: t("missions.control.run.stop"), disabled: blocked(), onSelect: confirmStop } : undefined
  const menu = (): ActionOverflowMenuItem[] => unresolved() && !retryBlocked() ? [{ key: "retry", label: t("missionsPanel.action.retry"),
    disabled: Boolean(props.disabled) || busy(), onSelect: () => act(props.mission.control?.action ?? retry()?.input.action ?? "start", true) }] : []
  const feedback = <>
    <Show when={busy()}><small role="status">{t("missions.control.mutation.pending")}</small></Show>
    <Show when={!busy() && (unresolved() || (full() && !terminal()))}><small role="alert">{t("missions.control.run.error")}</small></Show>
  </>
  return { primary, stop, menu, feedback }
}
