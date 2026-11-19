import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { ShellInfo } from "@opencode/client"
import { Tooltip } from "@kobalte/core/tooltip"
import { Check, Circle, Minus, Trash2, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { createLongPressHandlers } from "../lib/long-press"
import { shellCommandLabel } from "../lib/shell-command-label"

interface BackgroundShellRowProps {
  shell: ShellInfo
  removing: boolean
  onOutput: () => void
  onRemove: (button: HTMLButtonElement) => void
}

export function BackgroundShellRow(props: BackgroundShellRowProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [pinned, setPinned] = createSignal(false)
  let button!: HTMLButtonElement
  let content: HTMLDivElement | undefined
  let pointerStart: { x: number; y: number } | undefined
  const label = createMemo(() => shellCommandLabel(props.shell.command))
  const state = () => {
    if (props.shell.status === "running") return "running"
    if (props.shell.status === "killed") return "killed"
    if (props.shell.status === "timeout") return "timeout"
    return props.shell.exit !== undefined && props.shell.exit !== 0 ? "failed" : "exited"
  }
  const status = () => t(`instanceShell.backgroundProcesses.status.${state()}`)
  const removeLabel = () => t(`instanceShell.backgroundProcesses.actions.${state() === "running" ? "stopRemove" : "remove"}`)
  const close = () => { setPinned(false); setOpen(false) }
  const handlers = createLongPressHandlers({ onClick: () => { close(); props.onOutput() }, onLongPress: () => setPinned(true) })
  const onKeyDown = (event: KeyboardEvent) => {
    handlers.onKeyDown(event)
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || (!open() && !pinned()) || !content) return
    const distance = { ArrowDown: 40, ArrowUp: -40, PageDown: content.clientHeight * .9,
      PageUp: -content.clientHeight * .9, Home: -content.scrollHeight, End: content.scrollHeight }[event.key]
    if (distance === undefined) return
    event.preventDefault()
    content.scrollTop += distance
  }
  const date = (value: number) => new Date(value).toLocaleString(locale(), {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  })
  createEffect(() => {
    if (!open() && !pinned()) return
    const outside = (event: PointerEvent) => {
      if (!button.contains(event.target as Node) && !content?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close() }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", escape, true)
    })
  })
  return (
    <article class="status-process-card" data-shell-id={props.shell.id}>
      <Tooltip open={open() || pinned()} onOpenChange={setOpen} openDelay={200} closeDelay={0} gutter={4} placement="top">
        <Tooltip.Trigger as="button" ref={button} type="button" class="status-process-command"
          aria-label={`${props.shell.command} — ${status()}`}
          onClick={handlers.onClick}
          onPointerDown={(event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY }; handlers.onPointerDown(event) }}
          onPointerMove={(event: PointerEvent) => {
            if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 8) handlers.onPointerCancel()
          }}
          onPointerUp={handlers.onPointerUp} onPointerCancel={handlers.onPointerCancel}
          onPointerLeave={handlers.onPointerLeave} onTouchEnd={handlers.onTouchEnd}
          onContextMenu={handlers.onContextMenu} onKeyDown={onKeyDown}
        >
          <span class="status-process-state" data-state={state()} aria-hidden="true">
            <Show when={state() !== "running"} fallback={<Circle fill="currentColor" />}>
              <Show when={state() !== "killed"} fallback={<Minus />}>
                <Show when={state() !== "failed" && state() !== "timeout"} fallback={<X />}><Check /></Show>
              </Show>
            </Show>
          </span>
          <span class="status-process-label" dir="ltr">
            <Show when={label()} fallback={<span class="min-w-0 truncate">{props.shell.command}</span>}>
              {(value) => <><strong>{value().program}</strong><Show when={value().args}>
                <span class="status-process-args">{value().args}</span>
              </Show></>}
            </Show>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content ref={content} class="section-info-tooltip status-process-tooltip">
            <div dir="ltr" class="status-process-detail-command">{props.shell.command}</div>
            <div>{status()}</div>
            <Show when={props.shell.cwd}><div>{t("instanceShell.backgroundProcesses.details.cwd")} <bdi dir="ltr">{props.shell.cwd}</bdi></div></Show>
            <Show when={props.shell.shell}><div>{t("instanceShell.backgroundProcesses.details.shell")} <bdi dir="ltr">{props.shell.shell}</bdi></div></Show>
            <Show when={props.shell.pid !== undefined}><div>{t("instanceShell.backgroundProcesses.pid", { pid: props.shell.pid })}</div></Show>
            <Show when={props.shell.exit !== undefined}><div>{t("instanceShell.backgroundProcesses.exitCode", { code: props.shell.exit })}</div></Show>
            <Show when={props.shell.time?.started !== undefined}><div>{t("instanceShell.backgroundProcesses.details.started", { date: date(props.shell.time.started) })}</div></Show>
            <Show when={props.shell.time?.completed !== undefined}><div>{t("instanceShell.backgroundProcesses.details.ended", { date: date(props.shell.time.completed!) })}</div></Show>
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip>
      <button type="button" class="window-icon-button" title={removeLabel()} aria-label={removeLabel()}
        aria-disabled={props.removing} onClick={event => { if (!props.removing) props.onRemove(event.currentTarget) }}>
        <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </article>
  )
}
