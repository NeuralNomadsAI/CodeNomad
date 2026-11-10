import { Combobox } from "@kobalte/core/combobox"
import { ChevronDown } from "lucide-solid"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from "solid-js"
import { useI18n } from "../lib/i18n"
import { observeListEnd } from "../lib/list-end-observer"
import type { MissionSourcePage } from "./mission-scheduling-sources"

type Choice = { id: string; label: string; unavailable?: boolean }

/** Source discovery stays inside its criterion's transient selector. */
export function MissionSourceSelect(props: {
  label: string; value: string; choices?: readonly Choice[]; paging?: MissionSourcePage
  disabled?: boolean; errorID?: string; onChange: (id: string) => void
}) {
  const { t } = useI18n()
  const valueID = createUniqueId()
  const [open, setOpen] = createSignal(false), [list, setList] = createSignal<HTMLElement>(), [end, setEnd] = createSignal<HTMLElement>()
  const [query, setQuery] = createSignal("")
  const [openSelection, setOpenSelection] = createSignal<Choice | null>(null)
  let virtualizer: VirtualizerHandle | undefined, itemKeys: string[] = []
  let pointerNavigation = false
  let input: HTMLInputElement | undefined, retry: HTMLButtonElement | undefined, more: HTMLButtonElement | undefined
  const options = createMemo(() => props.value && !props.choices?.some(item => item.id === props.value)
    ? [...props.choices ?? [], { id: props.value, label: props.paging?.loading() ? t("missions.control.loading")
      : t("missions.scheduling.sourceMissing", { source: props.value }), unavailable: true }] : [...props.choices ?? []])
  const selected = createMemo(() => options().find(item => item.id === props.value) ?? null)
  const invalid = () => ({ "aria-invalid": Boolean(props.errorID), "aria-describedby": props.errorID })
  createEffect(() => {
    if (props.disabled) setOpen(false)
    else if (open()) queueMicrotask(() => { if (open() && !props.disabled) input?.focus() })
  })
  createEffect(() => {
    const target = end(), root = list(), page = props.paging
    if (!open() || !target || !root || !page?.next() || page.loading() || page.failed() || props.disabled) return
    if (query().trim()) return
    onCleanup(observeListEnd(target, root, () => { if (open() && !props.disabled) page.more() }, 80))
  })
  return <div class="mission-source-select">
    <Combobox<Choice> open={open()} onOpenChange={next => {
      pointerNavigation = false
      // Keep the controlled selection stable while source pages change beneath the search.
      if (next) setOpenSelection(selected())
      setOpen(next)
      if (next) { setQuery(""); props.paging?.search?.("") }
    }} disabled={props.disabled} virtualized
      onInputChange={setQuery} noResetInputOnBlur
      defaultFilter={item => item.label.toLowerCase().includes(query().trim().toLowerCase())}
      value={open() ? openSelection() : selected()} onChange={item => { if (item && !item.unavailable) props.onChange(item.id) }}
      options={options()} optionValue="id" optionLabel="label" optionTextValue="label" optionDisabled="unavailable"
      placeholder={t("missions.scheduling.chooseSource")} allowsEmptyCollection>
      <Combobox.Control>
        <Combobox.Input class="sr-only" tabindex={-1} aria-label={t("missions.scheduling.chooseSource")} aria-required="true" {...invalid()} />
        <Combobox.Trigger class="selector-trigger" aria-label={props.label} data-source-id={props.value} {...invalid()}
          aria-describedby={[valueID, props.errorID].filter(Boolean).join(" ")} title={selected()?.label ?? t("missions.scheduling.chooseSource")}>
          <span id={valueID} class="selector-trigger-primary">{selected()?.label ?? t("missions.scheduling.chooseSource")}</span>
          <Combobox.Icon class="selector-trigger-icon"><ChevronDown aria-hidden="true" /></Combobox.Icon>
        </Combobox.Trigger>
      </Combobox.Control>
      <Combobox.Portal><Combobox.Content class="selector-popover mission-source-popover"
        onCloseAutoFocus={event => { if (props.disabled) event.preventDefault() }}>
        <div class="selector-search-container" on:keydown={event => {
          pointerNavigation = false
          const action = [more, retry].find(button => button?.isConnected && !button.disabled)
          if (event.key !== "Tab" || event.shiftKey || !action) return
          event.preventDefault(); event.stopPropagation(); action.focus()
        }}><Combobox.Input ref={input} class="selector-search-input" value={query()}
          onInput={event => props.paging?.search?.(event.currentTarget.value)}
          aria-label={t("missions.scheduling.searchSource")} placeholder={t("missions.scheduling.searchSource")} /></div>
        <Combobox.Listbox as="div" class="selector-listbox" ref={setList} aria-label={props.label} aria-busy={props.paging?.loading()}
          on:pointermove={() => { pointerNavigation = true }} on:pointerdown={() => { pointerNavigation = true }}
          scrollToItem={key => {
            // Native pointer handlers run before Kobalte's delegated option focus.
            if (pointerNavigation) return
            const index = itemKeys.indexOf(key)
            if (index >= 0) virtualizer?.scrollToIndex(index, { align: "nearest" })
          }}>{items => {
          const entries = createMemo(() => [...items()])
          createEffect(() => { itemKeys = entries().map(item => item.key) })
          return <>
            <Show when={list()}>{root => <Virtualizer data={entries()} scrollRef={root()}
              startMargin={parseFloat(getComputedStyle(root()).paddingTop) || 0} ref={value => { virtualizer = value }} itemSize={40}>
              {item => <Combobox.Item as="div" item={item} class="selector-option" data-source-id={item.rawValue.id}>
                <Combobox.ItemLabel class="selector-option-label">{item.rawValue.label}</Combobox.ItemLabel>
              </Combobox.Item>}
            </Virtualizer>}</Show>
            <Show when={props.paging?.next() && !props.paging.failed() && !query().trim()}>
              <div ref={setEnd} aria-hidden="true" class="mission-source-end" />
            </Show>
            <Show when={!entries().length && !props.paging?.loading() && !props.paging?.next() && !props.paging?.failed()}>
              <div class="selector-option" role="status"><span class="selector-option-label">{t("unifiedPicker.empty")}</span></div>
            </Show>
          </>
        }}</Combobox.Listbox>
        <Show when={query().trim() && props.paging?.next() && !props.paging.failed()}>
          <div class="selector-search-container"><button ref={more} type="button" class="window-action" disabled={props.paging?.loading()}
            on:keydown={event => {
              if (event.key !== "Tab" || !event.shiftKey) return
              event.preventDefault(); event.stopPropagation(); input?.focus()
            }} onClick={() => { props.paging?.more(); if (open()) input?.focus({ preventScroll: true }) }}>
            {t("missions.scheduling.moreSources")}
          </button></div>
        </Show>
        <Show when={props.paging?.failed() || props.paging?.lookupFailed?.()}><div class="selector-search-container">
          <p role="alert" class="mission-create-field-error">{t("missions.scheduling.sourcesUnavailable")}</p>
          <button ref={retry} type="button" class="window-action" on:keydown={event => {
            if (event.key !== "Tab" || !event.shiftKey) return
            event.preventDefault(); event.stopPropagation(); input?.focus()
          }} onClick={() => {
            props.paging?.retry(); if (open()) input?.focus({ preventScroll: true })
          }}>{t("missions.control.retry")}</button>
        </div></Show>
      </Combobox.Content></Combobox.Portal>
    </Combobox>
  </div>
}
