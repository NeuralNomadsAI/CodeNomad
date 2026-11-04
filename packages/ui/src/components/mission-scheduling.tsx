import { For, Index, Show, createEffect, createMemo, createUniqueId } from "solid-js"
import { Plus } from "lucide-solid"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { missionLaunchModel } from "../../../server/src/missions/mission-launch-kind"
import { useI18n } from "../lib/i18n"
import { SettingsInfoLink } from "./settings/settings-info-link"
import { openSettingsRow } from "../stores/settings-screen"
import { MissionSchedulingCriterion, type MissionSchedulingSourceLists } from "./mission-scheduling-sources"
import { isMissionEventKind, missionSchedulingPolicy, MissionSchedulingError, MISSION_CRITERIA_LIMIT, newMissionCriterion,
  newMissionSchedulingDraft, type MissionSchedulingDraft } from "./mission-scheduling-data"

export type MissionSchedulingLock = "uncertain" | "passage" | "launched-once" | "terminal" | "deleted" | "journal" | "scope"

/** Shared controlled scheduling fields. This component performs no reads or mutations. */
export function MissionScheduling(props: {
  draft: MissionSchedulingDraft; directory?: string; sources: MissionSchedulingSourceLists
  capability: "available" | "activatable" | "missing" | "loading"
  lockReason?: MissionSchedulingLock | null; disabled?: boolean
  onChange: (draft: MissionSchedulingDraft) => void
  onPolicy: (policy: MissionLaunchPolicy | undefined) => void
}) {
  const { t } = useI18n(), description = createUniqueId(), errorID = createUniqueId(), zoneList = createUniqueId(), whenID = createUniqueId()
  const zones = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? []
  let disclosure: HTMLDetailsElement | undefined
  const patch = (change: Partial<MissionSchedulingDraft>) => props.onChange({ ...props.draft, ...change })
  const patchCriteria = (next: MissionSchedulingDraft["criteria"]) => patch({ criteria: next })
  const retained = () => props.draft.stored?.reason
  const locked = () => !!props.disabled || !!props.lockReason || !!retained()
  const unavailable = () => props.capability === "missing" || props.capability === "loading"
  const criteria = () => props.draft.criteria
  const result = createMemo((): { error?: string; index?: number; policy?: MissionLaunchPolicy } => {
    try {
      const policy = missionSchedulingPolicy(props.draft, props.directory), model = missionLaunchModel(policy)
      const calendar = model.schedules.length > 0 || model.events.length > 0
      if (props.capability === "loading" && calendar) return {}
      if (unavailable() && calendar) return { error: "capability" }
      const missing = criteria().findIndex(row => isMissionEventKind(row.kind) && row.kind !== "files-changed"
        && !props.sources[row.kind]?.some(item => item.id === row.source))
      if (missing >= 0) return { error: "source", index: missing }
      return { policy }
    } catch (error) {
      return error instanceof MissionSchedulingError ? { error: error.field, index: error.index } : { error: "empty" }
    }
  })
  createEffect(() => props.onPolicy(result().policy))
  createEffect(() => { if (result().error && disclosure) disclosure.open = true })
  const reason = () => props.lockReason ? t(`missions.scheduling.lock.${props.lockReason}`)
    : unavailable() ? t(`missions.scheduling.capability.${props.capability}`) : undefined
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
      <Show when={criteria().length && zoneShown()}>
        <label>{t("missions.scheduling.zone")}<input maxLength={100} value={props.draft.zone} list={zoneList}
          aria-invalid={result().error === "zone"} aria-describedby={result().error === "zone" ? errorID : undefined}
          onInput={event => patch({ zone: event.currentTarget.value })} /></label>
        <datalist id={zoneList}><For each={zones}>{zone => <option value={zone} />}</For></datalist>
      </Show>
    </fieldset></Show>
    <Show when={result().error}>{error => <p id={errorID} class="mission-create-field-error" role="alert">{t(`missions.scheduling.error.${error()}`)}</p>}</Show>
  </details>
}
