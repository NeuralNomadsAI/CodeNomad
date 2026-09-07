import type { Preferences, VisibilityPreference } from "../stores/preferences"
import { getConfigurableToolEntries, OTHER_TOOL_NAME, resolveToolVisibility, THINKING_EXPANSION_PRESETS } from "./tool-call/tool-presentation"

export type TranscriptVisibilityRow =
  | { kind: "thinking"; key: "thinking"; label: string }
  | { kind: "tool"; key: string; label: string }
  | { kind: "diagnostics"; key: "diagnostics"; label: string }
  | { kind: "inputs"; key: "inputs"; label: string }
  | { kind: "usage"; key: "usage"; label: string }

export function transcriptVisibilityRows(t: (key: string) => string): TranscriptVisibilityRow[] {
  return [
    { kind: "thinking", key: "thinking", label: t("settings.behavior.expansionDefaults.thinking") },
    ...getConfigurableToolEntries().map((entry) => ({
      kind: "tool" as const, key: entry.tool, label: entry.labelKey ? t(entry.labelKey) : entry.label,
    })),
    { kind: "diagnostics", key: "diagnostics", label: t("settings.behavior.diagnosticsDefault.title") },
    { kind: "inputs", key: "inputs", label: t("settings.behavior.toolInputsVisibility.title") },
    { kind: "usage", key: "usage", label: t("settings.behavior.usageMetrics.title") },
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
  }
}

export function transcriptVisibilityPatch(current: Preferences, row: TranscriptVisibilityRow, mode: VisibilityPreference): Partial<Preferences> {
  if (row.kind === "diagnostics") return { diagnosticsExpansion: mode }
  if (row.kind === "inputs") return { toolInputsVisibility: mode }
  if (row.kind === "usage") return {
    showUsageMetrics: mode !== "hidden",
    usageMetricsExpansion: mode === "hidden" ? current.usageMetricsExpansion : mode,
  }
  // Preserve every effective preset value before switching to per-type overrides.
  const tools = Object.fromEntries(getConfigurableToolEntries().map((entry) => [entry.tool, resolveToolVisibility(current, entry.tool)]))
  if (row.kind === "tool") tools[row.key] = mode
  const thinking = row.kind === "thinking" && mode !== "hidden" ? mode : thinkingExpansion(current)
  return {
    showThinkingBlocks: row.kind === "thinking" ? mode !== "hidden" : current.showThinkingBlocks,
    toolCallExpansionDefaults: { preset: "custom", thinking, tools },
    thinkingBlocksExpansion: row.kind === "thinking" && mode !== "hidden" ? mode : current.thinkingBlocksExpansion,
    toolOutputExpansion: row.kind === "tool" && row.key === OTHER_TOOL_NAME && mode !== "hidden" ? mode : current.toolOutputExpansion,
  }
}
