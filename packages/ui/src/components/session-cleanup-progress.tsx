import { Show, createSignal } from "solid-js"
import { useI18n } from "../lib/i18n"
import { sessionCleanupProgress } from "../stores/session-cleanup-progress"

export default function SessionCleanupProgress(props: { instanceId: string; sessionId: string }) {
  const { t } = useI18n()
  return <Show when={sessionCleanupProgress(props.instanceId, props.sessionId)}>{job => {
    const [cancelled, setCancelled] = createSignal(false)
    return <div class="window-toolbar history-statistics" role="status">
      <span>{t(`history.${job().phase}`, { count: job().count, total: job().total })}</span>
      <button type="button" class="button-tertiary" disabled={cancelled()} onClick={() => {
        setCancelled(true); job().controller.abort()
      }}>{t("alertDialog.actions.cancel")}</button>
    </div>
  }}</Show>
}
