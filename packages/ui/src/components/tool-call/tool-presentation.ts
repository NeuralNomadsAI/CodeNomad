import type {
  ExpansionPreference,
  Preferences,
  ToolCallExpansionPreset,
  VisibilityPreference,
} from "../../stores/preferences"

export const OTHER_TOOL_NAME = "other"

export const THINKING_EXPANSION_PRESETS: Record<ToolCallExpansionPreset, ExpansionPreference> = {
  minimal: "collapsed",
  balanced: "collapsed",
  detailed: "expanded",
  everything: "expanded",
}

export interface ToolRegistryEntry {
  tool: string
  label: string
  labelKey?: string
  configurable: boolean
  expansionPresets: Record<ToolCallExpansionPreset, VisibilityPreference>
  aliases?: string[]
}

const expanded = "expanded" satisfies ExpansionPreference
const collapsed = "collapsed" satisfies ExpansionPreference

function presets(values: Record<ToolCallExpansionPreset, VisibilityPreference>) {
  return values
}

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    tool: "bash",
    label: "bash",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "read",
    label: "read",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: "write",
    label: "write",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "edit",
    label: "edit",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "patch",
    label: "patch",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "apply_patch",
    label: "apply_patch",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "webfetch",
    label: "webfetch",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "glob",
    label: "glob",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "grep",
    label: "grep",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "todowrite",
    label: "todowrite",
    configurable: true,
    expansionPresets: presets({ minimal: expanded, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "task",
    label: "task",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "skill",
    label: "skill",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: "question",
    label: "question",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "invalid",
    label: "invalid",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: OTHER_TOOL_NAME,
    label: "Other tools",
    labelKey: "settings.behavior.expansionDefaults.otherTools",
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
]

const otherToolEntry = TOOL_REGISTRY.find((entry) => entry.tool === OTHER_TOOL_NAME)!

const registryMap = TOOL_REGISTRY.reduce<Record<string, ToolRegistryEntry>>((acc, entry) => {
  acc[entry.tool] = entry
  entry.aliases?.forEach((alias) => {
    acc[alias] = entry
  })
  return acc
}, {})

export function getToolRegistryEntry(toolName: string): ToolRegistryEntry {
  return registryMap[toolName] ?? otherToolEntry
}

export function getConfigurableToolEntries(): ToolRegistryEntry[] {
  return TOOL_REGISTRY.filter((entry) => entry.configurable)
}

export function buildToolExpansionPresetDefaults(preset: ToolCallExpansionPreset): Record<string, VisibilityPreference> {
  const defaults: Record<string, VisibilityPreference> = {}
  for (const entry of getConfigurableToolEntries()) {
    defaults[entry.tool] = entry.expansionPresets[preset]
  }
  return defaults
}

export function resolveToolVisibility(preferences: Preferences, toolName: string): VisibilityPreference {
  const entry = getToolRegistryEntry(toolName)
  const defaults = preferences.toolCallExpansionDefaults
  const presetMode = defaults.preset === "custom" ? undefined : entry.expansionPresets[defaults.preset]
  const otherPresetMode = defaults.preset === "custom" ? undefined : otherToolEntry.expansionPresets[defaults.preset]
  return defaults.tools[entry.tool]
    ?? presetMode
    ?? defaults.tools[OTHER_TOOL_NAME]
    ?? otherPresetMode
    ?? preferences.toolOutputExpansion
    ?? "expanded"
}

export function resolveToolExpansionDefault(preferences: Preferences, toolName: string): boolean {
  return resolveToolVisibility(preferences, toolName) === "expanded"
}

export function resolveThinkingExpansionDefault(preferences: Preferences): boolean {
  const defaults = preferences.toolCallExpansionDefaults
  const mode = defaults.thinking
    ?? (defaults.preset === "custom" ? undefined : THINKING_EXPANSION_PRESETS[defaults.preset])
    ?? preferences.thinkingBlocksExpansion
    ?? "expanded"
  return mode === "expanded"
}
