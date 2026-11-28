import { For, Show, createMemo } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { recoveredDraftIds, switchRecoveredDraft } from "../../stores/session-draft-recovery"

export default function RecoveredDrafts(props: { instanceId: string }) {
  const { t } = useI18n()
  const drafts = createMemo(() => recoveredDraftIds(props.instanceId))
  return <Show when={drafts().length}>
    <select class="selector-input self-start mx-3 my-1" aria-label={t("sessionState.cleanup.switchDraft")}
      onChange={event => {
        switchRecoveredDraft(props.instanceId, event.currentTarget.value)
        event.currentTarget.value = ""
      }}>
      <option value="">{t("sessionState.cleanup.switchDraft")}</option>
      <For each={drafts()}>{(id, index) =>
        <option value={id}>{t("sessionState.cleanup.savedDraft", { number: index() + 1 })}</option>
      }</For>
    </select>
  </Show>
}
