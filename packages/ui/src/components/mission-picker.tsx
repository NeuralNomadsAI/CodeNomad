import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js"
import { ChevronRight, Plus } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { filterMissionPickerEntries, missionPickerAttention, missionPickerAttentionLabel, type MissionPickerEntry } from "./mission-picker-model"

interface ListApi { key: (event: KeyboardEvent) => boolean; focusSearch: () => boolean; activeId: () => string | undefined }

const describe = (entry: MissionPickerEntry) => `${entry.title} — ${entry.status}`
/** Keys confirming or navigating an IME composition belong to the text field. */
const composing = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229

function Mark(props: { entry: MissionPickerEntry }) {
  return <span class="mission-picker-mark" data-mark={props.entry.mark} aria-hidden="true" />
}

/** Titles with a status mark; the search appears only while the rendered list
 * overflows its bounded height, or still holds a query. */
function MissionPickerList(props: {
  id: string; label: string; entries: MissionPickerEntry[]; selectedKey?: string; popup?: boolean
  onSelect: (entry: MissionPickerEntry) => void; bind?: (api: ListApi) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const [overflowing, setOverflowing] = createSignal(false)
  const filtered = createMemo(() => filterMissionPickerEntries(props.entries, query()))
  const [active, setActive] = createSignal(Math.max(0, filtered().findIndex(entry => entry.key === props.selectedKey)))
  const optionId = (index: number) => `${props.id}-option-${index}`
  const activeId = () => props.popup && filtered()[active()] ? optionId(active()) : undefined
  let scroller!: HTMLUListElement, search: HTMLInputElement | undefined
  createEffect(() => { if (active() >= filtered().length) setActive(0) })
  createEffect(() => {
    let frame = 0
    const measure = () => { frame = 0; if (scroller.isConnected) setOverflowing(scroller.scrollHeight > scroller.clientHeight + 1) }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    const mutation = new MutationObserver(schedule)
    mutation.observe(scroller, { childList: true, characterData: true, subtree: true })
    schedule()
    onCleanup(() => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect() })
  })
  createEffect(() => { const id = activeId(); if (id) document.getElementById(id)?.scrollIntoView({ block: "nearest" }) })
  const key = (event: KeyboardEvent) => {
    if (composing(event)) return false
    const count = filtered().length
    const move = (index: number) => { event.preventDefault(); setActive(Math.min(Math.max(index, 0), Math.max(count - 1, 0))) }
    if (event.key === "ArrowDown") move(active() + 1)
    else if (event.key === "ArrowUp") move(active() - 1)
    else if (event.key === "Home") move(0)
    else if (event.key === "End") move(count - 1)
    else if (event.key === "Enter" || (event.key === " " && event.target !== search)) {
      event.preventDefault()
      const entry = filtered()[active()]
      if (entry) props.onSelect(entry)
    } else return false
    return true
  }
  props.bind?.({ key, activeId, focusSearch: () => { if (!search) return false; search.focus(); return true } })
  const searchVisible = () => overflowing() || query().length > 0
  return <div class="mission-picker-list">
    <Show when={searchVisible()}>
      <input ref={search} type="search" class="selector-search-input mission-picker-search" value={query()}
        placeholder={t("missionsPanel.picker.search")} aria-label={t("missionsPanel.picker.search")} aria-controls={props.id}
        aria-activedescendant={activeId()} onInput={event => setQuery(event.currentTarget.value)}
        onKeyDown={event => { if (props.popup) key(event) }} />
    </Show>
    <ul ref={scroller} id={props.id} class="mission-picker-options" role={props.popup ? "listbox" : undefined} aria-label={props.label}>
      <For each={filtered()} fallback={<li class="mission-picker-empty" role={props.popup ? "presentation" : undefined}>{t("missionsPanel.picker.noMatch")}</li>}>
        {(entry, index) => <Show when={props.popup} fallback={<li>
          <button type="button" class="mission-picker-option" classList={{ "mission-picker-option-selected": entry.key === props.selectedKey }}
            aria-current={entry.key === props.selectedKey ? "true" : undefined} title={describe(entry)} onClick={() => props.onSelect(entry)}>
            <Mark entry={entry} /><bdi class="mission-picker-title">{entry.title}</bdi><span class="sr-only">{entry.status}</span>
          </button></li>}>
          <li id={optionId(index())} role="option" class="mission-picker-option" aria-selected={entry.key === props.selectedKey}
            classList={{ "mission-picker-option-selected": entry.key === props.selectedKey, "mission-picker-option-active": index() === active() }}
            title={describe(entry)} onPointerDown={event => { if (event.target !== search) event.preventDefault() }}
            onPointerMove={() => setActive(index())} onClick={() => props.onSelect(entry)}>
            <Mark entry={entry} /><bdi class="mission-picker-title">{entry.title}</bdi><span class="sr-only">{entry.status}</span>
          </li>
        </Show>}
      </For>
    </ul>
  </div>
}

/** A right-aligned toolbar of general actions (create, then the trailing
 * settings/refresh) above the
 * "current mission" line: chevron (persistent inline list) and the selected
 * title (transient popup listbox). */
export function MissionPicker(props: {
  entries: MissionPickerEntry[]; selectedKey?: string; onSelect: (entry: MissionPickerEntry) => void
  expanded: boolean; onExpandedChange: (expanded: boolean) => void
  onCreate: () => void; createDisabled: boolean
  trailing?: JSX.Element
}) {
  const { t } = useI18n()
  const inlineId = createUniqueId(), popupId = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [api, setApi] = createSignal<ListApi>()
  let root!: HTMLDivElement, field!: HTMLButtonElement
  const selected = () => props.entries.find(entry => entry.key === props.selectedKey)
  const attention = createMemo(() => missionPickerAttention(props.entries, props.selectedKey))
  const expanderLabel = () => {
    const action = t(props.expanded ? "missionsPanel.picker.collapse" : "missionsPanel.picker.expand")
    const activity = missionPickerAttentionLabel(t, attention().counts)
    return activity ? t("missionsPanel.picker.withAttention", { action, attention: activity }) : action
  }
  const close = (focus: boolean) => { setOpen(false); setApi(undefined); if (focus) field.focus({ preventScroll: true }) }
  const choose = (entry: MissionPickerEntry, popup: boolean) => { props.onSelect(entry); if (popup) close(true) }
  createEffect(() => {
    if (!open()) return
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) close(false) }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })
  createEffect(() => { if (props.entries.length === 0 && open()) close(false) })
  const onFieldKey = (event: KeyboardEvent) => {
    if (composing(event)) return
    if (!open()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true) }
      // Like a select, Space opens; its native keyup click stays suppressed (below)
      // so it cannot toggle the popup again. Enter keeps the native button click.
      else if (event.key === " ") { event.preventDefault(); if (!event.repeat) setOpen(true) }
      return
    }
    if (event.key === "Escape") { event.preventDefault(); close(true); return }
    if (api()?.key(event)) return
    // Printable keys go to the filter when the list shows one.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) api()?.focusSearch()
  }
  return <div ref={root} class="mission-picker" onFocusOut={event => {
    if (open() && !root.contains(event.relatedTarget as Node | null)) close(false)
  }} onKeyDown={event => { if (open() && event.key === "Escape" && !composing(event)) { event.preventDefault(); close(true) } }}>
    <div class="mission-picker-actions" role="toolbar" aria-label={t("missionsPanel.picker.actions")}>
      <button type="button" class="mission-control-icon-button" aria-label={t("missions.control.create")} title={t("missions.control.create")}
        disabled={props.createDisabled} onClick={() => props.onCreate()}><Plus class="h-4 w-4" aria-hidden="true" /></button>
      {props.trailing}
    </div>
    <div class="mission-picker-control">
      <button type="button" class="mission-picker-expander" aria-expanded={props.expanded}
        aria-controls={props.expanded ? inlineId : undefined} aria-label={expanderLabel()} title={expanderLabel()}
        data-attention={attention().kind} disabled={props.entries.length === 0 && !props.expanded}
        onClick={() => props.onExpandedChange(!props.expanded)}>
        <ChevronRight class="disclosure-chevron h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <button ref={field} type="button" role="combobox" class="mission-picker-field" aria-haspopup="listbox"
        aria-expanded={open()} aria-controls={open() ? popupId : undefined} aria-activedescendant={open() ? api()?.activeId() : undefined}
        aria-label={t("missionsPanel.picker.label")} title={selected() ? describe(selected()!) : t("missionsPanel.picker.none")}
        disabled={props.entries.length === 0} onClick={() => open() ? close(false) : setOpen(true)} onKeyDown={onFieldKey}
        onKeyUp={event => { if (event.key === " ") event.preventDefault() }}>
        <Show when={selected()} fallback={<span class="mission-picker-placeholder">{t("missionsPanel.picker.none")}</span>}>
          {entry => <><Mark entry={entry()} /><bdi class="mission-picker-title">{entry().title}</bdi>
            <span class="sr-only">{entry().status}</span></>}
        </Show>
      </button>
      <Show when={open()}>
        <div class="mission-picker-popup">
          <MissionPickerList id={popupId} popup label={t("missions.control.mapLabel")} entries={props.entries}
            selectedKey={props.selectedKey} onSelect={entry => choose(entry, true)} bind={setApi} />
        </div>
      </Show>
    </div>
    <Show when={props.expanded && props.entries.length > 0}>
      <div class="mission-picker-inline">
        <MissionPickerList id={inlineId} label={t("missions.control.mapLabel")} entries={props.entries}
          selectedKey={props.selectedKey} onSelect={entry => choose(entry, false)} />
      </div>
    </Show>
  </div>
}
