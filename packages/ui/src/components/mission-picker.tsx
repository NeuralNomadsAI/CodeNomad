import { For, Show, createComputed, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
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
 * repeat icon for a schedule) coloured by its mark, then the title. Rows are keyed,
 * so selection changes and reordering refreshes never recreate them (focus stays).
 * The selection's detail is the selected row's children: it is rendered once and
 * moved, whole, into the selected row's item, so its controls survive a selection
 * change; folding it only hides it. */
export function MissionRows(props: {
  entries: MissionPickerEntry[]; query: string; selectedKey?: string; onSelect: (entry: MissionPickerEntry) => void
  detail: JSX.Element; paging?: JSX.Element; hidden?: boolean
  /** An unselected row this returns content for expands from its chevron without
   * being selected (a one-time Mission's tasks, read on demand); others select. */
  preview?: (key: string) => JSX.Element | undefined; expandable?: (key: string) => boolean
  /** Receives the command unfolding the selection's detail (for a toolbar action that
   * opens content inside it, such as the brief name field). */
  revealDetail?: (reveal: () => void) => void
}) {
  const { t } = useI18n()
  const [folded, setFolded] = createSignal<string>()
  props.revealDetail?.(() => setFolded(undefined))
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
  const toggleOpened = (key: string) => setOpened(previous => {
    const next = new Set(previous)
    if (!next.delete(key)) next.add(key)
    return next
  })
  // The selected row stays listed whatever the filter, so its detail never vanishes.
  const shown = createMemo(() => {
    const matching = new Set(filterMissionPickerEntries(props.entries, props.query).map(entry => entry.key))
    return props.entries.filter(entry => matching.has(entry.key) || entry.key === props.selectedKey)
  })
  const keys = createMemo(() => shown().map(entry => entry.key))
  const byKey = createMemo(() => new Map(shown().map(entry => [entry.key, entry])))
  const selected = () => props.selectedKey !== undefined ? byKey().get(props.selectedKey) : undefined
  const expanded = () => Boolean(selected()) && folded() !== props.selectedKey
  const items = new Map<string, HTMLLIElement>()
  let list: HTMLUListElement | undefined, rest!: HTMLDivElement
  // Moving a row's item to reorder it blurs a focused control inside: captured
  // before the rows update, it gets focus back once they have moved.
  let moving: HTMLElement | undefined
  createComputed(() => {
    keys()
    const active = document.activeElement
    moving = list && active instanceof HTMLElement && list.contains(active) ? active : undefined
  })
  createEffect(() => {
    keys()
    const control = moving
    moving = undefined
    if (control?.isConnected && document.activeElement !== control && (!document.activeElement || document.activeElement === document.body)) control.focus({ preventScroll: true })
  })
  // Created once; without a selection it holds only the detail's list-level notices, after the rows.
  const detail = <div class="mission-row-children">{props.detail}</div> as HTMLDivElement
  createEffect(() => {
    const item = selected() ? items.get(selected()!.key) : undefined
    keys()
    const host = item ?? rest
    if (detail.parentElement !== host) host.append(detail)
    detail.hidden = Boolean(item) && !expanded()
  })
  const select = (entry: MissionPickerEntry) => { setFolded(undefined); props.onSelect(entry) }
  const row = (key: string) => <Show when={byKey().get(key)}>{entry => {
    const isSelected = () => key === props.selectedKey
    const previewing = () => !isSelected() && opened().has(key)
    const open = () => isSelected() ? expanded() : previewing()
    const label = () => t(open() ? "missionsPanel.row.collapse" : "missionsPanel.row.expand")
    // The session list's own row classes (session-layout.css, session-tree.css).
    return <><div class="session-list-item mission-row" data-mission-key={key}>
      <div class={`session-item-base ${isSelected() ? "session-item-active" : "session-item-inactive"}`}>
        <button type="button" class="session-item-expander opacity-80 hover:opacity-100 hover:bg-surface-hover" aria-expanded={open()}
          data-child-activity={entry().childActivity}
          aria-label={label()} title={label()}
          onClick={() => {
            if (isSelected()) setFolded(open() ? key : undefined)
            else if (props.expandable?.(key)) toggleOpened(key)
            else select(entry())
          }}>
          <ChevronRight class="disclosure-chevron w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button type="button" class="session-item-select mission-row-select" aria-current={isSelected() ? "true" : undefined} title={describe(entry())}
          onClick={() => { if (!isSelected()) select(entry()); else props.onSelect(entry()) }}>
          <Dynamic component={key.startsWith("mission:") ? Flag : Repeat} class="mission-row-flag w-4 h-4 flex-shrink-0" data-mark={entry().mark} aria-hidden="true" />
          <bdi class="session-item-title session-item-title--clamp">{entry().title}</bdi><span class="sr-only">{entry().status}</span>
        </button>
      </div>
    </div>
    <Show when={previewing()}><div class="mission-row-children">{props.preview?.(key)}</div></Show></>
  }}</Show>
  return <div class="mission-rows" hidden={props.hidden}>
    <ul ref={list} aria-label={t("missions.control.mapLabel")}>
      <For each={keys()}>{key => <li ref={item => { items.set(key, item); onCleanup(() => { if (items.get(key) === item) items.delete(key) }) }}>{row(key)}</li>}</For>
    </ul>
    <div ref={rest} />
    <Show when={props.entries.length > 0 && shown().length === 0}>
      <p class="mission-picker-empty">{t("missionsPanel.picker.noMatch")}</p>
    </Show>
    {props.paging}
  </div>
}
