import type {
  ExpansionPreference,
  Preferences,
  ToolCallExpansionPreset,
  VisibilityPreference,
} from "../../stores/preferences"
import type { ToolRenderer } from "./types"
import { applyPatchRenderer } from "./renderers/apply-patch"
import { bashRenderer } from "./renderers/bash"
import { defaultRenderer } from "./renderers/default"
import { editRenderer } from "./renderers/edit"
import { invalidRenderer } from "./renderers/invalid"
import { patchRenderer } from "./renderers/patch"
import { questionRenderer } from "./renderers/question"
import { readRenderer } from "./renderers/read"
import { searchRenderer } from "./renderers/search"
import { skillRenderer } from "./renderers/skill"
import { taskRenderer } from "./renderers/task"
import { todoRenderer } from "./renderers/todo"
import { webfetchRenderer } from "./renderers/webfetch"
import { writeRenderer } from "./renderers/write"

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
  renderer: ToolRenderer
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
    renderer: bashRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "read",
    label: "read",
    renderer: readRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: "write",
    label: "write",
    renderer: writeRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "edit",
    label: "edit",
    renderer: editRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "patch",
    label: "patch",
    renderer: patchRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "apply_patch",
    label: "apply_patch",
    renderer: applyPatchRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "webfetch",
    label: "webfetch",
    renderer: webfetchRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "glob",
    label: "glob",
    renderer: searchRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "grep",
    label: "grep",
    renderer: searchRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: expanded, everything: expanded }),
  },
  {
    tool: "todowrite",
    label: "todowrite",
    renderer: todoRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: expanded, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "task",
    label: "task",
    renderer: taskRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "skill",
    label: "skill",
    renderer: skillRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: "question",
    label: "question",
    renderer: questionRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: expanded, detailed: expanded, everything: expanded }),
  },
  {
    tool: "invalid",
    label: "invalid",
    renderer: invalidRenderer,
    configurable: true,
    expansionPresets: presets({ minimal: collapsed, balanced: collapsed, detailed: collapsed, everything: expanded }),
  },
  {
    tool: OTHER_TOOL_NAME,
    label: "Other tools",
    labelKey: "settings.behavior.expansionDefaults.otherTools",
    renderer: defaultRenderer,
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

export function resolveToolRenderer(toolName: string): ToolRenderer {
  return getToolRegistryEntry(toolName).renderer
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
