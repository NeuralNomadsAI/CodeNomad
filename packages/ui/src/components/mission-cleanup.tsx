import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import type { MissionCleanup } from "../../../server/src/missions/model"
import { serverApi } from "../lib/api-client"
import { deletionErrorKey } from "../lib/mission-cleanup"
import { useI18n } from "../lib/i18n"
import { MissionDisclosure } from "./mission-disclosure"

export function MissionCleanupPanel(props: {
  instanceId: string; cleanups: MissionCleanup[]; disabled: boolean; active: boolean
  refresh: () => Promise<void>
}) {
  const { t } = useI18n()
  const [pending, setPending] = createSignal("")
  const [error, setError] = createSignal("")
  // Completion must not collapse a reader the user was watching. Explicit
  // saved disclosure choices still take precedence over this initial default.
  const defaultOpen = createMemo<boolean>(wasPending => wasPending || props.cleanups.some(item => item.pending > 0), false)
  let alive = true
  onCleanup(() => { alive = false })

  async function retry(saved: MissionCleanup) {
    if (pending() || props.disabled || !props.active) return
    const instanceId = props.instanceId
    const current = () => alive && props.instanceId === instanceId && props.active
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
    } finally { if (alive && props.instanceId === instanceId) setPending("") }
  }

  return <Show when={props.cleanups.length}><MissionDisclosure missionId={`cleanup:${props.instanceId}`} name="cleanup"
    title={t("missions.cleanup.title")} defaultOpen={defaultOpen()} class="mission-cleanup">
    <For each={props.cleanups}>{item => <div class="mission-cleanup-entry">
      <span class="mission-cleanup-objective" title={item.objective}>{item.objective}</span>
      <span role="status">{t("missions.cleanup.counts", { removed: item.removed, retained: item.retained, pending: item.pending })}</span>
      <Show when={item.retained > 0}><For each={item.reasons}>{reason => <p>{t(`missions.cleanup.reason.${reason}`)}</p>}</For></Show>
      <Show when={item.pending > 0}><button class="button-secondary" disabled={props.disabled || !props.active || Boolean(pending())}
        onClick={() => void retry(item)}>{t(pending() === item.deletionID ? "missions.control.mutation.pending" : "missions.control.retry")}</button></Show>
    </div>}</For>
    <p class="mission-cleanup-policy">{t("missions.cleanup.preserved")}</p>
    <Show when={error()}><p role="alert">{error()}</p></Show>
  </MissionDisclosure></Show>
}
