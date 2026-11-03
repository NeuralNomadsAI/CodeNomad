import { For, Index, Show, createEffect, createMemo, createUniqueId } from "solid-js"
import { Plus } from "lucide-solid"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { SettingsInfoLink } from "./settings/settings-info-link"
import { openSettingsRow } from "../stores/settings-screen"
import { MissionSchedulingCriterion, type MissionSchedulingSourceLists } from "./mission-scheduling-sources"
import { isMissionEventKind, missionSchedulingPolicy, previewMissionScheduling, MissionSchedulingError, MISSION_CRITERIA_LIMIT,
  newMissionCriterion, newMissionSchedulingDraft, previewSavedMissionScheduling, type MissionSchedulingPhase,
  type MissionSchedulingDraft } from "./mission-scheduling-data"

export type MissionSchedulingLock = "uncertain" | "passage" | "launched-once" | "terminal" | "deleted" | "journal" | "scope"

/** Shared controlled scheduling fields. This component performs no reads or mutations. */
export function MissionScheduling(props: {
  draft: MissionSchedulingDraft; directory?: string; sources: MissionSchedulingSourceLists
  capability: "available" | "activatable" | "missing" | "loading"
  lockReason?: MissionSchedulingLock | null; disabled?: boolean
  /** A frozen prospective Play instant, rather than a ticking browser clock. */
  anchorAt: number
  persisted?: MissionSchedulingPhase
  onChange: (draft: MissionSchedulingDraft) => void
  onPolicy: (policy: MissionLaunchPolicy | undefined) => void
}) {
  const { t, locale } = useI18n(), description = createUniqueId(), errorID = createUniqueId(), zoneList = createUniqueId(), whenID = createUniqueId()
  const zones = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? []
  let disclosure: HTMLDetailsElement | undefined
  const patch = (change: Partial<MissionSchedulingDraft>) => props.onChange({ ...props.draft, ...change })
  // A list that loses its last schedule or event also drops only-with-news, so
  // adding one back never silently re-enables it.
  const patchCriteria = (next: MissionSchedulingDraft["criteria"]) => patch({ criteria: next, onlyWithNews: props.draft.onlyWithNews
    && next.some(row => !isMissionEventKind(row.kind)) && next.some(row => isMissionEventKind(row.kind)) })
  const retained = () => props.draft.stored?.reason
  const locked = () => !!props.disabled || !!props.lockReason || !!retained()
  const unavailable = () => props.capability === "missing" || props.capability === "loading"
  const criteria = () => props.draft.criteria
  const scheduled = () => criteria().some(row => !isMissionEventKind(row.kind))
  const evented = () => criteria().some(row => isMissionEventKind(row.kind))
  const result = createMemo(() => {
    try {
      const policy = missionSchedulingPolicy(props.draft, props.directory), model = missionLaunchModel(policy)
      const calendar = model.schedules.length > 0 || model.events.length > 0
      if (props.capability === "loading" && calendar) return { error: undefined, policy: undefined, dates: undefined }
      if (unavailable() && calendar) return { error: "capability" }
      const missing = criteria().findIndex(row => isMissionEventKind(row.kind) && row.kind !== "files-changed"
        && !props.sources[row.kind]?.some(item => item.id === row.source))
      if (missing >= 0) return { error: "source", index: missing }
      if (!model.schedules.length) return model.until !== null && model.until <= props.anchorAt ? { error: "until" } : { policy, dates: [] as number[] }
      const unchanged = !!props.draft.stored && JSON.stringify(model.schedules) === JSON.stringify(missionLaunchModel(props.draft.stored.policy).schedules)
      const phaseUnknown = !!props.persisted && unchanged && props.persisted.nextDueAt === null && model.schedules.some(item => item.kind === "every")
      const dates = props.persisted ? previewSavedMissionScheduling(policy, props.persisted, props.anchorAt, unchanged)
        : previewMissionScheduling(policy, props.anchorAt)
      // A saved unknown phase or an intentionally exhausted quota is editable.
      // Other empty calendars share Create's validation, including impossible cron.
      const exhausted = !!props.persisted && model.maxLaunches !== null && model.maxLaunches <= props.persisted.launchedCount
      if (!dates.length && !phaseUnknown && !exhausted) return { error: "empty" }
      return { policy, dates, phaseUnknown }
    } catch (error) {
      return error instanceof MissionSchedulingError ? { error: error.field, index: error.index } : { error: "empty" }
    }
  })
  createEffect(() => props.onPolicy(result().policy))
  createEffect(() => { if (result().error && disclosure) disclosure.open = true })
  const format = (at: number) => {
    try { return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: props.draft.zone }).format(at) }
    catch { return "—" }
  }
  const reason = () => props.lockReason ? t(`missions.scheduling.lock.${props.lockReason}`)
    : unavailable() ? t(`missions.scheduling.capability.${props.capability}`) : undefined
  const fieldError = (...fields: string[]) => ({ "aria-invalid": fields.includes(result().error ?? ""),
    "aria-describedby": fields.includes(result().error ?? "") ? errorID : undefined })
  const rowError = (index: number) => result().index === index ? errorID : undefined
  const whenHint = () => [t("missions.scheduling.whenHint"), t("missions.scheduling.paused"),
    props.capability === "activatable" ? t("missions.scheduling.capability.activatable") : "", t("missions.scheduling.runtimeHint")].filter(Boolean).join(" ")
  // The saved zone defaults to the system zone and is shown only once it differs (a
  // schedule saved elsewhere, or an invalid zone); it then stays shown so typing never hides it.
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let zoneLatched = false
  const zoneShown = createMemo(() => zoneLatched ||= props.draft.zone !== systemZone || result().error === "zone")
  const summary = () => retained() ? t("missions.scheduling.retained.title") : !criteria().length ? t("missions.scheduling.once")
    : t(criteria().length === 1 ? "missions.scheduling.criteria.one" : "missions.scheduling.criteria.other", { count: String(criteria().length) })
  return <details ref={disclosure} class="mission-scheduling mission-profile-optional">
    <summary>{t("missions.scheduling.title")} · {summary()}</summary>
    <Show when={reason()}>{text => <p id={description} role="status">{text()}</p>}</Show>
    <Show when={retained()}>{reason => <section aria-label={t("missions.scheduling.retained.title")}>
      <p role="status">{t(`missions.scheduling.retained.${reason()}`)}</p>
      <pre dir="ltr">{JSON.stringify(props.draft.stored!.policy, null, 2)}</pre>
      <button type="button" class="window-action" disabled={!!props.disabled || !!props.lockReason}
        onClick={() => props.onChange(newMissionSchedulingDraft(props.draft.zone))}>{t("missions.scheduling.retained.replace")}</button>
    </section>}</Show>
    <Show when={!retained()}>
      {/* Outside the fieldset: the information and its link stay available while editing is locked. */}
      <div class="mission-scheduling-when-head">
        <span id={whenID} class="mission-scheduling-label">{t("missions.scheduling.when")}</span>
        {/* One "i" ending with a link only: Missions never reads or changes this independent setting. */}
        <SettingsInfoLink title={t("missions.scheduling.when")} text={whenHint()} link={t("settings.supervision.title")}
          onLink={() => void openSettingsRow("opencode", "service-supervision")} />
      </div>
      <fieldset disabled={locked()} aria-describedby={[reason() ? description : "", result().error ? errorID : ""].filter(Boolean).join(" ") || undefined} aria-invalid={!!result().error}>
      <div class="mission-scheduling-when" role="group" aria-labelledby={whenID}>
        <Index each={criteria()}>{(row, index) => <MissionSchedulingCriterion row={row()} number={index + 1} sources={props.sources}
          errorID={rowError(index)}
          onChange={value => patchCriteria(criteria().map((item, position) => position === index ? value : item))}
          onRemove={() => patchCriteria(criteria().filter((_, position) => position !== index))} />}</Index>
        <button type="button" class="window-action mission-scheduling-add" disabled={unavailable() || criteria().length >= MISSION_CRITERIA_LIMIT}
          onClick={() => patchCriteria([...criteria(), newMissionCriterion("daily", criteria())])}><Plus class="h-3.5 w-3.5" aria-hidden="true" />{t("missions.scheduling.addCriterion")}</button>
      </div>
      <Show when={criteria().length}>
        <label class="mission-scheduling-check"><input type="checkbox" aria-label={t("missions.scheduling.onlyWithNews")}
          checked={props.draft.onlyWithNews && scheduled() && evented()}
          disabled={!scheduled() || !evented()} onChange={event => patch({ onlyWithNews: event.currentTarget.checked })} />
          <span>{t("missions.scheduling.onlyWithNews")}<SettingsInfoTip text={t("missions.scheduling.onlyWithNewsHint")} /></span></label>
        <div class="mission-scheduling-row">
          <label><span>{t("missions.scheduling.until")}<SettingsInfoTip text={t("missions.scheduling.untilHint")} /></span>
            <input aria-label={t("missions.scheduling.until")} type="datetime-local" {...fieldError("until")} value={props.draft.until}
              onInput={event => patch({ until: event.currentTarget.value })} /></label>
          <Show when={zoneShown()}><label>{t("missions.scheduling.zone")}<input maxLength={100} value={props.draft.zone} list={zoneList} {...fieldError("zone")}
            onInput={event => patch({ zone: event.currentTarget.value })} /></label></Show>
        </div>
        <Show when={zoneShown()}><datalist id={zoneList}><For each={zones}>{zone => <option value={zone} />}</For></datalist></Show>
      </Show>
    </fieldset></Show>
    <Show when={result().error}>{error => <p id={errorID} class="mission-create-field-error" role="alert">{t(`missions.scheduling.error.${error()}`)}</p>}</Show>
    <Show when={result().dates?.length || result().phaseUnknown ? result().dates : undefined}>{dates => <section class="mission-scheduling-preview" aria-label={t("missions.scheduling.preview")}>
      <h4>{t(props.draft.onlyWithNews && evented() ? "missions.scheduling.checks" : "missions.scheduling.preview")}
        <SettingsInfoTip text={t(props.persisted ? "missions.scheduling.savedPhase" : "missions.scheduling.anchor",
          { when: format(props.persisted?.firstPlayedAt ?? props.anchorAt), zone: props.draft.zone })} /></h4>
      <ol><For each={dates()}>{at => <li><time dateTime={new Date(at).toISOString()}>{format(at)}</time></li>}</For></ol>
      <Show when={!dates().length}><p role="status">{t("missions.scheduling.previewUnavailable")}</p></Show>
    </section>}</Show>
  </details>
}
