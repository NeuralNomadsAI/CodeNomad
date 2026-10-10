import { Show, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js"
import { Pause, Play, RefreshCw } from "lucide-solid"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import type { MissionPrimaryAction } from "./mission-lifecycle-controls"
import { useI18n } from "../lib/i18n"

const pixels = (value: string) => Number.parseFloat(value) || 0

function primaryIcon(key: string): JSX.Element {
  if (key === "pause") return <Pause aria-hidden="true" />
  if (key === "check" || key === "status") return <RefreshCw aria-hidden="true" />
  return <Play aria-hidden="true" />
}

/** One Mission/schedule entry in two lines, laid out like a session row: the
 * title, then state with the row's actions trailing on the same line. The
 * primary action stays inline while it fits; otherwise, like session rows, it
 * joins the overflow menu. Hidden inline controls remain measurable but inert.
 * The selected entry's detail is a separate section below the list. */
export function MissionIndexRow(props: {
  title: string; meta: JSX.Element; statusKind?: string
  selected: boolean; onSelect: () => void; detailId: string
  primary?: MissionPrimaryAction; menu: ActionOverflowMenuItem[]
  feedback?: JSX.Element
}) {
  const { t } = useI18n()
  const metaId = createUniqueId()
  const [overflow, setOverflow] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const compact = overflow
  let row!: HTMLDivElement, meta!: HTMLSpanElement, actions!: HTMLDivElement, inline!: HTMLDivElement
  const items = (): ActionOverflowMenuItem[] => {
    const primary = props.primary
    if (!compact() || !primary) return props.menu
    return [{ key: primary.key, label: primary.label, description: primary.ariaLabel, disabled: primary.disabled,
      onSelect: primary.onSelect }, ...props.menu]
  }
  createEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      const width = row.getBoundingClientRect().width
      if (!row.isConnected || !width) return
      const style = getComputedStyle(row)
      const scale = width / (row.offsetWidth || width)
      const range = document.createRange()
      range.selectNodeContents(meta)
      // The same full-action budget applies in both modes, so the row never oscillates.
      const more = actions.getBoundingClientRect().width - (overflow() ? 0 : inline.getBoundingClientRect().width)
      const required = range.getBoundingClientRect().width + inline.getBoundingClientRect().width + more
        + (pixels(style.columnGap) + pixels(getComputedStyle(actions).columnGap)) * scale
      const available = width - (pixels(style.paddingLeft) + pixels(style.paddingRight)) * scale
      const next = Boolean(props.primary) && required > available + 0.5
      // An open menu keeps its items until dismissal; its close remeasures.
      if (next === overflow() || menuOpen()) return
      const focused = actions.contains(document.activeElement)
      setOverflow(next)
      if (focused) queueMicrotask(() => {
        if (!row.isConnected) return
        row.querySelector<HTMLElement>(next ? ".mission-index-more" : ".mission-index-inline button:not(:disabled)")?.focus({ preventScroll: true })
      })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    createEffect(() => { if (!menuOpen()) schedule() })
    const resize = new ResizeObserver(schedule)
    for (const element of [row, meta, inline]) resize.observe(element)
    const mutation = new MutationObserver(schedule)
    mutation.observe(row, { childList: true, characterData: true, subtree: true })
    document.fonts?.addEventListener("loadingdone", schedule)
    schedule()
    onCleanup(() => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
      document.fonts?.removeEventListener("loadingdone", schedule)
    })
  })
  return <li class="mission-index-entry" classList={{ "mission-index-entry-selected": props.selected }}>
    <div ref={row} class="mission-index-row" data-status={props.statusKind} data-compact-actions={compact()}>
      <button type="button" class="mission-index-select" aria-label={props.title} aria-describedby={metaId}
        aria-current={props.selected ? "true" : undefined} aria-controls={props.selected ? props.detailId : undefined}
        onClick={() => props.onSelect()}>
        <span class="mission-index-title"><bdi title={props.title}>{props.title}</bdi></span>
        <span ref={meta} id={metaId} class="mission-index-meta">{props.meta}</span>
      </button>
      <div ref={actions} class="mission-index-actions">
        <div ref={inline} class="mission-index-inline" inert={compact()} aria-hidden={compact() ? "true" : undefined}>
          <Show when={props.primary}>{action => <button type="button" class="mission-index-action mission-index-primary"
            aria-label={action().ariaLabel ?? action().label} title={action().ariaLabel ?? action().label} disabled={action().disabled}
            onClick={() => void action().onSelect()}>{primaryIcon(action().key)}</button>}</Show>
        </div>
        <ActionOverflowMenu items={items()} label={t("missionsPanel.moreActions")} triggerClass="mission-index-more"
          onOpenChange={setMenuOpen} />
      </div>
    </div>
    <div class="mission-index-feedback">{props.feedback}</div>
  </li>
}
