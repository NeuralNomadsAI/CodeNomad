import { Dialog } from "@kobalte/core/dialog"
import { Show, type JSX } from "solid-js"

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
  initialFocus?: () => HTMLElement | undefined
  returnFocus?: () => HTMLElement | undefined
  onKeyDown?: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent>
  children: JSX.Element
}) {
  const content = () => (
    <Dialog.Content
      id={props.id}
      class={`modal-surface window-shell ${props.class}`}
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
    <Show when={props.open}>
      <Dialog open modal={false} onOpenChange={open => { if (!open) props.onClose() }}>
        <Show when={props.inline} fallback={<Dialog.Portal>{content()}</Dialog.Portal>}>
          {content()}
        </Show>
      </Dialog>
    </Show>
  )
}
