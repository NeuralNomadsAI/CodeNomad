import type { Preferences, ToolCallExpansionPreset, ToolCallExpansionPresetSelection, TranscriptDetailSettings, VisibilityPreference } from "../stores/preferences"
import {
  buildToolExpansionPresetDefaults,
  getConfigurableToolEntries,
  OTHER_TOOL_NAME,
  resolveToolVisibility,
  THINKING_EXPANSION_PRESETS,
} from "./tool-call/tool-presentation"

export const TRANSCRIPT_PRESETS: ToolCallExpansionPreset[] = ["nothing", "minimal", "balanced", "everything"]

const transcriptDetailPresets = {
  nothing: {
    toolGroupVisibility: "collapsed",
    systemMessagesVisibility: "hidden",
    showThinkingBlocks: false,
    diagnosticsExpansion: "hidden",
    toolInputsVisibility: "hidden",
    showUsageMetrics: false,
    usageMetricsExpansion: "collapsed",
  },
  minimal: {
    toolGroupVisibility: "collapsed",
    systemMessagesVisibility: "hidden",
    showThinkingBlocks: false,
    diagnosticsExpansion: "collapsed",
    toolInputsVisibility: "hidden",
    showUsageMetrics: false,
    usageMetricsExpansion: "collapsed",
  },
  balanced: {
    toolGroupVisibility: "collapsed",
    systemMessagesVisibility: "hidden",
    showThinkingBlocks: false,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "collapsed",
    showUsageMetrics: false,
    usageMetricsExpansion: "collapsed",
  },
  everything: {
    toolGroupVisibility: "expanded",
    systemMessagesVisibility: "expanded",
    showThinkingBlocks: true,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "expanded",
    showUsageMetrics: true,
    usageMetricsExpansion: "expanded",
  },
} as const satisfies Record<
  ToolCallExpansionPreset,
  Pick<
    Preferences,
    | "showThinkingBlocks"
    | "diagnosticsExpansion"
    | "systemMessagesVisibility"
    | "toolGroupVisibility"
    | "toolInputsVisibility"
    | "showUsageMetrics"
    | "usageMetricsExpansion"
  >
>

/** The saved preset while every non-tool row still matches it; any manual change is Custom. */
export function transcriptPreset(current: Preferences): ToolCallExpansionPresetSelection {
  const preset = current.toolCallExpansionDefaults.preset
  if (preset === "custom") return preset
  const detail = transcriptDetailPresets[preset]
  const expectedThinking = detail.showThinkingBlocks ? THINKING_EXPANSION_PRESETS[preset] : "hidden"
  return transcriptVisibility(current, { kind: "thinking", key: "thinking", label: "" }) === expectedThinking &&
    current.diagnosticsExpansion === detail.diagnosticsExpansion &&
    current.systemMessagesVisibility === detail.systemMessagesVisibility &&
    current.toolGroupVisibility === detail.toolGroupVisibility &&
    current.toolInputsVisibility === detail.toolInputsVisibility &&
    current.showUsageMetrics === detail.showUsageMetrics &&
    current.usageMetricsExpansion === detail.usageMetricsExpansion
    ? preset
    : "custom"
}

const effectiveTools = (current: Preferences) =>
  Object.fromEntries(getConfigurableToolEntries().map((entry) => [entry.tool, resolveToolVisibility(current, entry.tool)]))

/** The current rows as explicit choices, independent of any preset's definition. */
function customPreset(current: Preferences): TranscriptDetailSettings {
  return {
    showThinkingBlocks: current.showThinkingBlocks,
    thinkingBlocksExpansion: current.thinkingBlocksExpansion,
    toolCallExpansionDefaults: { preset: "custom", thinking: thinkingExpansion(current), tools: effectiveTools(current) },
    toolOutputExpansion: current.toolOutputExpansion,
    diagnosticsExpansion: current.diagnosticsExpansion,
    systemMessagesVisibility: current.systemMessagesVisibility,
    toolGroupVisibility: current.toolGroupVisibility,
    toolInputsVisibility: current.toolInputsVisibility,
    showUsageMetrics: current.showUsageMetrics,
    usageMetricsExpansion: current.usageMetricsExpansion,
  }
}

/** Custom can be chosen while it is shown or once a preset has replaced it. */
export function transcriptCustomAvailable(current: Preferences): boolean {
  return transcriptPreset(current) === "custom" || current.transcriptCustomPreset !== undefined
}

/** With `current`, a preset that replaces Custom rows keeps them for the Custom choice, which applies them again. */
export function transcriptPresetPatch(preset: ToolCallExpansionPresetSelection, current?: Preferences): Partial<Preferences> {
  const replaced = current && transcriptPreset(current) === "custom" ? current : undefined
  if (preset === "custom") return replaced ? {} : { ...current?.transcriptCustomPreset }
  const tools = buildToolExpansionPresetDefaults(preset)
  const thinking = THINKING_EXPANSION_PRESETS[preset]
  return {
    ...(replaced ? { transcriptCustomPreset: customPreset(replaced) } : {}),
    ...transcriptDetailPresets[preset],
    toolCallExpansionDefaults: { preset, thinking, tools },
    thinkingBlocksExpansion: thinking,
    toolOutputExpansion: tools[OTHER_TOOL_NAME] === "expanded" ? "expanded" : "collapsed",
  }
}

export type TranscriptVisibilityRow =
  | { kind: "thinking"; key: "thinking"; label: string }
  | { kind: "tool"; key: string; label: string }
  | { kind: "diagnostics"; key: "diagnostics"; label: string }
  | { kind: "inputs"; key: "inputs"; label: string }
  | { kind: "usage"; key: "usage"; label: string }
  | { kind: "system"; key: "system"; label: string }
  | { kind: "toolGroups"; key: "toolGroups"; label: string }

export function transcriptVisibilityRows(t: (key: string) => string): TranscriptVisibilityRow[] {
  return [
    { kind: "thinking", key: "thinking", label: t("settings.behavior.expansionDefaults.thinking") },
    { kind: "diagnostics", key: "diagnostics", label: t("settings.behavior.diagnosticsDefault.title") },
    { kind: "inputs", key: "inputs", label: t("settings.behavior.toolInputsVisibility.title") },
    { kind: "usage", key: "usage", label: t("settings.behavior.usageMetrics.title") },
    { kind: "system", key: "system", label: t("transcriptFilters.systemMessages") },
    { kind: "toolGroups", key: "toolGroups", label: t("transcriptFilters.toolGroups") },
    ...getConfigurableToolEntries().map((entry) => ({
      kind: "tool" as const, key: entry.tool, label: entry.labelKey ? t(entry.labelKey) : entry.label,
    })),
  ]
}

function thinkingExpansion(current: Preferences) {
  const defaults = current.toolCallExpansionDefaults
  return defaults.thinking
    ?? (defaults.preset === "custom" ? undefined : THINKING_EXPANSION_PRESETS[defaults.preset])
    ?? current.thinkingBlocksExpansion ?? "expanded"
}

export function transcriptVisibility(current: Preferences, row: TranscriptVisibilityRow): VisibilityPreference {
  switch (row.kind) {
    case "thinking": return current.showThinkingBlocks ? thinkingExpansion(current) : "hidden"
    case "tool": return resolveToolVisibility(current, row.key)
    case "diagnostics": return current.diagnosticsExpansion
    case "inputs": return current.toolInputsVisibility
    case "usage": return current.showUsageMetrics ? current.usageMetricsExpansion : "hidden"
    case "system": return current.systemMessagesVisibility ?? "hidden"
    case "toolGroups": return current.toolGroupVisibility
  }
}

export function transcriptVisibilityPatch(current: Preferences, row: TranscriptVisibilityRow, mode: VisibilityPreference): Partial<Preferences> {
  if (row.kind === "system") return { systemMessagesVisibility: mode }
  if (row.kind === "toolGroups") return { toolGroupVisibility: mode }
  if (row.kind === "diagnostics") return { diagnosticsExpansion: mode }
  if (row.kind === "inputs") return { toolInputsVisibility: mode }
  if (row.kind === "usage") return {
    showUsageMetrics: mode !== "hidden",
    usageMetricsExpansion: mode === "hidden" ? current.usageMetricsExpansion : mode,
  }
  // Preserve every configurable category before switching to per-type overrides.
  // Retired tools follow "Other tools" and no longer need separate overrides.
  const tools = effectiveTools(current)
  if (row.kind === "tool") tools[row.key] = mode
  const thinking = row.kind === "thinking" && mode !== "hidden" ? mode : thinkingExpansion(current)
  return {
    showThinkingBlocks: row.kind === "thinking" ? mode !== "hidden" : current.showThinkingBlocks,
    toolCallExpansionDefaults: { preset: "custom", thinking, tools },
    thinkingBlocksExpansion: row.kind === "thinking" && mode !== "hidden" ? mode : current.thinkingBlocksExpansion,
    toolOutputExpansion: row.kind === "tool" && row.key === OTHER_TOOL_NAME && mode !== "hidden" ? mode : current.toolOutputExpansion,
  }
}
