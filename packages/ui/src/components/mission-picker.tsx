import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ChevronRight, Flag, Plus, Repeat } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { filterMissionPickerEntries, type MissionPickerEntry } from "./mission-picker-model"

const describe = (entry: MissionPickerEntry) => `${entry.title} — ${entry.status}`

/** The Missions panel header: panel-wide actions (create, then the trailing
 * preferences/refresh), then the selection's toolbar, mounted into `actionSlot`
 * by `MissionActionBar` (the same buttons disabled while nothing mounts there),
 * followed by the mission filter. */
export function MissionPanelHeader(props: {
  onCreate: () => void; createDisabled: boolean
  /** The creation form replaces the selection line and the tree. */
  creating?: boolean
  trailing?: JSX.Element
  actionSlot: (element: HTMLElement) => void
  idleActions: JSX.Element
  query: string; onQuery: (query: string) => void; filterable: boolean
}) {
  const { t } = useI18n()
  return <div class="mission-picker">
    <div class="mission-picker-actions" role="toolbar" aria-label={t("missionsPanel.picker.actions")}>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.create")} title={t("missions.control.create")}
        disabled={props.createDisabled} onClick={() => props.onCreate()}><Plus class="h-4 w-4" aria-hidden="true" /></button>
      {props.trailing}
    </div>
    <div class="mission-picker-selection" hidden={props.creating}>
      <div class="mission-picker-selection-actions" ref={props.actionSlot} />
      <div class="mission-picker-idle-actions">{props.idleActions}</div>
      <Show when={props.filterable}>
        <input type="search" class="selector-search-input mission-picker-search" value={props.query}
          placeholder={t("missionsPanel.picker.search")} aria-label={t("missionsPanel.picker.search")}
          onInput={event => props.onQuery(event.currentTarget.value)} />
      </Show>
    </div>
  </div>
}

/** One row per Mission or schedule, like the session list: chevron, a flag (a
 * repeat icon for a schedule) coloured by its mark, then the title. The selection's
 * detail is the selected row's children; it is rendered once, at a fixed place
 * between the rows above and below the selection, so its controls survive a
 * selection change, and folding it only hides it. */
export function MissionRows(props: {
  entries: MissionPickerEntry[]; query: string; selectedKey?: string; onSelect: (entry: MissionPickerEntry) => void
  detail: JSX.Element; paging?: JSX.Element; hidden?: boolean
}) {
  const { t } = useI18n()
  const [folded, setFolded] = createSignal<string>()
  // The selected row stays listed whatever the filter, so its detail never vanishes.
  const shown = createMemo(() => {
    const matching = new Set(filterMissionPickerEntries(props.entries, props.query).map(entry => entry.key))
    return props.entries.filter(entry => matching.has(entry.key) || entry.key === props.selectedKey)
  })
  const byKey = createMemo(() => new Map(shown().map(entry => [entry.key, entry])))
  const position = () => shown().findIndex(entry => entry.key === props.selectedKey)
  const above = createMemo(() => (position() < 0 ? shown() : shown().slice(0, position())).map(entry => entry.key))
  const below = createMemo(() => position() < 0 ? [] : shown().slice(position() + 1).map(entry => entry.key))
  const selected = () => position() < 0 ? undefined : shown()[position()]
  const expanded = () => Boolean(selected()) && folded() !== props.selectedKey
  const row = (key: string) => <Show when={byKey().get(key)}>{entry => {
    const isSelected = () => key === props.selectedKey
    const open = () => isSelected() && expanded()
    const label = () => t(open() ? "missionsPanel.row.collapse" : "missionsPanel.row.expand")
    // The session list's own row classes (session-layout.css, session-tree.css).
    return <div class="session-list-item mission-row" data-mission-key={key}>
      <div class={`session-item-base ${isSelected() ? "session-item-active" : "session-item-inactive"}`}>
        <button type="button" class="session-item-expander opacity-80 hover:opacity-100 hover:bg-surface-hover" aria-expanded={open()}
          aria-label={label()} title={label()}
          onClick={() => { if (isSelected()) setFolded(open() ? key : undefined); else { setFolded(undefined); props.onSelect(entry()) } }}>
          <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="session-item-select mission-row-select" aria-current={isSelected() ? "true" : undefined} title={describe(entry())}
          onClick={() => { if (!isSelected()) setFolded(undefined); props.onSelect(entry()) }}>
          <Dynamic component={key.startsWith("mission:") ? Flag : Repeat} class="mission-row-flag w-4 h-4 flex-shrink-0" data-mark={entry().mark} aria-hidden="true" />
          <bdi class="session-item-title session-item-title--clamp">{entry().title}</bdi><span class="sr-only">{entry().status}</span>
        </button>
      </div>
    </div>
  }}</Show>
  return <div class="mission-rows" hidden={props.hidden}>
    <ul aria-label={t("missions.control.mapLabel")}>
      <For each={above()}>{key => <li>{row(key)}</li>}</For>
      {/* Without a selection it holds only the detail's list-level notices. */}
      <li class="mission-rows-selection">
        <Show when={selected()?.key} keyed>{key => row(key)}</Show>
        <div class="mission-row-children" hidden={Boolean(selected()) && !expanded()}>{props.detail}</div>
      </li>
      <For each={below()}>{key => <li>{row(key)}</li>}</For>
    </ul>
    <Show when={props.entries.length > 0 && shown().length === 0}>
      <p class="mission-picker-empty">{t("missionsPanel.picker.noMatch")}</p>
    </Show>
    {props.paging}
  </div>
}
