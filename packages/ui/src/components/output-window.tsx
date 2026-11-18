import { Show, type JSX } from "solid-js"
import DismissibleWindow from "./dismissible-window"
import WindowCloseButton from "./window-close-button"

/** Shared non-modal, movable frame for diagnostic output; sources own their reads. */
export function OutputWindow(props: {
  id: string; open: boolean; title: string; subtitle?: string; onClose: () => void
  returnFocus?: () => HTMLElement | undefined
  actions?: JSX.Element
  children: JSX.Element
}) {
  let close: HTMLButtonElement | undefined
  return <DismissibleWindow id={props.id} open={props.open} title={props.title} class="output-window" draggable
    onClose={props.onClose} initialFocus={() => close} returnFocus={props.returnFocus}>
    <header class="window-header" data-window-drag-handle>
      <div class="min-w-0 flex-1">
        <h2 class="window-title">{props.title}</h2>
        <Show when={props.subtitle}>{value => <span class="output-window-subtitle" title={value()}>{value()}</span>}</Show>
      </div>
      {props.actions}
      <WindowCloseButton ref={element => { close = element }} onClose={props.onClose} />
    </header>
    <div class="window-body">{props.children}</div>
  </DismissibleWindow>
}
