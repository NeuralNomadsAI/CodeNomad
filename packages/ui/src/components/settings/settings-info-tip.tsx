import { Tooltip } from "@kobalte/core/tooltip"
import { Info } from "lucide-solid"
import { createSignal, type Component } from "solid-js"

/**
 * Secondary explanation kept out of the row: an "i" that reveals the text on
 * hover or keyboard focus, and on tap for touch screens (which have neither).
 * A span (not a button) so it can sit inside a row's <label> without becoming
 * that label's control; clicks never toggle the row.
 */
export const SettingsInfoTip: Component<{ text: string }> = (props) => {
  const [open, setOpen] = createSignal(false)
  // A tap's target state, decided at press time: the focus a tap gives the trigger opens it before the click.
  let tapped: boolean | undefined
  return (
    <Tooltip open={open()} onOpenChange={setOpen} openDelay={200} gutter={4} placement="top">
      <Tooltip.Trigger as="span" tabindex="0" role="img" class="settings-info-tip" aria-label={props.text}
        onPointerDown={(event: PointerEvent) => { tapped = event.pointerType === "mouse" ? undefined : !open() }}
        onClick={(event: MouseEvent) => {
          event.preventDefault()
          // The trigger hides its tooltip on every click; a tap then applies its own state.
          const next = tapped
          tapped = undefined
          if (next !== undefined) queueMicrotask(() => setOpen(next))
        }}>
        <Info aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="section-info-tooltip">{props.text}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip>
  )
}
