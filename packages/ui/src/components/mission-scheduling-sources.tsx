import { For, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import type { MissionConditionKind, MissionSchedulingDraft } from "./mission-scheduling-data"

type SelectedSource = Exclude<MissionConditionKind, "files-changed">
/** Lists come from the owning authorized project. Absence is an unavailable read. */
export type MissionSchedulingSourceLists = Partial<Record<SelectedSource, readonly { id: string; label: string }[]>>
const conditions = ["none", "schedule-success", "branch-commits", "mission-completed", "conversation-message", "files-changed"] as const

export function MissionSchedulingSources(props: { draft: MissionSchedulingDraft; sources: MissionSchedulingSourceLists
  onChange: (patch: Partial<MissionSchedulingDraft>) => void; errorID?: string }) {
  const { t } = useI18n()
  const choices = () => props.sources[props.draft.condition as SelectedSource]
  return <>
    <label><span>{t("missions.scheduling.condition")}<Show when={props.draft.condition !== "none"}><SettingsInfoTip text={t("missions.scheduling.conditionHint")} /></Show></span><select aria-label={t("missions.scheduling.condition")} value={props.draft.condition}
      onChange={event => props.onChange({ condition: event.currentTarget.value as MissionSchedulingDraft["condition"], source: "" })}>
      <For each={conditions}>{kind => <option value={kind}>{t(`missions.scheduling.condition.${kind}`)}</option>}</For>
    </select></label>
    <Show when={props.draft.condition === "files-changed"} fallback={<Show when={props.draft.condition !== "none"}>
      <label>{t("missions.scheduling.source")}<select aria-label={t("missions.scheduling.source")} aria-invalid={!!props.errorID} aria-describedby={props.errorID} disabled={!choices()} value={props.draft.source}
        onChange={event => props.onChange({ source: event.currentTarget.value })}>
        <option value="" selected={!props.draft.source}>{t("missions.scheduling.chooseSource")}</option>
        <Show when={props.draft.source && !choices()?.some(item => item.id === props.draft.source)}>
          <option value={props.draft.source} selected disabled>{t("missions.scheduling.sourceMissing", { source: props.draft.source })}</option>
        </Show>
        <For each={choices()}>{item => <option value={item.id} selected={props.draft.source === item.id}>{item.label}</option>}</For>
      </select></label>
      <Show when={!choices()}><p role="status">{t("missions.scheduling.sourcesUnavailable")}</p></Show>
    </Show>}>
      <label><span>{t("missions.scheduling.files")}<SettingsInfoTip text={t("missions.scheduling.filesHint")} /></span><textarea aria-label={t("missions.scheduling.files")} rows={3} aria-invalid={!!props.errorID} aria-describedby={props.errorID} value={props.draft.files} maxLength={64 * 1024}
        onInput={event => props.onChange({ files: event.currentTarget.value })} /></label>
    </Show>
  </>
}
