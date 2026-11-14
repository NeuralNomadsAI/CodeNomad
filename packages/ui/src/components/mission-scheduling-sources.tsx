import { For, Show, createUniqueId } from "solid-js"
import { createSortable, transformStyle } from "@thisbeyond/solid-dnd"
import { GripVertical, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { MissionSourceSelect } from "./mission-source-select"
import { isMissionGithubKind, type MissionGithubKind } from "../../../server/src/missions/mission-github-condition"
import { MissionRepositoryFields } from "./mission-repository-fields"
import type { MissionRepositoryDiscovery } from "./mission-editor-repository"
import { isMissionEventKind, isRepositoryCriterion, missionEventKinds, missionHourSteps, missionScheduleShortcuts, type MissionConditionKind,
  type MissionCriterionDraft, type MissionCriterionKind } from "./mission-scheduling-data"

export type SelectedSource = Exclude<MissionConditionKind, "files-changed" | "repository-activity" | MissionGithubKind> | "coordinator-session"
export type MissionSourcePage = { next(): string | undefined; loading(): boolean; failed(): boolean; lookupFailed?(): boolean
  more(): void; retry(): void; search?(query: string): void }
/** Lists come from the owning authorized project. Absence is an unavailable read. */
export type MissionSchedulingSourceLists = Partial<Record<SelectedSource, readonly { id: string; label: string }[]>>

/** One "Launch when" criterion: a schedule shortcut writing a cron, or an event. The
 * `connector` to the card above (or / if / else) sits in the gap above it and moves with
 * it. The grip drags it (a sortable of the surrounding SortableProvider) or moves it with Alt+↑/↓. */
export function MissionSchedulingCriterion(props: { row: MissionCriterionDraft; number: number; sources: MissionSchedulingSourceLists
  repository?: MissionRepositoryDiscovery
  connector?: string; sortable: boolean; disabled?: boolean; paging?: (kind: SelectedSource, value?: string) => MissionSourcePage | undefined; errorText?: string
  onChange: (row: MissionCriterionDraft) => void; onRemove: () => void; onMove: (delta: -1 | 1) => void; errorID?: string }) {
  const { t, locale } = useI18n(), connectorID = createUniqueId(), sortable = createSortable(props.row.id)
  const patch = (change: Partial<MissionCriterionDraft>) => props.onChange({ ...props.row, ...change })
  const invalid = () => ({ "aria-invalid": !!props.errorID, "aria-describedby": props.errorID })
  const kind = () => props.row.kind
  const choices = () => props.sources[kind() as SelectedSource]
  const weekdays = () => new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" })
  const label = (key: string) => t(key, { number: props.number })
  const time = () => <label><span>{t("missions.scheduling.at")}</span>
    <input aria-label={label("missions.scheduling.criterionTime")} type="time" {...invalid()} value={props.row.time}
      onInput={event => patch({ time: event.currentTarget.value })} /></label>
  return <div ref={sortable.ref} class="mission-criterion-slot" classList={{ "mission-criterion-dragging": sortable.isActiveDraggable,
    "mission-criterion-drop": sortable.isActiveDroppable && !sortable.isActiveDraggable }} style={transformStyle(sortable.transform)} data-criterion={props.row.id}>
    {/* A fixed-height line in every card, so a connector appearing or disappearing while dragging never reflows. */}
    <div class="mission-criterion-gap"><Show when={props.connector}>{text => <span id={connectorID} class="mission-criterion-connector">{text()}</span>}</Show></div>
  <div class="mission-criterion" role="group" aria-label={label("missions.scheduling.criterion")} aria-describedby={props.connector ? connectorID : undefined}>
    <div class="mission-criterion-head">
      <button type="button" class="window-icon-button mission-criterion-grip" data-drag-handle disabled={!props.sortable}
        aria-label={label("missions.scheduling.dragHandle")} title={label("missions.scheduling.dragHandle")} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        {...(props.sortable ? sortable.dragActivators : {})}
        onKeyDown={event => {
          if (!event.altKey || event.key !== "ArrowUp" && event.key !== "ArrowDown") return
          event.preventDefault(); props.onMove(event.key === "ArrowUp" ? -1 : 1)
        }}><GripVertical class="h-4 w-4" aria-hidden="true" /></button>
      <select aria-label={label("missions.scheduling.criterionKind")} value={isRepositoryCriterion(kind()) ? "repository-activity" : kind()}
        onChange={event => patch({ kind: event.currentTarget.value === "repository-activity" ? "branch-commits" : event.currentTarget.value as MissionCriterionKind,
          source: "", author: undefined, repository: undefined, event: undefined })}>
        <optgroup label={t("missions.scheduling.group.schedule")}>
          <For each={missionScheduleShortcuts}>{value => <option value={value}>{t(value === "now" ? "missions.scheduling.source.now" : `missions.scheduling.shortcut.${value}`)}</option>}</For>
        </optgroup>
        <optgroup label={t("missions.scheduling.group.event")}>
          <option value="repository-activity">{t("missions.scheduling.condition.repository-activity")}</option>
          <For each={missionEventKinds.filter(value => !isRepositoryCriterion(value))}>{value => <option value={value}>{t(`missions.scheduling.condition.${value}`)}</option>}</For>
        </optgroup>
      </select>
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
    <Show when={isRepositoryCriterion(kind())}><MissionRepositoryFields row={props.row} number={props.number}
      discovery={props.repository} errorID={props.errorID} onChange={props.onChange} /></Show>
    <Show when={isMissionEventKind(kind()) && kind() !== "files-changed" && kind() !== "repository-activity" && !isMissionGithubKind(kind()) ? kind() as SelectedSource : undefined} keyed>{sourceKind =>
      <MissionSourceSelect label={label("missions.scheduling.criterionSource")} value={props.row.source} choices={choices()}
        disabled={props.disabled} errorID={props.errorID} paging={props.paging?.(sourceKind, props.row.source)} onChange={source => patch({ source })} />
    }</Show>
    <Show when={props.errorText}><p id={props.errorID} class="mission-create-field-error" role="alert">{props.errorText}</p></Show>
  </div>
  </div>
}
