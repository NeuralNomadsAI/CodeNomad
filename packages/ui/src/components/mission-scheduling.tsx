import { For, Index, Show, createEffect, createMemo, createUniqueId } from "solid-js"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { MissionSchedulingSources, type MissionSchedulingSourceLists } from "./mission-scheduling-sources"
import { missionFrequencies, missionSchedulingPolicy, previewMissionScheduling, MissionSchedulingError,
  newMissionSchedulingDraft, previewSavedMissionScheduling, type MissionSchedulingPhase, type MissionSchedulingDraft } from "./mission-scheduling-data"

export type MissionSchedulingLock = "uncertain" | "passage" | "launched-once" | "terminal" | "deleted" | "journal" | "scope"

/** Shared controlled scheduling fields. This component performs no reads or mutations. */
export function MissionScheduling(props: {
  draft: MissionSchedulingDraft; directory?: string; sources: MissionSchedulingSourceLists
  capability: "available" | "activatable" | "missing" | "loading"
  origin?: string | null
  lockReason?: MissionSchedulingLock | null; disabled?: boolean
  /** A frozen prospective Play instant, rather than a ticking browser clock. */
  anchorAt: number
  persisted?: MissionSchedulingPhase
  onChange: (draft: MissionSchedulingDraft) => void
  onPolicy: (policy: MissionLaunchPolicy | undefined) => void
}) {
  const { t, locale } = useI18n(), description = createUniqueId(), errorID = createUniqueId(), zoneList = createUniqueId()
  const zones = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? []
  let disclosure: HTMLDetailsElement | undefined
  const patch = (change: Partial<MissionSchedulingDraft>) => props.onChange({ ...props.draft, ...change })
  const retained = () => props.draft.stored?.reason
  const locked = () => !!props.disabled || !!props.lockReason || !!retained()
  const unavailable = () => props.capability === "missing" || props.capability === "loading"
  const result = createMemo(() => {
    try {
      const policy = missionSchedulingPolicy(props.draft, props.directory)
      if (props.capability === "loading" && (policy.timing.kind !== "immediate" || policy.condition)) return { error: undefined, policy: undefined, dates: undefined }
      if (unavailable() && (policy.timing.kind !== "immediate" || policy.condition)) return { error: "capability" }
      if (props.draft.condition !== "none" && props.draft.condition !== "files-changed"
        && !props.sources[props.draft.condition]?.some(item => item.id === props.draft.source)) return { error: "source" }
      if (["cron", "multi"].includes(policy.timing.kind) && !previewMissionScheduling({ ...policy,
        ends: { at: null, afterMs: null, maxLaunches: null } }, props.anchorAt).length) return { error: "empty" }
      const unchanged = !!props.draft.stored && JSON.stringify(policy.timing) === JSON.stringify(props.draft.stored.policy.timing)
      const phaseUnknown = !!props.persisted && unchanged && props.persisted.nextDueAt === null
        && (policy.timing.kind === "every" || policy.timing.kind === "immediate" && !!policy.condition)
      const dates = props.persisted ? previewSavedMissionScheduling(policy, props.persisted, props.anchorAt, unchanged)
        : previewMissionScheduling(policy, props.anchorAt)
      // A saved unknown phase or an intentionally exhausted quota is editable.
      // Other empty calendars share Create's validation, including impossible cron.
      const exhausted = !!props.persisted && policy.ends.maxLaunches !== null && policy.ends.maxLaunches <= props.persisted.launchedCount
      if (!dates.length && !phaseUnknown && !exhausted) return { error: "empty" }
      return { policy, dates, phaseUnknown }
    } catch (error) { return { error: error instanceof MissionSchedulingError ? error.field : "date" } }
  })
  createEffect(() => props.onPolicy(result().policy))
  createEffect(() => { if (result().error && disclosure) disclosure.open = true })
  const timed = () => ["daily", "weekly", "monthly", "multi"].includes(props.draft.frequency)
  const dated = () => props.draft.frequency !== "immediate" || props.draft.condition !== "none"
  const recurring = () => ["every", "daily", "weekly", "monthly", "multi", "cron"].includes(props.draft.frequency)
  const format = (at: number) => {
    try { return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: props.draft.zone }).format(at) }
    catch { return "—" }
  }
  const weekdays = () => new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" })
  const reason = () => props.lockReason ? t(`missions.scheduling.lock.${props.lockReason}`)
    : unavailable() ? t(`missions.scheduling.capability.${props.capability}`) : undefined
  const fieldError = (...fields: string[]) => ({ "aria-invalid": fields.includes(result().error ?? ""),
    "aria-describedby": fields.includes(result().error ?? "") ? errorID : undefined })
  return <details ref={disclosure} class="mission-scheduling mission-profile-optional">
    <summary>{t("missions.scheduling.title")} · {t(retained() ? "missions.scheduling.retained.title" : `missions.scheduling.frequency.${props.draft.frequency}`)}
      {" · "}{t(`missions.scheduling.condition.${props.draft.condition}`)}</summary>
    <Show when={reason()}>{text => <p id={description} role="status">{text()}</p>}</Show>
    <Show when={props.origin}>{origin => <p>{t("missions.settings.effectiveOrigin")} <code dir="ltr" title={origin()}>{origin()}</code></p>}</Show>
    <Show when={retained()}>{reason => <section aria-label={t("missions.scheduling.retained.title")}>
      <p role="status">{t(`missions.scheduling.retained.${reason()}`)}</p>
      <pre dir="ltr">{JSON.stringify(props.draft.stored!.policy, null, 2)}</pre>
      <button type="button" class="window-action" disabled={!!props.disabled || !!props.lockReason}
        onClick={() => props.onChange(newMissionSchedulingDraft(props.draft.zone))}>{t("missions.scheduling.retained.replace")}</button>
    </section>}</Show>
    <Show when={!retained()}><fieldset disabled={locked()} aria-describedby={[reason() ? description : "", result().error ? errorID : ""].filter(Boolean).join(" ") || undefined} aria-invalid={!!result().error}>
      <label><span>{t("missions.scheduling.frequency")}
        <SettingsInfoTip text={[t("missions.scheduling.paused"), props.capability === "activatable" ? t("missions.scheduling.capability.activatable") : "",
          dated() && !recurring() ? t("missions.scheduling.onceLimit") : ""].filter(Boolean).join(" ")} /></span>
        <select aria-label={t("missions.scheduling.frequency")} {...fieldError("empty", "capability")} value={props.draft.frequency} onChange={event => patch({ frequency: event.currentTarget.value as MissionSchedulingDraft["frequency"] })}>
          <For each={missionFrequencies}>{value => <option value={value} disabled={unavailable() && value !== "immediate"}>{t(`missions.scheduling.frequency.${value}`)}</option>}</For>
        </select>
      </label>
      <fieldset disabled={unavailable()}>
        <Show when={props.draft.frequency === "at"}><label>{t("missions.scheduling.date")}
          <input type="datetime-local" {...fieldError("date")} value={props.draft.date} onInput={event => patch({ date: event.currentTarget.value })} />
        </label></Show>
        <Show when={props.draft.frequency === "in" || props.draft.frequency === "every"}>
          <div class="mission-scheduling-row">
            <label><span>{t("missions.scheduling.amount")}<SettingsInfoTip text={t(props.draft.frequency === "in" ? "missions.scheduling.relative" : "missions.scheduling.interval")} /></span><input aria-label={t("missions.scheduling.amount")} type="number" min="1" step="1" {...fieldError("interval")} value={props.draft.amount} onInput={event => patch({ amount: event.currentTarget.value })} /></label>
            <label>{t("missions.scheduling.unit")}<select aria-label={t("missions.scheduling.unit")} value={props.draft.unit} onChange={event => patch({ unit: event.currentTarget.value as "minutes" | "hours" })}>
              <For each={["minutes", "hours"] as const}>{unit => <option value={unit}>{t(`missions.scheduling.${unit}`)}</option>}</For>
            </select></label>
          </div>
        </Show>
        <Show when={timed()}>
          <Index each={props.draft.frequency === "multi" ? props.draft.times : props.draft.times.slice(0, 1)}>{(time, index) =>
            <div class="mission-scheduling-row"><label><span>{t("missions.scheduling.time", { number: index + 1 })}
              <Show when={props.draft.frequency === "multi" && index === 0}><SettingsInfoTip text={t("missions.scheduling.multiHint")} /></Show></span>
              <input aria-label={t("missions.scheduling.time", { number: index + 1 })} type="time" {...fieldError("times")} value={time()} onInput={event => patch({ times: props.draft.times.map((value, item) => item === index ? event.currentTarget.value : value) })} />
            </label><Show when={props.draft.frequency === "multi" && props.draft.times.length > 1}>
              <button type="button" class="window-text-button" aria-label={t("missions.scheduling.removeTime", { number: index + 1 })}
                onClick={() => patch({ times: props.draft.times.filter((_, item) => item !== index) })}>{t("missions.scheduling.remove")}</button>
            </Show></div>
          }</Index>
          <Show when={props.draft.frequency === "multi"}><button type="button" class="window-action" disabled={props.draft.times.length >= 8}
            onClick={() => patch({ times: [...props.draft.times, "17:45"] })}>{t("missions.scheduling.addTime")}</button>
          </Show>
        </Show>
        <Show when={props.draft.frequency === "weekly"}><div class="mission-scheduling-days" role="group" aria-label={t("missions.scheduling.days")}>
          <For each={[1, 2, 3, 4, 5, 6, 0]}>{day => <label><input type="checkbox" {...fieldError("days")} checked={props.draft.days.includes(day)}
            onChange={event => patch({ days: event.currentTarget.checked ? [...props.draft.days, day] : props.draft.days.filter(value => value !== day) })} />
            {weekdays().format(Date.UTC(2026, 10, 1 + day))}</label>}</For>
        </div></Show>
        <Show when={props.draft.frequency === "monthly"}><label><span>{t("missions.scheduling.monthDay")}<SettingsInfoTip text={t("missions.scheduling.monthHint")} /></span><input aria-label={t("missions.scheduling.monthDay")} type="number" min="1" max="31" step="1" {...fieldError("monthDay")}
          value={props.draft.monthDay} onInput={event => patch({ monthDay: event.currentTarget.value })} /></label></Show>
        <Show when={props.draft.frequency === "cron"}><label><span>{t("missions.scheduling.cron")}<SettingsInfoTip text={t("missions.scheduling.cronHint")} /></span><input aria-label={t("missions.scheduling.cron")} maxLength={512} {...fieldError("cron")} value={props.draft.expression}
          onInput={event => patch({ expression: event.currentTarget.value })} /></label></Show>
        <MissionSchedulingSources draft={props.draft} sources={props.sources} onChange={patch} errorID={result().error === "source" ? errorID : undefined} />
        <Show when={dated()}>
          <label>{t("missions.scheduling.zone")}<input maxLength={100} value={props.draft.zone} list={zoneList}
            {...fieldError("zone")}
            onInput={event => patch({ zone: event.currentTarget.value })} /></label>
          <datalist id={zoneList}><For each={zones}>{zone => <option value={zone} />}</For></datalist>
          <label><span>{t("missions.scheduling.endAt")}<SettingsInfoTip text={t("missions.scheduling.endHint")} /></span><input aria-label={t("missions.scheduling.endAt")} type="datetime-local" {...fieldError("end")} value={props.draft.endAt} onInput={event => patch({ endAt: event.currentTarget.value })} /></label>
          <label><span>{t("missions.scheduling.endAfter")}<SettingsInfoTip text={t("missions.scheduling.endHint")} /></span><input aria-label={t("missions.scheduling.endAfter")} type="number" min="1" step="1" {...fieldError("end")} value={props.draft.endAfter} onInput={event => patch({ endAfter: event.currentTarget.value })} /></label>
          <Show when={recurring()}>
            <label><span>{t("missions.scheduling.maxLaunches")}<SettingsInfoTip text={t("missions.scheduling.quotaHint")} /></span><input aria-label={t("missions.scheduling.maxLaunches")} type="number" min="1" step="1" {...fieldError("end")} value={props.draft.maxLaunches}
              onInput={event => patch({ maxLaunches: event.currentTarget.value })} /></label>
          </Show>
        </Show>
      </fieldset>
    </fieldset></Show>
    <Show when={result().error}>{error => <p id={errorID} class="mission-create-field-error" role="alert">{t(`missions.scheduling.error.${error()}`)}</p>}</Show>
    <Show when={dated() && result().dates}>{dates => <section class="mission-scheduling-preview" aria-label={t("missions.scheduling.preview")}>
      <h4>{t(props.draft.condition === "none" ? "missions.scheduling.preview" : "missions.scheduling.checks")}
        <SettingsInfoTip text={t(props.persisted ? "missions.scheduling.savedPhase" : "missions.scheduling.anchor",
          { when: format(props.persisted?.firstPlayedAt ?? props.anchorAt), zone: props.draft.zone })} /></h4>
      <ol><For each={dates()}>{at => <li><time dateTime={new Date(at).toISOString()}>{format(at)}</time></li>}</For></ol>
      <Show when={!dates().length}><p role="status">{t(result().phaseUnknown ? "missions.scheduling.previewUnavailable" : "missions.scheduling.error.empty")}</p></Show>
    </section>}</Show>
  </details>
}
