import type { ExpansionPreference, Preferences, ToolCallExpansionPreset, ToolCallExpansionPresetSelection, VisibilityPreference } from "../stores/preferences"
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

export function transcriptPresetPatch(preset: ToolCallExpansionPreset): Partial<Preferences> {
  const tools = buildToolExpansionPresetDefaults(preset)
  const thinking = THINKING_EXPANSION_PRESETS[preset]
  return {
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

export function transcriptCustomExpansionPatch(current: Preferences, changes: {
  thinking?: ExpansionPreference
  tool?: { key: string; mode: VisibilityPreference }
}): Partial<Preferences> {
  // Materialize inherited defaults before changing the preset that supplied them.
  const tools = Object.fromEntries(getConfigurableToolEntries().map((entry) => [entry.tool, resolveToolVisibility(current, entry.tool)]))
  if (changes.tool) tools[changes.tool.key] = changes.tool.mode
  return {
    ...(current.toolCallExpansionDefaults.preset !== "custom" && {
      toolGroupVisibility: current.toolGroupVisibility,
      usageMetricsExpansion: current.usageMetricsExpansion,
    }),
    toolCallExpansionDefaults: { preset: "custom", thinking: changes.thinking ?? thinkingExpansion(current), tools },
    ...(changes.thinking && { thinkingBlocksExpansion: changes.thinking }),
    ...(changes.tool?.key === OTHER_TOOL_NAME && changes.tool.mode !== "hidden" && { toolOutputExpansion: changes.tool.mode }),
  }
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

const ordinaryRows = transcriptVisibilityRows(key => key).filter(row => row.kind !== "toolGroups")

export function transcriptContentSignature(current: Preferences): string {
  return ordinaryRows.map(row => transcriptVisibility(current, row)).join("|")
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
  if (row.kind === "tool") return transcriptCustomExpansionPatch(current, { tool: { key: row.key, mode } })
  return {
    ...transcriptCustomExpansionPatch(current, { thinking: mode === "hidden" ? undefined : mode }),
    showThinkingBlocks: mode !== "hidden",
  }
}
