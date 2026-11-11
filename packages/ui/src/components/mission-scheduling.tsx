import { For, Show, createEffect, createMemo, createSignal, createUniqueId } from "solid-js"
import { DragDropProvider, DragDropSensors, SortableProvider, closestCenter, type DragEventHandler } from "@thisbeyond/solid-dnd"
import { Plus } from "lucide-solid"
import type { MissionLaunchPolicy } from "../../../server/src/missions/launch-policy"
import { requiresMissionCalendar } from "../../../server/src/missions/mission-launch-kind"
import { isMissionGithubKind } from "../../../server/src/missions/mission-github-condition"
import { useI18n } from "../lib/i18n"
import { SettingsInfoTip } from "./settings/settings-info-tip"
import { MissionSchedulingCriterion, type MissionSchedulingSourceLists, type MissionSourcePage, type SelectedSource } from "./mission-scheduling-sources"
import { isMissionEventKind, missionCardConnectors, missionSchedulingPolicy, MissionSchedulingError, MISSION_CRITERIA_LIMIT, newMissionCriterion,
  newMissionSchedulingDraft, type MissionSchedulingDraft } from "./mission-scheduling-data"

export type MissionSchedulingLock = "uncertain" | "passage" | "launched-once" | "terminal" | "deleted" | "journal" | "scope"

/** Shared controlled scheduling fields. This component performs no reads or mutations. */
export function MissionScheduling(props: {
  draft: MissionSchedulingDraft; directory?: string; sources: MissionSchedulingSourceLists
  paging?: (kind: SelectedSource, value?: string) => MissionSourcePage | undefined
  capability: "available" | "activatable" | "missing" | "loading"
  active?: () => boolean
  lockReason?: MissionSchedulingLock | null; disabled?: boolean
  onChange: (draft: MissionSchedulingDraft) => void
  onPolicy: (policy: MissionLaunchPolicy | undefined) => void
}) {
  const { t } = useI18n(), description = createUniqueId(), errorID = createUniqueId(), zoneList = createUniqueId(), whenID = createUniqueId()
  const zones = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? []
  const patch = (change: Partial<MissionSchedulingDraft>) => props.onChange({ ...props.draft, ...change })
  const patchCriteria = (next: MissionSchedulingDraft["criteria"]) => patch({ criteria: next })
  const retained = () => props.draft.stored?.reason
  const locked = () => !!props.disabled || !!props.lockReason || !!retained() || props.active?.() === false
  const unavailable = () => props.capability === "missing" || props.capability === "loading"
  const criteria = () => props.draft.criteria
  const result = createMemo((): { error?: string; index?: number; policy?: MissionLaunchPolicy } => {
    try {
      const policy = missionSchedulingPolicy(props.draft, props.directory), calendar = requiresMissionCalendar(policy)
      if (props.capability === "loading" && calendar) return {}
      if (unavailable() && calendar) return { error: "capability" }
      const missing = criteria().findIndex(row => isMissionEventKind(row.kind) && row.kind !== "files-changed" && !isMissionGithubKind(row.kind)
        && !props.sources[row.kind]?.some(item => item.id === row.source))
      if (missing >= 0) return props.paging?.(criteria()[missing].kind as SelectedSource, criteria()[missing].source)?.loading() ? {} : { error: "source", index: missing }
      return { policy }
    } catch (error) {
      return error instanceof MissionSchedulingError ? { error: error.field, index: error.index } : { error: "empty" }
    }
  })
  createEffect(() => props.onPolicy(result().policy))
  const visibleError = createMemo(() => {
    const error = result(), row = error.index === undefined ? undefined : criteria()[error.index]
    if (error.error === "source" && row && !(row.kind === "files-changed" ? row.files.trim() : row.source.trim())) return undefined
    return error.error
  })
  const errorText = () => {
    if (!visibleError()) return undefined
    const row = result().index === undefined ? undefined : criteria()[result().index!]
    return t(visibleError() === "source" ? row?.kind === "files-changed" ? "missions.scheduling.error.files" : "missions.scheduling.chooseSource"
      : `missions.scheduling.error.${visibleError()}`)
  }
  const reason = () => props.lockReason ? t(`missions.scheduling.lock.${props.lockReason}`)
    : props.capability === "missing" && result().error !== "capability" ? t("missions.scheduling.capability.missing") : undefined
  const rowError = (index: number) => visibleError() && result().index === index ? errorID : undefined
  const ids = createMemo(() => criteria().map(row => row.id), undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) })
  // While dragging, the connectors follow the order the cards are shown in (the sortable's
  // projected order); the stored order changes only on drop.
  const [preview, setPreview] = createSignal<string[]>()
  const shown = createMemo(() => (preview() ?? ids()).map(id => criteria().find(row => row.id === id)!).filter(Boolean))
  const connectors = createMemo(() => missionCardConnectors(shown()))
  const connectorOf = (id: string) => {
    const position = shown().findIndex(row => row.id === id)
    return position > 0 ? t(`missions.scheduling.connector.${connectors()[position - 1]}`) : undefined
  }
  const roleText = (index: number) => index === 0 ? t("missions.scheduling.when")
    : t(`missions.scheduling.connector.${missionCardConnectors(criteria())[index - 1]}`)
  const [moved, setMoved] = createSignal("")
  let list: HTMLDivElement | undefined
  // Cards are keyed by id: a move reorders their nodes without remounting, the grip keeps
  // focus (restored if the browser drops it) and a live region announces the new place.
  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= criteria().length) return
    const next = [...criteria()], [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    patchCriteria(next)
    setMoved(t("missions.scheduling.moved", { position: String(to + 1), count: String(next.length), role: roleText(to) }))
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-criterion="${row.id}"] [data-drag-handle]`)?.focus())
  }
  const projected = (from: string, to: string) => {
    const next = [...ids()], [id] = next.splice(next.indexOf(from), 1)
    next.splice(ids().indexOf(to), 0, id)
    return next
  }
  const over: DragEventHandler = ({ draggable, droppable }) => setPreview(droppable ? projected(String(draggable.id), String(droppable.id)) : undefined)
  const dropped: DragEventHandler = ({ draggable, droppable }) => {
    setPreview(undefined)
    if (droppable) reorder(ids().indexOf(String(draggable.id)), ids().indexOf(String(droppable.id)))
  }
  // The saved zone defaults to the system zone and is shown only once it differs (a
  // schedule saved elsewhere, or an invalid zone); it then stays shown so typing never hides it.
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let zoneLatched = false
  const zoneShown = createMemo(() => zoneLatched ||= props.draft.zone !== systemZone || result().error === "zone")
  return <section class="mission-scheduling" aria-label={t("missions.scheduling.title")}>
    <h4 id={whenID}>{t("missions.scheduling.title")}
      <SettingsInfoTip text={t("missions.scheduling.whenHint")} help={{ page: "missions", anchor: "native-scheduling" }} />
    </h4>
    <Show when={reason()}>{text => <p id={description} role="status">{text()}</p>}</Show>
    <Show when={retained()}>{reason => <section aria-label={t("missions.scheduling.retained.title")}>
      <p role="status">{t(`missions.scheduling.retained.${reason()}`)}</p>
      <pre dir="ltr">{JSON.stringify(props.draft.stored!.policy, null, 2)}</pre>
      <button type="button" class="window-action" disabled={!!props.disabled || !!props.lockReason}
        onClick={() => props.onChange(newMissionSchedulingDraft(props.draft.zone))}>{t("missions.scheduling.retained.replace")}</button>
    </section>}</Show>
    <Show when={!retained()}>
      <fieldset disabled={locked()} aria-describedby={[reason() ? description : "", visibleError() ? errorID : ""].filter(Boolean).join(" ") || undefined} aria-invalid={!!visibleError()}>
      <div ref={list} class="mission-scheduling-when" role="group" aria-labelledby={whenID}>
        {/* Scheduling titles the list; each later card shows its connector to the card above. */}
        <DragDropProvider collisionDetector={closestCenter} onDragOver={over} onDragEnd={dropped}>
          <DragDropSensors>
            <SortableProvider ids={ids()}>
              <For each={ids()}>{(id, index) => {
                const row = () => criteria().find(item => item.id === id)!
                return <MissionSchedulingCriterion row={row()} number={index() + 1} sources={props.sources} errorID={rowError(index())}
                  errorText={rowError(index()) ? errorText() : undefined} paging={props.paging} disabled={locked()}
                  sortable={criteria().length > 1} connector={connectorOf(id)}
                  onChange={value => patchCriteria(criteria().map(item => item.id === id ? value : item))}
                  onMove={delta => reorder(index(), index() + delta)}
                  onRemove={() => patchCriteria(criteria().filter(item => item.id !== id))} />
              }}</For>
            </SortableProvider>
          </DragDropSensors>
        </DragDropProvider>
        <p class="sr-only" aria-live="polite">{moved()}</p>
        <button type="button" class="button-primary mission-scheduling-add" disabled={unavailable() || criteria().length >= MISSION_CRITERIA_LIMIT}
          onClick={() => patchCriteria([...criteria(), newMissionCriterion("daily", criteria())])}><Plus class="h-3.5 w-3.5" aria-hidden="true" />{t("missions.scheduling.addCriterion")}</button>
      </div>
      <Show when={criteria().length && zoneShown()}>
        <label>{t("missions.scheduling.zone")}<input maxLength={100} value={props.draft.zone} list={zoneList}
          aria-invalid={result().error === "zone"} aria-describedby={result().error === "zone" ? errorID : undefined}
          onInput={event => patch({ zone: event.currentTarget.value })} /></label>
        <datalist id={zoneList}><For each={zones}>{zone => <option value={zone} />}</For></datalist>
      </Show>
    </fieldset></Show>
    <Show when={visibleError() && result().index === undefined}><p id={errorID} class="mission-create-field-error" role="alert">{errorText()}</p></Show>
  </section>
}
