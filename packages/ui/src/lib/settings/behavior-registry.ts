import type { Accessor } from "solid-js"
import type {
  Preferences,
  ExpansionPreference,
  ToolInputsVisibilityPreference,
} from "../../stores/preferences"
import type { Command } from "../commands"
import { tGlobal } from "../i18n"
import { isWebHost } from "../runtime-env"

export type BehaviorSettingKind = "toggle" | "enum"

export type BehaviorToggleSetting = {
  kind: "toggle"
  id: string
  titleKey: string
  subtitleKey: string
  get: (preferences: Preferences) => boolean
  set: (next: boolean) => void
  disabled?: () => boolean
}

export type BehaviorEnumSetting<T extends string = string> = {
  kind: "enum"
  id: string
  titleKey: string
  subtitleKey: string
  get: (preferences: Preferences) => T
  set: (next: T) => void
  options: Array<{ value: T; labelKey: string }>
  disabled?: () => boolean
}

export type BehaviorSetting = BehaviorToggleSetting | BehaviorEnumSetting

export type BehaviorRegistryActions = {
  preferences: Accessor<Preferences>
  updatePreferences?: (updates: Partial<Preferences>) => void
  toggleShowThinkingBlocks: () => void
  toggleKeyboardShortcutHints: () => void
  toggleShowTimelineTools: () => void
  toggleUsageMetrics: () => void
  toggleAutoCleanupBlankSessions: () => void
  togglePromptSubmitOnEnter: () => void
  toggleShowPromptVoiceInput: () => void
  setDiffViewMode: (mode: "split" | "unified") => void
  setToolOutputExpansion: (mode: ExpansionPreference) => void
  setDiagnosticsExpansion: (mode: ExpansionPreference) => void
  setThinkingBlocksExpansion: (mode: ExpansionPreference) => void
  setToolInputsVisibility: (mode: ToolInputsVisibilityPreference) => void
}

function splitKeywords(key: string): string[] {
  return tGlobal(key)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function setBooleanByToggle(getCurrent: () => boolean, toggle: () => void, next: boolean) {
  if (getCurrent() === next) return
  toggle()
}

export function getBehaviorSettings(actions: BehaviorRegistryActions): BehaviorSetting[] {
  const prefs = actions.preferences
  const updatePreferences = actions.updatePreferences

  return [
    {
      kind: "toggle",
      id: "behavior.keyboardShortcutHints",
      titleKey: "settings.behavior.keyboardHints.title",
      subtitleKey: "settings.behavior.keyboardHints.subtitle",
      get: (p) => Boolean(p.showKeyboardShortcutHints ?? true),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ showKeyboardShortcutHints: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().showKeyboardShortcutHints ?? true),
          actions.toggleKeyboardShortcutHints,
          next,
        )
      },
      disabled: () => isWebHost(),
    },
    {
      kind: "toggle",
      id: "behavior.thinkingBlocks",
      titleKey: "settings.behavior.thinking.title",
      subtitleKey: "settings.behavior.thinking.subtitle",
      get: (p) => Boolean(p.showThinkingBlocks),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ showThinkingBlocks: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().showThinkingBlocks),
          actions.toggleShowThinkingBlocks,
          next,
        )
      },
    },
    {
      kind: "enum",
      id: "behavior.thinkingBlocksDefault",
      titleKey: "settings.behavior.thinkingDefault.title",
      subtitleKey: "settings.behavior.thinkingDefault.subtitle",
      get: (p) => (p.thinkingBlocksExpansion ?? "expanded") as ExpansionPreference,
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ thinkingBlocksExpansion: next as ExpansionPreference })
          return
        }
        actions.setThinkingBlocksExpansion(next as ExpansionPreference)
      },
      options: [
        { value: "expanded", labelKey: "commands.common.expanded" },
        { value: "collapsed", labelKey: "commands.common.collapsed" },
      ],
    },
    {
      kind: "toggle",
      id: "behavior.timelineToolCalls",
      titleKey: "settings.behavior.timelineTools.title",
      subtitleKey: "settings.behavior.timelineTools.subtitle",
      get: (p) => Boolean(p.showTimelineTools),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ showTimelineTools: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().showTimelineTools),
          actions.toggleShowTimelineTools,
          next,
        )
      },
    },
    {
      kind: "enum",
      id: "behavior.diffViewMode",
      titleKey: "settings.behavior.diffView.title",
      subtitleKey: "settings.behavior.diffView.subtitle",
      get: (p) => (p.diffViewMode ?? "split") as "split" | "unified",
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ diffViewMode: next as "split" | "unified" })
          return
        }
        actions.setDiffViewMode(next as "split" | "unified")
      },
      options: [
        { value: "split", labelKey: "settings.behavior.diffView.option.split" },
        { value: "unified", labelKey: "settings.behavior.diffView.option.unified" },
      ],
    },
    {
      kind: "enum",
      id: "behavior.toolOutputsDefault",
      titleKey: "settings.behavior.toolOutputsDefault.title",
      subtitleKey: "settings.behavior.toolOutputsDefault.subtitle",
      get: (p) => (p.toolOutputExpansion ?? "expanded") as ExpansionPreference,
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ toolOutputExpansion: next as ExpansionPreference })
          return
        }
        actions.setToolOutputExpansion(next as ExpansionPreference)
      },
      options: [
        { value: "expanded", labelKey: "commands.common.expanded" },
        { value: "collapsed", labelKey: "commands.common.collapsed" },
      ],
    },
    {
      kind: "enum",
      id: "behavior.diagnosticsDefault",
      titleKey: "settings.behavior.diagnosticsDefault.title",
      subtitleKey: "settings.behavior.diagnosticsDefault.subtitle",
      get: (p) => (p.diagnosticsExpansion ?? "expanded") as ExpansionPreference,
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ diagnosticsExpansion: next as ExpansionPreference })
          return
        }
        actions.setDiagnosticsExpansion(next as ExpansionPreference)
      },
      options: [
        { value: "expanded", labelKey: "commands.common.expanded" },
        { value: "collapsed", labelKey: "commands.common.collapsed" },
      ],
    },
    {
      kind: "enum",
      id: "behavior.toolInputsVisibility",
      titleKey: "settings.behavior.toolInputsVisibility.title",
      subtitleKey: "settings.behavior.toolInputsVisibility.subtitle",
      get: (p) => (p.toolInputsVisibility ?? "hidden") as ToolInputsVisibilityPreference,
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ toolInputsVisibility: next as ToolInputsVisibilityPreference })
          return
        }
        actions.setToolInputsVisibility(next as ToolInputsVisibilityPreference)
      },
      options: [
        { value: "hidden", labelKey: "commands.common.hidden" },
        { value: "collapsed", labelKey: "commands.common.collapsed" },
        { value: "expanded", labelKey: "commands.common.expanded" },
      ],
    },
    {
      kind: "toggle",
      id: "behavior.usageMetrics",
      titleKey: "settings.behavior.usageMetrics.title",
      subtitleKey: "settings.behavior.usageMetrics.subtitle",
      get: (p) => Boolean(p.showUsageMetrics ?? true),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ showUsageMetrics: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().showUsageMetrics ?? true),
          actions.toggleUsageMetrics,
          next,
        )
      },
    },
    {
      kind: "toggle",
      id: "behavior.autoCleanupBlankSessions",
      titleKey: "settings.behavior.autoCleanup.title",
      subtitleKey: "settings.behavior.autoCleanup.subtitle",
      get: (p) => Boolean(p.autoCleanupBlankSessions),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ autoCleanupBlankSessions: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().autoCleanupBlankSessions),
          actions.toggleAutoCleanupBlankSessions,
          next,
        )
      },
    },
    {
      kind: "toggle",
      id: "behavior.promptVoiceInput",
      titleKey: "settings.behavior.promptVoiceInput.title",
      subtitleKey: "settings.behavior.promptVoiceInput.subtitle",
      get: (p) => Boolean(p.showPromptVoiceInput ?? true),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ showPromptVoiceInput: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().showPromptVoiceInput ?? true),
          actions.toggleShowPromptVoiceInput,
          next,
        )
      },
    },
    {
      kind: "toggle",
      id: "behavior.promptSubmitOnEnter",
      titleKey: "settings.behavior.promptSubmit.title",
      subtitleKey: "settings.behavior.promptSubmit.subtitle",
      get: (p) => Boolean(p.promptSubmitOnEnter),
      set: (next) => {
        if (updatePreferences) {
          updatePreferences({ promptSubmitOnEnter: next })
          return
        }
        setBooleanByToggle(
          () => Boolean(prefs().promptSubmitOnEnter),
          actions.togglePromptSubmitOnEnter,
          next,
        )
      },
    },
  ]
}

export function getBehaviorCommands(actions: BehaviorRegistryActions): Command[] {
  return [
    {
      id: "prompt-submit-shortcut",
      label: () =>
        actions.preferences().promptSubmitOnEnter
          ? tGlobal("commands.promptSubmitShortcut.label.swapped")
          : tGlobal("commands.promptSubmitShortcut.label.default"),
      description: () => tGlobal("commands.promptSubmitShortcut.description"),
      category: "Input & Focus",
      keywords: () => splitKeywords("commands.promptSubmitShortcut.keywords"),
      action: actions.togglePromptSubmitOnEnter,
    },
    {
      id: "thinking",
      label: () =>
        tGlobal(
          actions.preferences().showThinkingBlocks
            ? "commands.thinkingBlocks.label.hide"
            : "commands.thinkingBlocks.label.show",
        ),
      description: () => tGlobal("commands.thinkingBlocks.description"),
      category: "System",
      keywords: () => ["/thinking", ...splitKeywords("commands.thinkingBlocks.keywords")],
      action: actions.toggleShowThinkingBlocks,
    },
    {
      id: "timeline-tools",
      label: () =>
        tGlobal(
          actions.preferences().showTimelineTools
            ? "commands.timelineToolCalls.label.hide"
            : "commands.timelineToolCalls.label.show",
        ),
      description: () => tGlobal("commands.timelineToolCalls.description"),
      category: "System",
      keywords: () => splitKeywords("commands.timelineToolCalls.keywords"),
      action: actions.toggleShowTimelineTools,
    },
    {
      id: "keyboard-shortcut-hints",
      label: () =>
        tGlobal(
          actions.preferences().showKeyboardShortcutHints
            ? "commands.keyboardShortcutHints.label.hide"
            : "commands.keyboardShortcutHints.label.show",
        ),
      description: () =>
        tGlobal(
          isWebHost()
            ? "commands.keyboardShortcutHints.description.disabledWeb"
            : "commands.keyboardShortcutHints.description",
        ),
      category: "System",
      keywords: () => splitKeywords("commands.keyboardShortcutHints.keywords"),
      disabled: () => isWebHost(),
      action: actions.toggleKeyboardShortcutHints,
    },
    {
      id: "thinking-default-visibility",
      label: () => {
        const mode = actions.preferences().thinkingBlocksExpansion ?? "expanded"
        const state = mode === "expanded" ? tGlobal("commands.common.expanded") : tGlobal("commands.common.collapsed")
        return tGlobal("commands.thinkingBlocksDefault.label", { state })
      },
      description: () => tGlobal("commands.thinkingBlocksDefault.description"),
      category: "System",
      keywords: () => ["/thinking", ...splitKeywords("commands.thinkingBlocksDefault.keywords")],
      action: () => {
        const mode = actions.preferences().thinkingBlocksExpansion ?? "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        actions.setThinkingBlocksExpansion(next)
      },
    },
    {
      id: "diff-view-split",
      label: () => {
        const prefix = (actions.preferences().diffViewMode || "split") === "split" ? "✓ " : ""
        return `${prefix}${tGlobal("commands.diffViewSplit.label")}`
      },
      description: () => tGlobal("commands.diffViewSplit.description"),
      category: "System",
      keywords: () => splitKeywords("commands.diffViewSplit.keywords"),
      action: () => actions.setDiffViewMode("split"),
    },
    {
      id: "diff-view-unified",
      label: () => {
        const prefix = (actions.preferences().diffViewMode || "split") === "unified" ? "✓ " : ""
        return `${prefix}${tGlobal("commands.diffViewUnified.label")}`
      },
      description: () => tGlobal("commands.diffViewUnified.description"),
      category: "System",
      keywords: () => splitKeywords("commands.diffViewUnified.keywords"),
      action: () => actions.setDiffViewMode("unified"),
    },
    {
      id: "tool-output-default-visibility",
      label: () => {
        const mode = actions.preferences().toolOutputExpansion || "expanded"
        const state = mode === "expanded" ? tGlobal("commands.common.expanded") : tGlobal("commands.common.collapsed")
        return tGlobal("commands.toolOutputsDefault.label", { state })
      },
      description: () => tGlobal("commands.toolOutputsDefault.description"),
      category: "System",
      keywords: () => splitKeywords("commands.toolOutputsDefault.keywords"),
      action: () => {
        const mode = actions.preferences().toolOutputExpansion || "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        actions.setToolOutputExpansion(next)
      },
    },
    {
      id: "diagnostics-default-visibility",
      label: () => {
        const mode = actions.preferences().diagnosticsExpansion || "expanded"
        const state = mode === "expanded" ? tGlobal("commands.common.expanded") : tGlobal("commands.common.collapsed")
        return tGlobal("commands.diagnosticsDefault.label", { state })
      },
      description: () => tGlobal("commands.diagnosticsDefault.description"),
      category: "System",
      keywords: () => splitKeywords("commands.diagnosticsDefault.keywords"),
      action: () => {
        const mode = actions.preferences().diagnosticsExpansion || "expanded"
        const next: ExpansionPreference = mode === "expanded" ? "collapsed" : "expanded"
        actions.setDiagnosticsExpansion(next)
      },
    },
    {
      id: "tool-inputs-visibility",
      label: () => {
        const mode = actions.preferences().toolInputsVisibility || "hidden"
        const state =
          mode === "expanded"
            ? tGlobal("commands.common.expanded")
            : mode === "collapsed"
              ? tGlobal("commands.common.collapsed")
              : tGlobal("commands.common.hidden")
        return tGlobal("commands.toolInputsVisibility.label", { state })
      },
      description: () => tGlobal("commands.toolInputsVisibility.description"),
      category: "System",
      keywords: () => splitKeywords("commands.toolInputsVisibility.keywords"),
      action: () => {
        const mode = actions.preferences().toolInputsVisibility || "hidden"
        const next: ToolInputsVisibilityPreference =
          mode === "hidden" ? "collapsed" : mode === "collapsed" ? "expanded" : "hidden"
        actions.setToolInputsVisibility(next)
      },
    },
    {
      id: "token-usage-visibility",
      label: () => {
        const visible = actions.preferences().showUsageMetrics ?? true
        const state = visible ? tGlobal("commands.common.visible") : tGlobal("commands.common.hidden")
        return tGlobal("commands.tokenUsageDisplay.label", { state })
      },
      description: () => tGlobal("commands.tokenUsageDisplay.description"),
      category: "System",
      keywords: () => splitKeywords("commands.tokenUsageDisplay.keywords"),
      action: actions.toggleUsageMetrics,
    },
    {
      id: "auto-cleanup-blank-sessions",
      label: () => {
        const enabled = actions.preferences().autoCleanupBlankSessions
        const state = enabled ? tGlobal("commands.common.enabled") : tGlobal("commands.common.disabled")
        return tGlobal("commands.autoCleanupBlankSessions.label", { state })
      },
      description: () => tGlobal("commands.autoCleanupBlankSessions.description"),
      category: "System",
      keywords: () => splitKeywords("commands.autoCleanupBlankSessions.keywords"),
      action: actions.toggleAutoCleanupBlankSessions,
    },
  ]
}

export function registerBehaviorCommands(register: (command: Command) => void, actions: BehaviorRegistryActions) {
  const commands = getBehaviorCommands(actions)
  commands.forEach((command) => register(command))
}
