import { Select } from "@kobalte/core/select"
import { createMemo, For, type Component } from "solid-js"
import { ChevronDown } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { useConfig, type ExpansionPreference, type Preferences, type ToolCallExpansionPreset } from "../../stores/preferences"
import {
  buildToolExpansionPresetDefaults,
  getConfigurableToolEntries,
  OTHER_TOOL_NAME,
  THINKING_EXPANSION_PRESETS,
} from "../tool-call/tool-registry"
import { BehaviorSettingRows } from "./behavior-setting-rows"
const toolExpansionPresetOptions: ToolCallExpansionPreset[] = ["minimal", "balanced", "detailed", "everything"]
const transcriptDetailPresets = {
  minimal: {
    showThinkingBlocks: false,
    showTimelineTools: false,
    diagnosticsExpansion: "collapsed",
    toolInputsVisibility: "hidden",
    showUsageMetrics: false,
  },
  balanced: {
    showThinkingBlocks: false,
    showTimelineTools: true,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "collapsed",
    showUsageMetrics: true,
  },
  detailed: {
    showThinkingBlocks: true,
    showTimelineTools: true,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "collapsed",
    showUsageMetrics: true,
  },
  everything: {
    showThinkingBlocks: true,
    showTimelineTools: true,
    diagnosticsExpansion: "expanded",
    toolInputsVisibility: "expanded",
    showUsageMetrics: true,
  },
} as const satisfies Record<
  ToolCallExpansionPreset,
  Pick<Preferences, "showThinkingBlocks" | "showTimelineTools" | "diagnosticsExpansion" | "toolInputsVisibility" | "showUsageMetrics">
>

export const ChatSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const { preferences, updatePreferences } = config
  const transcriptSettings = createMemo<BehaviorSetting[]>(() =>
    getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.thinkingBlocks" ||
        setting.id === "behavior.timelineToolCalls" ||
        setting.id === "behavior.diagnosticsDefault" ||
        setting.id === "behavior.toolInputsVisibility" ||
        setting.id === "behavior.usageMetrics",
    ),
  )

  type SelectOption = { value: string; label: string }

  type ExpansionRow =
    | { kind: "thinking"; key: "thinking"; label: string }
    | { kind: "tool"; key: string; label: string }

  const expansionOptions = createMemo<SelectOption[]>(() => [
    { value: "collapsed", label: t("commands.common.collapsed") },
    { value: "expanded", label: t("commands.common.expanded") },
  ])

  const toolExpansionRows = createMemo<ExpansionRow[]>(() => [
    { kind: "thinking", key: "thinking", label: t("settings.behavior.expansionDefaults.thinking") },
    ...getConfigurableToolEntries().map((entry) => ({
      kind: "tool" as const,
      key: entry.tool,
      label: entry.labelKey ? t(entry.labelKey) : entry.label,
    })),
  ])

  const currentPreset = createMemo(() => {
    const current = preferences()
    const preset = current.toolCallExpansionDefaults.preset
    if (preset === "custom") return preset
    const detail = transcriptDetailPresets[preset]
    return current.showThinkingBlocks === detail.showThinkingBlocks &&
      current.showTimelineTools === detail.showTimelineTools &&
      current.diagnosticsExpansion === detail.diagnosticsExpansion &&
      current.toolInputsVisibility === detail.toolInputsVisibility &&
      current.showUsageMetrics === detail.showUsageMetrics
      ? preset
      : "custom"
  })

  const currentToolMode = (tool: string): ExpansionPreference => {
    const pref = preferences().toolCallExpansionDefaults
    const entry = getConfigurableToolEntries().find((item) => item.tool === tool)
    if (pref.tools[tool]) return pref.tools[tool]
    if (pref.preset !== "custom" && entry) return entry.expansionPresets[pref.preset]
    return pref.tools[OTHER_TOOL_NAME] ?? "expanded"
  }

  const currentThinkingMode = (): ExpansionPreference => {
    const pref = preferences().toolCallExpansionDefaults
    if (pref.thinking) return pref.thinking
    if (pref.preset !== "custom") return THINKING_EXPANSION_PRESETS[pref.preset]
    return preferences().thinkingBlocksExpansion ?? "expanded"
  }

  const materializeToolModes = () => {
    const tools: Record<string, ExpansionPreference> = {}
    for (const entry of getConfigurableToolEntries()) {
      tools[entry.tool] = currentToolMode(entry.tool)
    }
    return tools
  }

  const applyExpansionPreset = (preset: ToolCallExpansionPreset) => {
    const tools = buildToolExpansionPresetDefaults(preset)
    const thinking = THINKING_EXPANSION_PRESETS[preset]
    updatePreferences({
      ...transcriptDetailPresets[preset],
      toolCallExpansionDefaults: { preset, thinking, tools },
      thinkingBlocksExpansion: thinking,
      toolOutputExpansion: tools[OTHER_TOOL_NAME] ?? "expanded",
    })
  }

  const setExpansionRowMode = (row: ExpansionRow, mode: ExpansionPreference) => {
    const tools = materializeToolModes()
    const thinking = row.kind === "thinking" ? mode : currentThinkingMode()
    if (row.kind === "tool") {
      tools[row.key] = mode
    }
    updatePreferences({
      toolCallExpansionDefaults: { preset: "custom", thinking, tools },
      thinkingBlocksExpansion: thinking,
      toolOutputExpansion: tools[OTHER_TOOL_NAME] ?? preferences().toolOutputExpansion,
    })
  }

  const rowMode = (row: ExpansionRow): ExpansionPreference =>
    row.kind === "thinking" ? currentThinkingMode() : currentToolMode(row.key)

  const selectedExpansionOption = (mode: ExpansionPreference) =>
    expansionOptions().find((opt) => opt.value === mode)

  const presetLabel = (preset: ToolCallExpansionPreset | "custom") => t(`settings.behavior.expansionPreset.${preset}.title`)

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
          <For each={toolExpansionRows()}>
            {(row) => {
              const selected = createMemo(() => selectedExpansionOption(rowMode(row)))
              return (
                <div class="settings-expansion-row" role="row">
                  <div class="settings-expansion-row-label" role="cell">
                    <code>{row.label}</code>
                  </div>
                  <div class="settings-expansion-row-control" role="cell">
                    <Select<SelectOption>
                      value={selected()}
                      onChange={(opt) => {
                        if (!opt) return
                        setExpansionRowMode(row, opt.value as ExpansionPreference)
                      }}
                      options={expansionOptions()}
                      optionValue="value"
                      optionTextValue="label"
                      itemComponent={(itemProps) => (
                        <Select.Item item={itemProps.item} class="selector-option">
                          <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
                        </Select.Item>
                      )}
                    >
                      <Select.Trigger class="selector-trigger settings-expansion-select" aria-label={t("settings.behavior.expansionDefaults.rowAriaLabel", { item: row.label })}>
                        <div class="flex-1 min-w-0">
                          <Select.Value<SelectOption>>
                            {(state) => (
                              <span class="selector-trigger-primary selector-trigger-primary--align-left">
                                {state.selectedOption()?.label}
                              </span>
                            )}
                          </Select.Value>
                        </div>
                        <Select.Icon class="selector-trigger-icon">
                          <ChevronDown class="w-3 h-3" />
                        </Select.Icon>
                      </Select.Trigger>

                      <Select.Portal>
                        <Select.Content class="selector-popover">
                          <Select.Listbox class="selector-listbox" />
                        </Select.Content>
                      </Select.Portal>
                    </Select>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <div class="settings-stack">
          <BehaviorSettingRows settings={transcriptSettings} preferences={preferences} />
        </div>
      </section>
    </div>
  )
}
