import { Component, JSX } from "solid-js"

interface HintRowProps {
  children: JSX.Element
  class?: string
  ariaHidden?: boolean
}

const HintRow: Component<HintRowProps> = (props) => {
  return (
    <span aria-hidden={props.ariaHidden} class={`keyboard-hints text-xs text-muted ${props.class || ""}`}>
      {props.children}
    </span>
  )
}

export default HintRow
