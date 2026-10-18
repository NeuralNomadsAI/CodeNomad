import { matchesHotkey } from "./hotkeys"

export interface KeyboardShortcut {
  id: string
  handler: () => void
  description: string
  context?: "global" | "input" | "messages"
  condition?: () => boolean
  repeat?: boolean
}

class KeyboardRegistry {
  private shortcuts = new Map<string, KeyboardShortcut>()

  register(shortcut: KeyboardShortcut) {
    this.shortcuts.set(shortcut.id, shortcut)
  }

  unregister(id: string) {
    this.shortcuts.delete(id)
  }

  get(id: string) {
    return this.shortcuts.get(id)
  }

  findMatch(event: KeyboardEvent): KeyboardShortcut | null {
    for (const shortcut of this.shortcuts.values()) {
      if (matchesHotkey(shortcut.id, event)) {
        if (shortcut.context === "input" && !this.isInputFocused()) continue
        if (shortcut.context === "messages" && this.isInputFocused()) continue

        if (shortcut.condition && !shortcut.condition()) continue

        return shortcut
      }
    }
    return null
  }

  private isInputFocused(): boolean {
    const active = document.activeElement
    return (
      active?.tagName === "TEXTAREA" ||
      active?.tagName === "INPUT" ||
      (active?.hasAttribute("contenteditable") ?? false)
    )
  }

  getByContext(context: string): KeyboardShortcut[] {
    return Array.from(this.shortcuts.values()).filter((s) => !s.context || s.context === context)
  }
}

export const keyboardRegistry = new KeyboardRegistry()
