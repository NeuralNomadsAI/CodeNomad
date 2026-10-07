import { Dialog } from "@kobalte/core/dialog"
import { Show, createEffect, onCleanup, type JSX } from "solid-js"

/** Persistent non-modal utility window: outside interactions remain available
 * without dismissing it. Toggles identify it via aria-controls. */
export default function DismissibleWindow(props: {
  id: string
  open: boolean
  onClose: () => void
  title: string
  description?: string
  class: string
  inline?: boolean
  draggable?: boolean
  initialFocus?: () => HTMLElement | undefined
  returnFocus?: () => HTMLElement | undefined
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  children: JSX.Element
}) {
  let panel: HTMLDivElement | undefined
  let anchor: HTMLSpanElement | undefined
  let drag: { id: number; x: number; y: number; left: number; top: number } | undefined
  const place = (left: number, top: number) => {
    if (!panel?.isConnected) return
    const rect = panel.getBoundingClientRect(), viewport = window.visualViewport
    const x = (viewport?.offsetLeft ?? 0) + 16, y = (viewport?.offsetTop ?? 0) + 16
    Object.assign(panel.style, {
      position: "fixed", transform: "none", right: "auto",
      left: `${Math.max(x, Math.min(left, x + Math.max(0, (viewport?.width ?? innerWidth) - 32 - rect.width)))}px`,
      top: `${Math.max(y, Math.min(top, y + Math.max(0, (viewport?.height ?? innerHeight) - 32 - rect.height)))}px`,
    })
  }
  const startDrag = (event: PointerEvent) => {
    const target = event.target as Element
    if (!props.draggable || !event.isPrimary || event.button !== 0 || !panel
      || !target.closest("[data-window-drag-handle]")
      || target.closest("button, input, select, textarea, a, label, [contenteditable]")) return
    const rect = panel.getBoundingClientRect()
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
    panel.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const endDrag = (event: PointerEvent) => { if (drag?.id === event.pointerId) drag = undefined }
  createEffect(() => {
    if (!props.draggable || !props.open) return
    const keepVisible = () => {
      if (panel?.style.position !== "fixed") return
      const rect = panel.getBoundingClientRect()
      place(rect.left, rect.top)
    }
    window.addEventListener("resize", keepVisible)
    window.visualViewport?.addEventListener("resize", keepVisible)
    window.visualViewport?.addEventListener("scroll", keepVisible)
    onCleanup(() => {
      drag = undefined
      window.removeEventListener("resize", keepVisible)
      window.visualViewport?.removeEventListener("resize", keepVisible)
      window.visualViewport?.removeEventListener("scroll", keepVisible)
    })
  })
  const content = () => (
    <Dialog.Content
      ref={element => {
        panel = element
        if (props.inline && props.draggable) queueMicrotask(() => {
          // Portal placement escapes transcript clipping while retaining the initial anchor.
          if (!element.isConnected || !anchor?.parentElement) return
          const rect = anchor.parentElement.getBoundingClientRect()
          Object.assign(element.style, { position: "fixed", left: `${rect.left + rect.width / 2}px`,
            top: `${rect.top + parseFloat(getComputedStyle(element).top)}px` })
        })
      }}
      id={props.id}
      class={`modal-surface window-shell ${props.class}`}
      data-draggable={props.draggable ? "" : undefined}
      onPointerDown={startDrag}
      onPointerMove={(event: PointerEvent) => { if (drag && drag.id === event.pointerId) place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y) }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={props.onKeyDown}
      onEscapeKeyDown={event => {
        // Kobalte invokes this only for the topmost layer. Consume the native
        // event before unmounting so lower windows and global Stop stay idle.
        event.preventDefault()
        event.stopImmediatePropagation()
        props.onClose()
      }}
      onInteractOutside={event => event.preventDefault()}
      onOpenAutoFocus={event => {
        const target = props.initialFocus?.()
        if (!target) return
        event.preventDefault()
        target.focus({ preventScroll: true })
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        // Keep an outside click's chosen target; restore the toggle only when
        // focus is left on the body or in the window being dismissed.
        const active = document.activeElement
        if (active && active !== document.body && !document.getElementById(props.id)?.contains(active)) return
        const returnTarget = props.returnFocus?.()
        if (returnTarget?.getClientRects().length) {
          returnTarget.focus({ preventScroll: true })
          return
        }
        const trigger = Array.from(document.querySelectorAll<HTMLElement>("[aria-controls]"))
          .find(element => element.getAttribute("aria-controls") === props.id && element.getClientRects().length > 0)
        trigger?.focus({ preventScroll: true })
      }}
    >
      <Dialog.Title class="sr-only">{props.title}</Dialog.Title>
      <Dialog.Description class="sr-only">{props.description ?? props.title}</Dialog.Description>
      {props.children}
    </Dialog.Content>
  )
  return (
    <>
    <Show when={props.inline && props.draggable}><span ref={anchor} hidden /></Show>
    <Show when={props.open}>
      <Dialog open modal={false} onOpenChange={open => { if (!open) props.onClose() }}>
        <Show when={props.inline && !props.draggable} fallback={<Dialog.Portal>{content()}</Dialog.Portal>}>
          {content()}
        </Show>
      </Dialog>
    </Show>
    </>
  )
}
