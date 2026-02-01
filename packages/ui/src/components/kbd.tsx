import { Component, JSX, For } from "solid-js"
import { isMac } from "../lib/keyboard-utils"
import { cn } from "../lib/cn"

interface KbdProps {
  children?: JSX.Element
  shortcut?: string
  class?: string
}

const SPECIAL_KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  pageup: "Page Up",
  pagedown: "Page Down",
  home: "Home",
  end: "End",
  arrowup: "\u2191",
  arrowdown: "\u2193",
  arrowleft: "\u2190",
  arrowright: "\u2192",
}

const Kbd: Component<KbdProps> = (props) => {
  const parts = () => {
    if (props.children) return [{ text: props.children, isModifier: false }]
    if (!props.shortcut) return []

    const result: { text: string | JSX.Element; isModifier: boolean }[] = []
    const shortcut = props.shortcut.toLowerCase()
    const tokens = shortcut.split("+")

    tokens.forEach((token) => {
      const trimmed = token.trim()
      const lower = trimmed.toLowerCase()

      if (lower === "cmd" || lower === "command") {
        result.push({ text: isMac() ? "Cmd" : "Ctrl", isModifier: false })
      } else if (lower === "shift") {
        result.push({ text: "Shift", isModifier: false })
      } else if (lower === "alt" || lower === "option") {
        result.push({ text: isMac() ? "Option" : "Alt", isModifier: false })
      } else if (lower === "ctrl" || lower === "control") {
        result.push({ text: "Ctrl", isModifier: false })
      } else {
        const label = SPECIAL_KEY_LABELS[lower]
        if (label) {
          result.push({ text: label, isModifier: false })
        } else if (trimmed.length === 1) {
          result.push({ text: trimmed.toUpperCase(), isModifier: false })
        } else {
          result.push({ text: trimmed.charAt(0).toUpperCase() + trimmed.slice(1), isModifier: false })
        }
      }
    })

    return result
  }

  return (
    <kbd class={cn(
      "inline-flex items-center px-1.5 py-0.5 text-xs font-mono rounded bg-secondary border border-border text-foreground",
      props.class,
    )}>
      <For each={parts()}>
        {(part, index) => (
          <>
            {index() > 0 && <span class="text-muted-foreground mx-0.5">+</span>}
            <span>{part.text}</span>
          </>
        )}
      </For>
    </kbd>
  )
}

export default Kbd
