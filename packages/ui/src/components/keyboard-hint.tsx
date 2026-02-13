import { Component, For } from "solid-js"
import useMediaQuery from "@suid/material/useMediaQuery"
import type { KeyboardShortcut } from "../lib/keyboard-registry"
import Kbd from "./kbd"
import HintRow from "./hint-row"

const KeyboardHint: Component<{
  shortcuts: KeyboardShortcut[]
  separator?: string | null
  showDescription?: boolean
  class?: string
  ariaHidden?: boolean
}> = (props) => {
  // Centralize layout gating here so call sites don't need to.
  // We only show keyboard hint UI on desktop layouts.
  const desktopQuery = useMediaQuery("(min-width: 1280px)")

  function buildShortcutString(shortcut: KeyboardShortcut): string {
    const parts: string[] = []

    if (shortcut.modifiers.ctrl || shortcut.modifiers.meta) {
      parts.push("cmd")
    }
    if (shortcut.modifiers.shift) {
      parts.push("shift")
    }
    if (shortcut.modifiers.alt) {
      parts.push("alt")
    }
    parts.push(shortcut.key)

    return parts.join("+")
  }

  if (!desktopQuery()) return null

  return (
    <HintRow class={props.class} ariaHidden={props.ariaHidden}>
      <For each={props.shortcuts}>
        {(shortcut, i) => (
          <>
            {i() > 0 && props.separator !== null && <span class="mx-1">{props.separator ?? "•"}</span>}
            {props.showDescription !== false && <span class="mr-1">{shortcut.description}</span>}
            <Kbd shortcut={buildShortcutString(shortcut)} />
          </>
        )}
      </For>
    </HintRow>
  )
}

export default KeyboardHint
