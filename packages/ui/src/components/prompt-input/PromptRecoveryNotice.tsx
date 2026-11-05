import { For, Show } from "solid-js"
import { useI18n } from "../../lib/i18n"
import type { QueuedPromptDraft } from "./usePromptRecovery"

export default function PromptRecoveryNotice(props: {
  interrupted: boolean
  queued: QueuedPromptDraft[]
  canRestore: boolean
  onRestore: (draft: QueuedPromptDraft) => void
}) {
  const { t } = useI18n()
  return <>
    <Show when={props.interrupted}>
      <div class="composer-notice" role="status" aria-live="polite"><span class="composer-notice-text">{t("session.actions.interrupted")}</span></div>
    </Show>
    <For each={props.queued}>{draft => <div class="composer-notice">
      <div class="composer-notice-text" role="status" aria-live="polite">{t("promptQueue.recovery.saved")}</div>
      <div class="composer-notice-text text-xs" dir="auto">{draft.text.slice(0, 200)}</div>
      <button type="button" class="window-action composer-notice-action" disabled={!props.canRestore} onClick={() => props.onRestore(draft)}>
        {t("promptQueue.recovery.restore")}
      </button>
    </div>}</For>
  </>
}
