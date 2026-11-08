import { createMemo, createUniqueId, Show } from "solid-js"
import type { MemoryUIEntry } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { memoryCharacters, memoryTitleValid, type createAgentMemoryReview } from "../../stores/agent-memory"
import { showConfirmDialog } from "../../stores/alerts"
import ActionOverflowMenu from "../action-overflow-menu"
import { SettingsInfoTip } from "./settings-info-tip"

export function AgentMemoryEditor(props: { review: ReturnType<typeof createAgentMemoryReview>; readOnly: boolean; id: string }) {
  const { t } = useI18n(), id = createUniqueId(), review = props.review
  const selected = () => review.draft()!
  const blocked = () => props.readOnly || review.busy()
  let titleField: HTMLInputElement | undefined
  const items = createMemo(() => [{ key: "forget", label: t("settings.memory.forget"), disabled: blocked(), onSelect: async () => {
    const entry = selected().entry
    const consent = review.consentSignal()
    if (!(await showConfirmDialog(t("settings.memory.forgetConfirm", { title: entry.title }), {
      confirmLabel: t("settings.memory.forget"), cancelLabel: t("settings.memory.cancel"),
      returnFocus: () => titleField?.focus(),
    }, consent))) return
    if (consent.aborted || review.draft()?.entry.id !== entry.id) return
    await review.remove(entry.revision)
    document.querySelector<HTMLSelectElement>("#agent-memory select")?.focus()
  } }])
  return <form id={props.id} class="agent-memory-editor" aria-label={selected().entry.title} onSubmit={event => {
    event.preventDefault()
    if (!blocked() && review.dirty() && review.valid()) void review.save()
  }}>
    <div class="agent-memory-editor-heading">
      <Show when={selected().entry.flagged}><span class="agent-memory-warning">{t("settings.memory.excluded")}<SettingsInfoTip text={t("settings.memory.warning")} help={{ page: "settings", anchor: "agent-memory" }} /></span></Show>
      <ActionOverflowMenu triggerClass="window-icon-button" label={t("settings.memory.actions", { title: selected().entry.title })} items={items()} />
    </div>
    <label for={`${id}-title`}>{t("settings.memory.entryTitle")}</label>
    <input ref={titleField} id={`${id}-title`} dir="auto" value={selected().title} disabled={blocked()}
      aria-invalid={!memoryTitleValid(selected().title)} aria-describedby={`${id}-title-count${!memoryTitleValid(selected().title) ? ` ${id}-title-error` : ""}`}
      onInput={event => review.edit({ title: event.currentTarget.value })} />
    <span id={`${id}-title-count`} class="agent-memory-counter">{t("settings.memory.characters", { count: memoryCharacters(selected().title), limit: 60 })}</span>
    <Show when={!memoryTitleValid(selected().title)}><span id={`${id}-title-error`} role="alert">{t("settings.memory.titleInvalid")}</span></Show>
    <label for={`${id}-type`}>{t("settings.memory.entryType")}</label>
    <select id={`${id}-type`} value={selected().type} disabled={blocked()} onChange={event => review.edit({ type: event.currentTarget.value as MemoryUIEntry["type"] })}>
      <option value="fact">{t("settings.memory.type.fact")}</option><option value="preference">{t("settings.memory.type.preference")}</option><option value="reference">{t("settings.memory.type.reference")}</option>
    </select>
    <label for={`${id}-text`}>{t("settings.memory.text")}</label>
    <textarea id={`${id}-text`} dir="auto" rows={8} value={selected().text} disabled={blocked()} aria-invalid={memoryCharacters(selected().text) > 2000}
      aria-describedby={`${id}-text-count${memoryCharacters(selected().text) > 2000 ? ` ${id}-text-error` : ""}`} onInput={event => review.edit({ text: event.currentTarget.value })} />
    <span id={`${id}-text-count`} class="agent-memory-counter">{t("settings.memory.characters", { count: memoryCharacters(selected().text), limit: 2000 })}</span>
    <Show when={memoryCharacters(selected().text) > 2000}><span id={`${id}-text-error`} role="alert">{t("settings.memory.textInvalid")}</span></Show>
    <div class="agent-memory-actions">
      <button type="submit" class="window-action" disabled={blocked() || !review.dirty() || !review.valid()}>{t("settings.memory.save")}</button>
      <button type="button" class="window-action" disabled={review.busy() || !review.dirty()} onClick={review.cancel}>{t("settings.memory.cancel")}</button>
    </div>
  </form>
}
