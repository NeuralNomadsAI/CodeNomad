import type { HotkeyBinding } from "./hotkey-bindings"

export interface HotkeyDefinition {
  id: string
  labelKey: string
  category: "app" | "session" | "composer" | "search" | "files"
  scope: "app" | "main" | "home" | "instance" | "session" | "composer" | "aside" | "search" | "files" | "instance-tab"
}

const definition = (id: string, category: HotkeyDefinition["category"], scope: HotkeyDefinition["scope"]): HotkeyDefinition => ({
  id, labelKey: `hotkeys.action.${id}`, category, scope,
})

// Static metadata is available in Preferences without mounting the application.
export const hotkeyDefinitions: HotkeyDefinition[] = [
  definition("open-command-palette", "app", "instance"),
  definition("new-instance", "app", "main"),
  ...["close-instance", "instance-prev", "instance-next"].map(id => definition(id, "app", "app")),
  definition("browse-folder", "app", "home"),
  ...["session-new", "session-prev", "session-next", "switch-to-info"].map(id => definition(id, "session", "instance")),
  ...["close-session", "session-abort", "session-search"].map(id => definition(id, "session", "session")),
  ...["clear-input", "focus-input", "focus-model", "open-agent-selector", "focus-variant"].map(id => definition(id, "composer", "session")),
  ...["session-background", "prompt-send", "prompt-alternate-send", "prompt-newline", "prompt-history-prev", "prompt-history-next", "prompt-exit-shell", "prompt-blur"].map(id => definition(id, "composer", "composer")),
  definition("aside-send", "composer", "aside"),
  ...["search-next-result", "search-prev-result"].map(id => definition(id, "search", "search")),
  definition("file-save", "files", "files"),
  definition("instance-rename", "app", "instance-tab"),
  ...Array.from({ length: 9 }, (_, i) => ({ ...definition(`app-tab-${i + 1}`, "app", "app"), labelKey: "hotkeys.action.app-tab" })),
  ...Array.from({ length: 9 }, (_, i) => ({ ...definition(`session-tab-${i + 1}`, "session", "instance"), labelKey: "hotkeys.action.session-tab" })),
]

export function getHotkeyDefinitions(filter?: { category?: string }): HotkeyDefinition[] {
  return hotkeyDefinitions.filter(item => !filter?.category || item.category === filter.category)
}

const defaults: Record<string, HotkeyBinding[]> = {
  "open-command-palette": [{ key: "p", mod: true, shift: true }],
  "new-instance": [{ key: "n", mod: true }],
  "browse-folder": [{ key: "n", mod: true }],
  "close-instance": [{ key: "w", mod: true }],
  "instance-prev": [{ key: "[", mod: true }],
  "instance-next": [{ key: "]", mod: true }],
  "session-new": [{ key: "n", mod: true, shift: true }],
  "session-prev": [{ key: "[", mod: true, shift: true }],
  "session-next": [{ key: "]", mod: true, shift: true }],
  "switch-to-info": [{ key: "l", mod: true, shift: true }],
  "close-session": [{ key: "w", mod: true, shift: true }],
  "session-abort": [{ key: "Escape" }],
  "prompt-blur": [{ key: "Escape" }],
  "clear-input": [{ key: "k", mod: true }],
  "focus-input": [{ key: "p", mod: true }],
  "focus-model": [{ key: "m", mod: true, shift: true }],
  "open-agent-selector": [{ key: "a", mod: true, shift: true }],
  "focus-variant": [{ key: "t", mod: true, shift: true }],
  "session-search": [{ key: "f", mod: true }],
  "session-background": [{ key: "b", mod: true }],
  "prompt-alternate-send": [{ key: "Enter", mod: true, shift: true }],
  "prompt-history-prev": [{ key: "ArrowUp" }],
  "prompt-history-next": [{ key: "ArrowDown" }],
  "prompt-exit-shell": [{ key: "Escape" }],
  "aside-send": [{ key: "Enter", mod: true }],
  "search-next-result": [{ key: "Enter" }],
  "search-prev-result": [{ key: "Enter", shift: true }],
  "file-save": [{ key: "s", mod: true }],
  "instance-rename": [{ key: "F2" }],
}

export function defaultHotkeyBindings(id: string, promptSubmitOnEnter = true): HotkeyBinding[] {
  if (id === "prompt-send") return [{ key: "Enter", ...(!promptSubmitOnEnter ? { mod: true } : {}) }]
  if (id === "prompt-newline") return promptSubmitOnEnter
    ? [{ key: "Enter", shift: true }, { key: "Enter", mod: true }]
    : [{ key: "Enter" }, { key: "Enter", shift: true }]
  const tab = /^(app|session)-tab-([1-9])$/.exec(id)
  if (tab) return [{ key: tab[2], mod: true, ...(tab[1] === "session" ? { shift: true } : {}) }]
  return (defaults[id] ?? []).map(binding => ({ ...binding }))
}
