import { For, Show, createComputed, createEffect, createSignal, onCleanup, type JSX } from "solid-js"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import { useI18n } from "../lib/i18n"
import { createMissionListActions } from "./mission-list-item-actions"

export interface MissionListItemProps {
  text: JSX.Element
  secondary?: JSX.Element
  title?: string
  status: JSX.Element
  statusKind?: string
  actions?: ActionOverflowMenuItem[]
  compact?: boolean
  selected?: boolean
  onSelect?: () => void
  children?: JSX.Element
}

/** Shared Mission row. Hidden inline actions retain their intrinsic geometry;
 * the measurement budget never depends on which presentation currently wins. */
export function MissionListItem(props: MissionListItemProps) {
  const { t } = useI18n()
  const [overflow, setOverflow] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const actions = createMissionListActions(() => props.actions)
  const preview = () => actions.inline().filter(item => item.key === "read")
  const secondary = () => actions.inline().filter(item => item.key !== "read")
  let row!: HTMLDivElement, footer!: HTMLDivElement, status!: HTMLDivElement, inline!: HTMLDivElement, pinned!: HTMLDivElement
  let frame = 0, focusFrame = 0, disposed = false, menuOpen = false
  createComputed(() => {
    secondary()
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement && inline?.contains(focused)) queueMicrotask(() => {
      // Moving a keyed DOM node can blur it. Preserve only focus lost to that
      // move, never focus deliberately taken by a reader or an open menu.
      if (!disposed && focused.isConnected && !focused.disabled && !collapsed() && document.activeElement === document.body) {
        focused.focus({ preventScroll: true })
      }
    })
  })
  const measure = () => {
    frame = 0
    if (disposed || !row.isConnected || !row.clientWidth) return
    const range = document.createRange()
    range.selectNodeContents(status)
    // Rects share the same zoom space, including fractional zoom and RTL.
    // The row's geometry is independent of the inline/menu presentation. Do not
    // derive zoom from the shrinking footer's rounded offsetWidth.
    const scale = row.getBoundingClientRect().width / row.offsetWidth || 1
    const gap = (Number.parseFloat(getComputedStyle(footer).columnGap) || 0) * scale
    const actionGap = (Number.parseFloat(getComputedStyle(pinned.parentElement!).columnGap) || 0) * scale
    const required = range.getBoundingClientRect().width + inline.getBoundingClientRect().width + pinned.getBoundingClientRect().width
      + gap + (preview().length && secondary().length ? actionGap : 0)
    const rowStyle = getComputedStyle(row)
    const minimumText = Number.parseFloat(getComputedStyle(row.querySelector(".mission-list-text")!).minWidth) || 0
    const available = props.compact
      ? (row.clientWidth - (Number.parseFloat(rowStyle.paddingLeft) || 0) - (Number.parseFloat(rowStyle.paddingRight) || 0)
        - minimumText - (Number.parseFloat(rowStyle.columnGap) || 0)) * scale
      : footer.getBoundingClientRect().width
    const next = secondary().length > 0 && required > available + 0.5
    const focused = document.activeElement
    const handoff = focused instanceof HTMLElement && footer.contains(focused) && !pinned.contains(focused)
      && (next !== overflow() || (!next && !menuOpen && focused.classList.contains("action-overflow-trigger")))
    if (next !== overflow()) setOverflow(next)
    // Keep the trigger visible through Kobalte's close autofocus. This frame
    // runs after selected-action microtasks, so a reader's focus is not stolen.
    if (!menuOpen) setOpen(false)
    if (handoff) queueMicrotask(() => {
      if (disposed || open()) return
      row.querySelector<HTMLButtonElement>(next
        ? ".mission-list-overflow button" : ".mission-list-inline button:not(:disabled)")?.focus({ preventScroll: true })
    })
  }
  const schedule = () => { if (!frame && !disposed) frame = requestAnimationFrame(measure) }
  createEffect(() => {
    const resize = new ResizeObserver(schedule)
    for (const element of [row, footer, inline, status, pinned]) resize.observe(element)
    const mutation = new MutationObserver(schedule)
    mutation.observe(row, { childList: true, characterData: true, subtree: true })
    document.fonts?.addEventListener("loadingdone", schedule)
    schedule()
    onCleanup(() => { resize.disconnect(); mutation.disconnect(); document.fonts?.removeEventListener("loadingdone", schedule) })
  })
  onCleanup(() => { disposed = true; cancelAnimationFrame(frame); cancelAnimationFrame(focusFrame) })
  const collapsed = () => overflow() || open()
  createEffect(() => { props.compact; props.statusKind; schedule() })
  return <div ref={row} class="mission-list-item" data-status={props.statusKind}
    classList={{ "mission-list-item-compact": props.compact, "mission-list-item-selected": props.selected, "mission-list-item-overflow": collapsed() }}>
    <Show when={props.onSelect} fallback={<div class="mission-list-text" title={props.title}>{props.text}</div>}>
      <button type="button" class="mission-list-text mission-list-select" title={props.title} aria-label={props.title}
        classList={{ "mission-list-with-mode": Boolean(props.secondary) }}
        aria-current={props.selected ? "true" : undefined} onClick={() => props.onSelect?.()}>
        <Show when={props.secondary} fallback={props.text}><span class="mission-list-primary">{props.text}</span><span class="mission-list-secondary">{props.secondary}</span></Show>
      </button>
    </Show>
    <div ref={footer} class="mission-list-footer">
      <div ref={status} class="mission-list-status">{props.status}</div>
       <div class="mission-list-actions">
        <div ref={pinned} class="mission-list-preview"><For each={preview()}>{item =>
          <button type="button" class="mission-control-icon-button icon-toggle" aria-label={item.label}
            title={item.label} aria-pressed={item.checked ?? false} disabled={item.disabled} onClick={() => void item.onSelect()}>
            <span aria-hidden="true">{item.icon}</span>
          </button>
        }</For></div>
        <div ref={inline} class="mission-list-inline" inert={collapsed()} aria-hidden={collapsed() ? "true" : undefined}>
          <For each={secondary()}>{item => <button type="button" class="mission-control-icon-button"
            aria-label={item.label} aria-description={item.description} title={item.description ?? item.label} disabled={item.disabled}
            aria-pressed={item.checked} onClick={() => void item.onSelect()}
            onMouseEnter={() => item.onMouseEnter?.()} onMouseLeave={() => item.onMouseLeave?.()}>
            <span aria-hidden="true">{item.icon ?? item.label}</span>
          </button>}</For>
        </div>
        <div class="mission-list-overflow" inert={!collapsed()} aria-hidden={!collapsed() ? "true" : undefined}>
          <ActionOverflowMenu items={actions.menu().filter(item => item.key !== "read")} label={t("messageItem.actions.more")} onOpenChange={value => {
            menuOpen = value
            if (value) setOpen(true)
            schedule()
            if (!value) {
              cancelAnimationFrame(focusFrame)
              // Portal disposal and Kobalte's deferred autofocus can complete
              // after measurement. Restore only lost/trigger focus, never the
              // focus owned by a selected action's reader or another control.
              focusFrame = requestAnimationFrame(() => {
                focusFrame = requestAnimationFrame(() => {
                  focusFrame = 0
                  const active = document.activeElement
                  if (disposed || menuOpen || overflow() || !row.isConnected) return
                  if (active === document.body || (active instanceof Element && row.contains(active) && active.classList.contains("action-overflow-trigger"))) {
                    row.querySelector<HTMLButtonElement>(".mission-list-inline button:not(:disabled)")?.focus({ preventScroll: true })
                  }
                })
              })
            }
          }} />
        </div>
      </div>
    </div>
    <Show when={props.children}><div class="mission-list-feedback">{props.children}</div></Show>
  </div>
}
