import IconButton from "@suid/material/IconButton"
import { PanelLeft, PanelRight } from "lucide-solid"
import type { Component } from "solid-js"

interface ShellPanelToggleProps {
  side: "left" | "right"
  expanded: boolean
  label: string
  controls: string
  onToggle: () => void
  ref: (element: HTMLElement) => void
}

/** One fixed toggle per panel, at the shell's outer header corner. It stays in
 * place whether its panel is docked, floating or closed; headers reserve room.
 * The label is fixed; `aria-expanded` alone announces the panel state. */
const ShellPanelToggle: Component<ShellPanelToggleProps> = (props) => (
  <span class={`panel-header-actions shell-panel-toggle shell-panel-toggle--${props.side}`}>
    <IconButton
      ref={props.ref}
      class="icon-toggle"
      color="inherit"
      size="small"
      aria-label={props.label}
      title={props.label}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onToggle}
    >
      {props.side === "left" ? <PanelLeft aria-hidden="true" /> : <PanelRight aria-hidden="true" />}
    </IconButton>
  </span>
)

export default ShellPanelToggle
