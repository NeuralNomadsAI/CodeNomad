import { onCleanup, onMount, type ParentProps } from "solid-js"
import { installKeyboardOffset } from "../lib/keyboard-offset"

export function AppViewport(props: ParentProps) {
  onMount(() => onCleanup(installKeyboardOffset(window)))
  return (
    <div data-keyboard-viewport class="h-screen w-screen flex flex-col"
      style={{ height: "100dvh", "padding-bottom": "var(--keyboard-offset, 0px)" }}>
      {props.children}
    </div>
  )
}
