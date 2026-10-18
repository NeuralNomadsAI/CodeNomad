import { Tooltip } from "@kobalte/core/tooltip"
import { Info } from "lucide-solid"
import type { Component } from "solid-js"

/**
 * Secondary explanation kept out of the row: an "i" that reveals the text on
 * hover or keyboard focus. A span (not a button) so it can sit inside a row's
 * <label> without becoming that label's control; clicks never toggle the row.
 */
export const SettingsInfoTip: Component<{ text: string }> = (props) => (
  <Tooltip openDelay={200} gutter={4} placement="top">
    <Tooltip.Trigger as="span" tabindex="0" role="img" class="settings-info-tip" aria-label={props.text}
      onClick={(event: MouseEvent) => event.preventDefault()}>
      <Info aria-hidden="true" />
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content class="section-info-tooltip">{props.text}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip>
)
