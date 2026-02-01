import { Component, JSX } from "solid-js"
import { cn } from "../lib/cn"

interface HintRowProps {
  children: JSX.Element
  class?: string
}

const HintRow: Component<HintRowProps> = (props) => {
  return <span class={cn("text-xs text-muted-foreground", props.class)}>{props.children}</span>
}

export default HintRow
