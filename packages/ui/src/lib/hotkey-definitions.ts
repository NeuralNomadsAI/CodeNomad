import type { HotkeyBinding } from "./hotkey-bindings"

export interface HotkeyDefinition {
  id: string
  labelKey: string
  labelParams?: Record<string, string>
  category: "app" | "session" | "composer" | "search" | "files"
  scope: "app" | "main" | "home" | "instance" | "session" | "composer" | "aside" | "search" | "files" | "instance-tab"
}

const definition = (id: string, category: HotkeyDefinition["category"], scope: HotkeyDefinition["scope"], labelKey = `hotkeys.action.${id}`): HotkeyDefinition => ({
  id, labelKey, category, scope,
})

// These palette actions have no initial binding. Keep their metadata available
// in native Preferences, where the application's command handlers are not mounted.
export const commandHotkeyDefinitions: HotkeyDefinition[] = [
  definition("new-temporary-instance", "app", "app", "commands.newTemporaryInstance.label"),
  definition("open-workspace-folder", "app", "instance", "commands.openWorkspace.folder.label"),
  definition("open-workspace-terminal", "app", "instance", "commands.openWorkspace.terminal.label"),
  ...Object.entries({ vscode: "VS Code", cursor: "Cursor", zed: "Zed", vscodium: "VSCodium" }).map(([id, editor]) => ({
    ...definition(`open-workspace-editor-${id}`, "app", "instance", "commands.openWorkspace.editor.label"), labelParams: { editor },
  })),
  definition("cleanup-blank-sessions", "session", "instance", "commands.scrubSessions.label"),
  definition("compact", "session", "session", "commands.compactSession.label"),
  definition("remove-session-tools-and-reasoning", "session", "session", "commands.removeSessionTechnicalParts.label"),
  definition("undo", "session", "session", "commands.undoLastMessage.label"),
  definition("redo", "session", "session", "commands.redoLastMessage.label"),
  definition("thinking", "app", "app", "settings.behavior.thinking.title"),
  definition("thinking-default-visibility", "app", "app", "settings.behavior.thinkingDefault.title"),
  definition("diff-view-split", "app", "app", "commands.diffViewSplit.label"),
  definition("diff-view-unified", "app", "app", "commands.diffViewUnified.label"),
  definition("tool-output-default-visibility", "app", "app", "settings.behavior.toolOutputsDefault.title"),
  definition("diagnostics-default-visibility", "app", "app", "settings.behavior.diagnosticsDefault.title"),
  definition("tool-inputs-visibility", "app", "app", "settings.behavior.toolInputsVisibility.title"),
  definition("token-usage-visibility", "app", "app", "settings.behavior.usageMetrics.title"),
  definition("auto-cleanup-blank-sessions", "app", "app", "settings.behavior.autoCleanup.title"),
  definition("open-help", "app", "app", "commands.openHelp.label"),
  definition("open-about", "app", "app", "commands.openAbout.label"),
]

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
  ...commandHotkeyDefinitions,
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
