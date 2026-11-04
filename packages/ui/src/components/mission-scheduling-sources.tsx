import { For, Show } from "solid-js"
import { X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { MissionCriterionRole } from "./mission-criterion-role"
import { isMissionEventKind, missionEventKinds, missionHourSteps, missionScheduleShortcuts, type MissionConditionKind,
  type MissionCriterionDraft, type MissionCriterionKind } from "./mission-scheduling-data"

type SelectedSource = Exclude<MissionConditionKind, "files-changed">
/** Lists come from the owning authorized project. Absence is an unavailable read. */
export type MissionSchedulingSourceLists = Partial<Record<SelectedSource, readonly { id: string; label: string }[]>>

/** One "Launch when" criterion: a schedule shortcut writing a cron, or an event. */
export function MissionSchedulingCriterion(props: { row: MissionCriterionDraft; number: number; sources: MissionSchedulingSourceLists
  onChange: (row: MissionCriterionDraft) => void; onRemove: () => void; errorID?: string }) {
  const { t, locale } = useI18n()
  const patch = (change: Partial<MissionCriterionDraft>) => props.onChange({ ...props.row, ...change })
  const invalid = () => ({ "aria-invalid": !!props.errorID, "aria-describedby": props.errorID })
  const kind = () => props.row.kind
  const choices = () => props.sources[kind() as SelectedSource]
  const weekdays = () => new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" })
  const label = (key: string) => t(key, { number: props.number })
  const time = () => <label><span>{t("missions.scheduling.at")}</span>
    <input aria-label={label("missions.scheduling.criterionTime")} type="time" {...invalid()} value={props.row.time}
      onInput={event => patch({ time: event.currentTarget.value })} /></label>
  return <div class="mission-criterion" role="group" aria-label={label("missions.scheduling.criterion")}>
    <div class="mission-criterion-head">
      <select aria-label={label("missions.scheduling.criterionKind")} value={kind()}
        onChange={event => patch({ kind: event.currentTarget.value as MissionCriterionKind, source: "" })}>
        <optgroup label={t("missions.scheduling.group.schedule")}>
          <For each={missionScheduleShortcuts}>{value => <option value={value}>{t(`missions.scheduling.shortcut.${value}`)}</option>}</For>
        </optgroup>
        <optgroup label={t("missions.scheduling.group.event")}>
          <For each={missionEventKinds}>{value => <option value={value}>{t(`missions.scheduling.condition.${value}`)}</option>}</For>
        </optgroup>
      </select>
      <Show when={isMissionEventKind(kind())}>
        <MissionCriterionRole onlyIf={props.row.onlyIf} label={label("missions.scheduling.criterionRole")} onChange={onlyIf => patch({ onlyIf })} />
      </Show>
      <button type="button" class="window-icon-button" aria-label={label("missions.scheduling.removeCriterion")}
        title={label("missions.scheduling.removeCriterion")} onClick={() => props.onRemove()}><X class="h-4 w-4" aria-hidden="true" /></button>
    </div>
    <Show when={kind() === "hours"}><label><span>{t("missions.scheduling.everyHours")}</span>
      <select aria-label={label("missions.scheduling.criterionHours")} {...invalid()} value={props.row.hours}
        onChange={event => patch({ hours: event.currentTarget.value })}>
        <Show when={!(missionHourSteps as readonly number[]).includes(Number(props.row.hours))}>
          <option value={props.row.hours} selected disabled>{props.row.hours}</option>
        </Show>
        <For each={missionHourSteps}>{value => <option value={String(value)} selected={props.row.hours === String(value)}>{value}</option>}</For>
      </select></label></Show>
    <Show when={kind() === "daily" || kind() === "monthly" || kind() === "weekly"}>
      <div class="mission-scheduling-row">
        <Show when={kind() === "monthly"}><label><span>{t("missions.scheduling.monthDay")}<SettingsInfoTip text={t("missions.scheduling.monthHint")} /></span>
          <input aria-label={label("missions.scheduling.criterionMonthDay")} type="number" min="1" max="31" step="1" {...invalid()}
            value={props.row.monthDay} onInput={event => patch({ monthDay: event.currentTarget.value })} /></label></Show>
        {time()}
      </div>
    </Show>
    <Show when={kind() === "weekly"}><div class="mission-scheduling-days" role="group" aria-label={label("missions.scheduling.criterionDays")}>
      <For each={[1, 2, 3, 4, 5, 6, 0]}>{day => <label><input type="checkbox" {...invalid()} checked={props.row.days.includes(day)}
        onChange={event => patch({ days: event.currentTarget.checked ? [...props.row.days, day] : props.row.days.filter(value => value !== day) })} />
        {weekdays().format(Date.UTC(2026, 10, 1 + day))}</label>}</For>
    </div></Show>
    <Show when={kind() === "cron"}><label><span>{t("missions.scheduling.cron")}<SettingsInfoTip text={t("missions.scheduling.cronHint")} /></span>
      <input aria-label={label("missions.scheduling.criterionCron")} maxLength={512} dir="ltr" {...invalid()} value={props.row.expression}
        onInput={event => patch({ expression: event.currentTarget.value })} /></label></Show>
    <Show when={kind() === "files-changed"}><label><span>{t("missions.scheduling.files")}<SettingsInfoTip text={t("missions.scheduling.filesHint")} /></span>
      <textarea aria-label={label("missions.scheduling.criterionFiles")} rows={3} {...invalid()} value={props.row.files} maxLength={64 * 1024}
        onInput={event => patch({ files: event.currentTarget.value })} /></label></Show>
    <Show when={isMissionEventKind(kind()) && kind() !== "files-changed"}>
      <select aria-label={label("missions.scheduling.criterionSource")} {...invalid()} value={props.row.source}
        onChange={event => patch({ source: event.currentTarget.value })}>
        <option value="" selected={!props.row.source}>{t(choices() ? "missions.scheduling.chooseSource" : "missions.scheduling.sourcesUnavailable")}</option>
        <Show when={props.row.source && !choices()?.some(item => item.id === props.row.source)}>
          <option value={props.row.source} selected disabled>{t("missions.scheduling.sourceMissing", { source: props.row.source })}</option>
        </Show>
        <For each={choices()}>{item => <option value={item.id} selected={props.row.source === item.id}>{item.label}</option>}</For>
      </select>
    </Show>
  </div>
}
