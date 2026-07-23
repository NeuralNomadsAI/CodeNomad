import { Select } from "@kobalte/core/select"
import { createMemo, For, type Component } from "solid-js"
import { ChevronDown } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import {
  useConfig,
  type Preferences,
  type ToolCallExpansionPreset,
  type VisibilityPreference,
} from "../../stores/preferences"
import {
  buildToolExpansionPresetDefaults,
  getConfigurableToolEntries,
  OTHER_TOOL_NAME,
  THINKING_EXPANSION_PRESETS,
} from "../tool-call/tool-registry"

const toolExpansionPresetOptions: ToolCallExpansionPreset[] = ["minimal", "balanced", "detailed", "everything"]

const transcriptDetailPresets = {
  minimal: {
    showThinkingBlocks: false,
    diagnosticsExpansion: "collapsed",
    toolInputsVisibility: "hidden",
    showUsageMetrics: false,
    usageMetricsExpansion: "collapsed",
  },
  balanced: {
    showThinkingBlocks: false,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "collapsed",
    showUsageMetrics: true,
    usageMetricsExpansion: "collapsed",
  },
  detailed: {
    showThinkingBlocks: true,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "collapsed",
    showUsageMetrics: true,
    usageMetricsExpansion: "expanded",
  },
  everything: {
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
    | "toolInputsVisibility"
    | "showUsageMetrics"
    | "usageMetricsExpansion"
  >
>

type SelectOption = { value: VisibilityPreference; label: string }

type VisibilityRow =
  | { kind: "thinking"; key: "thinking"; label: string }
  | { kind: "tool"; key: string; label: string }
  | { kind: "diagnostics"; key: "diagnostics"; label: string }
  | { kind: "inputs"; key: "inputs"; label: string }
  | { kind: "usage"; key: "usage"; label: string }

export const ChatSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, updatePreferences } = useConfig()

  const visibilityOptions = createMemo<SelectOption[]>(() => [
    { value: "hidden", label: t("commands.common.hidden") },
    { value: "collapsed", label: t("commands.common.collapsed") },
    { value: "expanded", label: t("commands.common.expanded") },
  ])

  const visibilityRows = createMemo<VisibilityRow[]>(() => [
    { kind: "thinking", key: "thinking", label: t("settings.behavior.expansionDefaults.thinking") },
    ...getConfigurableToolEntries().map((entry) => ({
      kind: "tool" as const,
      key: entry.tool,
      label: entry.labelKey ? t(entry.labelKey) : entry.label,
    })),
    { kind: "diagnostics", key: "diagnostics", label: t("settings.behavior.diagnosticsDefault.title") },
    { kind: "inputs", key: "inputs", label: t("settings.behavior.toolInputsVisibility.title") },
    { kind: "usage", key: "usage", label: t("settings.behavior.usageMetrics.title") },
  ])

  const currentToolMode = (tool: string): VisibilityPreference => {
    const pref = preferences().toolCallExpansionDefaults
    const entry = getConfigurableToolEntries().find((item) => item.tool === tool)
    if (pref.tools[tool]) return pref.tools[tool]
    if (pref.preset !== "custom" && entry) return entry.expansionPresets[pref.preset]
    return pref.tools[OTHER_TOOL_NAME] ?? "expanded"
  }

  const currentThinkingExpansion = () => {
    const current = preferences()
    const pref = current.toolCallExpansionDefaults
    if (pref.thinking) return pref.thinking
    if (pref.preset !== "custom") return THINKING_EXPANSION_PRESETS[pref.preset]
    return current.thinkingBlocksExpansion ?? "expanded"
  }

  const currentThinkingMode = (): VisibilityPreference =>
    preferences().showThinkingBlocks ? currentThinkingExpansion() : "hidden"

  const currentUsageMode = (): VisibilityPreference => {
    const current = preferences()
    return current.showUsageMetrics ? current.usageMetricsExpansion : "hidden"
  }

  const currentPreset = createMemo(() => {
    const current = preferences()
    const preset = current.toolCallExpansionDefaults.preset
    if (preset === "custom") return preset
    const detail = transcriptDetailPresets[preset]
    const expectedThinking = detail.showThinkingBlocks ? THINKING_EXPANSION_PRESETS[preset] : "hidden"
    return currentThinkingMode() === expectedThinking &&
      current.diagnosticsExpansion === detail.diagnosticsExpansion &&
      current.toolInputsVisibility === detail.toolInputsVisibility &&
      current.showUsageMetrics === detail.showUsageMetrics &&
      current.usageMetricsExpansion === detail.usageMetricsExpansion
      ? preset
      : "custom"
  })

  const materializeToolModes = () => {
    const tools: Record<string, VisibilityPreference> = {}
    for (const entry of getConfigurableToolEntries()) tools[entry.tool] = currentToolMode(entry.tool)
    return tools
  }

  const applyExpansionPreset = (preset: ToolCallExpansionPreset) => {
    const tools = buildToolExpansionPresetDefaults(preset)
    const thinking = THINKING_EXPANSION_PRESETS[preset]
    updatePreferences({
      ...transcriptDetailPresets[preset],
      toolCallExpansionDefaults: { preset, thinking, tools },
      thinkingBlocksExpansion: thinking,
      toolOutputExpansion: tools[OTHER_TOOL_NAME] === "expanded" ? "expanded" : "collapsed",
    })
  }

  const setVisibilityRowMode = (row: VisibilityRow, mode: VisibilityPreference) => {
    const current = preferences()
    if (row.kind === "diagnostics") {
      updatePreferences({ diagnosticsExpansion: mode })
      return
    }
    if (row.kind === "inputs") {
      updatePreferences({ toolInputsVisibility: mode })
      return
    }
    if (row.kind === "usage") {
      updatePreferences({
        showUsageMetrics: mode !== "hidden",
        usageMetricsExpansion: mode === "hidden" ? current.usageMetricsExpansion : mode,
      })
      return
    }

    const tools = materializeToolModes()
    const thinking = row.kind === "thinking" && mode !== "hidden" ? mode : currentThinkingExpansion()
    if (row.kind === "tool") tools[row.key] = mode
    updatePreferences({
      showThinkingBlocks: row.kind === "thinking" ? mode !== "hidden" : current.showThinkingBlocks,
      toolCallExpansionDefaults: { preset: "custom", thinking, tools },
      thinkingBlocksExpansion:
        row.kind === "thinking" && mode !== "hidden" ? mode : current.thinkingBlocksExpansion,
      toolOutputExpansion:
        row.kind === "tool" && row.key === OTHER_TOOL_NAME && mode !== "hidden"
          ? mode
          : current.toolOutputExpansion,
    })
  }

  const rowMode = (row: VisibilityRow): VisibilityPreference => {
    if (row.kind === "thinking") return currentThinkingMode()
    if (row.kind === "tool") return currentToolMode(row.key)
    if (row.kind === "diagnostics") return preferences().diagnosticsExpansion
    if (row.kind === "inputs") return preferences().toolInputsVisibility
    return currentUsageMode()
  }

  const selectedVisibilityOption = (mode: VisibilityPreference) =>
    visibilityOptions().find((option) => option.value === mode)

  const presetLabel = (preset: ToolCallExpansionPreset | "custom") =>
    t(`settings.behavior.expansionPreset.${preset}.title`)

  return (
    <div class="settings-section-stack">
      <section class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.behavior.expansionPresets.ariaLabel")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.behavior.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{presetLabel(currentPreset())}</span>
        </div>

        <div class="settings-expansion-presets" aria-label={t("settings.behavior.expansionPresets.ariaLabel")}>
          <For each={toolExpansionPresetOptions}>
            {(preset) => (
              <button
                type="button"
                class="settings-expansion-preset"
                data-selected={currentPreset() === preset ? "true" : "false"}
                onClick={() => applyExpansionPreset(preset)}
              >
                <span class="settings-expansion-preset-title">{presetLabel(preset)}</span>
                <span class="settings-expansion-preset-copy">{t(`settings.behavior.expansionPreset.${preset}.description`)}</span>
              </button>
            )}
          </For>
        </div>

        <div class="settings-expansion-table" role="table" aria-label={t("settings.behavior.expansionDefaults.title")}>
          <div class="settings-expansion-table-header" role="row">
            <span role="columnheader">{t("settings.behavior.expansionDefaults.itemColumn")}</span>
            <span role="columnheader">{t("settings.behavior.expansionDefaults.stateColumn")}</span>
          </div>
          <For each={visibilityRows()}>
            {(row) => {
              const selected = createMemo(() => selectedVisibilityOption(rowMode(row)))
              return (
                <div class="settings-expansion-row" role="row">
                  <div class="settings-expansion-row-label" role="cell"><code>{row.label}</code></div>
                  <div class="settings-expansion-row-control" role="cell">
                    <Select<SelectOption>
                      value={selected()}
                      onChange={(option) => option && setVisibilityRowMode(row, option.value)}
                      options={visibilityOptions()}
                      optionValue="value"
                      optionTextValue="label"
                      itemComponent={(itemProps) => (
                        <Select.Item item={itemProps.item} class="selector-option">
                          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                        </Select.Item>
                      )}
                    >
                      <Select.Trigger
                        class="selector-trigger settings-expansion-select"
                        aria-label={t("settings.behavior.expansionDefaults.rowAriaLabel", { item: row.label })}
                      >
                        <div class="flex-1 min-w-0">
                          <Select.Value<SelectOption>>
                            {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
                          </Select.Value>
                        </div>
                        <Select.Icon class="selector-trigger-icon"><ChevronDown class="w-3 h-3" /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content class="selector-popover"><Select.Listbox class="selector-listbox" /></Select.Content>
                      </Select.Portal>
                    </Select>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </section>
    </div>
  )
}
