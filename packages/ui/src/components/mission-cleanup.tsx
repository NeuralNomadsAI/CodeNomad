import { For, Show, createComputed, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionCleanup } from "../../../server/src/missions/model"
import { serverApi } from "../lib/api-client"
import { deletionErrorKey } from "../lib/mission-cleanup"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"
import { MissionListItem } from "./mission-list-item"
import { RefreshCw } from "lucide-solid"
import { createMissionViewFence } from "../lib/mission-view-fence"

export function MissionCleanupPanel(props: {
  instanceId: string; cleanups: MissionCleanup[]; disabled: boolean; active: boolean
  refresh: () => Promise<void>
}) {
  const { t } = useI18n()
  const [pending, setPending] = createSignal("")
  const [error, setError] = createSignal("")
  // A deletion ID alone must not reuse a control for a different saved intent.
  const rows = createMemo(() => new Map(props.cleanups.map(item => [JSON.stringify([
    props.instanceId, item.deletionID, item.missionID, item.requestID,
    item.expectedRevision, item.deleteManagedSessions, item.createdAt,
  ]), item])))
  const captureView = createMissionViewFence(
    () => JSON.stringify([props.instanceId, [...rows()].filter(([, item]) => item.pending > 0).map(([key]) => key).sort()]),
    () => props.active && !props.disabled,
  )
  let attempt = 0, scope = props.instanceId
  createComputed(() => {
    if (scope === props.instanceId) return
    scope = props.instanceId
    attempt++
    setPending(""); setError("")
  })
  // Completion must not collapse a reader the user was watching. Explicit
  // saved disclosure choices still take precedence over this initial default.
  const defaultOpen = createMemo<boolean>(wasPending => wasPending || props.cleanups.some(item => item.pending > 0), false)
  let alive = true
  onCleanup(() => { alive = false })

  async function retry(key: string) {
    if (pending() || props.disabled || !props.active) return
    const saved = rows().get(key)
    if (!saved?.pending) return
    const instanceId = props.instanceId
    const viewCurrent = captureView(), operation = ++attempt
    const current = () => alive && operation === attempt && viewCurrent() && Boolean(rows().get(key)?.pending)
    setPending(saved.deletionID); setError("")
    try {
      // Display data is never destructive authority. Reconcile the original
      // intent before an explicit retry, then let the native bridge revalidate.
      const snapshot = await serverApi.fetchMissions(instanceId)
      if (!current()) return
      const fresh = snapshot.available && !snapshot.cleanupUnavailable && snapshot.cleanups?.find(item => item.deletionID === saved.deletionID
        && item.missionID === saved.missionID && item.requestID === saved.requestID
        && item.expectedRevision === saved.expectedRevision && item.deleteManagedSessions === saved.deleteManagedSessions)
      if (!fresh) throw new Error("Unconfirmed cleanup intent")
      if (fresh.pending) await serverApi.deleteMission(instanceId, fresh.missionID, {
        requestId: fresh.requestID, expectedRevision: fresh.expectedRevision, deleteManagedSessions: fresh.deleteManagedSessions,
      })
      if (current()) await props.refresh()
    } catch (failure) {
      if (current()) { setError(t(deletionErrorKey(failure))); await props.refresh() }
    } finally { if (alive && operation === attempt) setPending("") }
  }

  return <Show when={props.cleanups.length}><MissionDisclosure missionId={`cleanup:${props.instanceId}`} name="cleanup"
    title={t("missions.cleanup.title")} defaultOpen={defaultOpen()} class="mission-cleanup">
    <For each={[...rows().keys()]}>{key => <Show when={rows().get(key)}>{item => <MissionListItem text={item().objective} title={item().objective}
      status={<span role="status">{t("missions.cleanup.counts", { removed: item().removed, retained: item().retained, pending: item().pending })}</span>}
      statusKind={item().pending > 0 ? "needs-input" : "completed"}
      actions={item().pending > 0 ? [{ key: "retry", label: t(pending() === item().deletionID ? "missions.control.mutation.pending" : "missions.control.retry"),
        icon: <RefreshCw class="h-3.5 w-3.5" />, disabled: props.disabled || !props.active || Boolean(pending()), onSelect: () => retry(key) }] : []}>
      <Show when={item().retained > 0}><For each={item().reasons}>{reason => <p>{t(`missions.cleanup.reason.${reason}`)}</p>}</For></Show>
    </MissionListItem>}</Show>}</For>
    <p class="mission-cleanup-policy">{t("missions.cleanup.preserved")}</p>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </MissionDisclosure></Show>
}
