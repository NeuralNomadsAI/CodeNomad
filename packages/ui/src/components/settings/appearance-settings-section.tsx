import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createSignal, For, type Component } from "solid-js"
import { Check, ChevronDown, Laptop, Moon, Sun } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { useTheme, type ThemeMode } from "../../lib/theme"
import { useConfig, type ExpansionPreference, type ToolCallExpansionPreset } from "../../stores/preferences"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { StartupStateSettingsCard } from "./startup-state-settings-card"
import {
  buildToolExpansionPresetDefaults,
  getConfigurableToolEntries,
  OTHER_TOOL_NAME,
  THINKING_EXPANSION_PRESETS,
} from "../tool-call/tool-registry"

const themeModeOptions: Array<{ value: ThemeMode; icon: typeof Laptop }> = [
  { value: "system", icon: Laptop },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
]

const toolExpansionPresetOptions: ToolCallExpansionPreset[] = ["minimal", "balanced", "detailed", "everything"]

export const AppearanceSettingsSection: Component = () => {
  const { t } = useI18n()
  const { themeMode, setThemeMode } = useTheme()
  const {
    preferences,
    useTauriNativeEventTransport,
    setUseTauriNativeEventTransport,
    updatePreferences,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
    toggleShowMessageTimeline,
    toggleShowTimelineTools,
    toggleUsageMetrics,
    toggleAutoCleanupBlankSessions,
    togglePromptSubmitOnEnter,
    toggleShowPromptVoiceInput,
    setDiffViewMode,
    setToolOutputExpansion,
    setDiagnosticsExpansion,
    setThinkingBlocksExpansion,
    setToolInputsVisibility,
  } = useConfig()
  const behaviorSettings = createMemo(() =>
    getBehaviorSettings({
      preferences,
      useTauriNativeEventTransport,
      setUseTauriNativeEventTransport,
      updatePreferences,
      toggleShowThinkingBlocks,
      toggleKeyboardShortcutHints,
      toggleShowMessageTimeline,
      toggleShowTimelineTools,
      toggleUsageMetrics,
      toggleAutoCleanupBlankSessions,
      togglePromptSubmitOnEnter,
      toggleShowPromptVoiceInput,
      setDiffViewMode,
      setToolOutputExpansion,
      setDiagnosticsExpansion,
      setThinkingBlocksExpansion,
      setToolInputsVisibility,
    }).filter(
      (setting) => setting.id !== "behavior.thinkingBlocksDefault" && setting.id !== "behavior.toolOutputsDefault",
    ),
  )

  const [overrides, setOverrides] = createSignal<Map<string, unknown>>(new Map())

  const setOverride = (id: string, value: unknown) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(id, value)
      return next
    })
  }

  createEffect(() => {
    const current = overrides()
    if (current.size === 0) return

    const prefs = preferences()
    const settings = behaviorSettings()

    let changed = false
    const next = new Map(current)
    for (const setting of settings) {
      if (!next.has(setting.id)) continue
      const overrideValue = next.get(setting.id)
      const actualValue = setting.get(prefs)
      if (Object.is(actualValue, overrideValue)) {
        next.delete(setting.id)
        changed = true
      }
    }

    if (changed) {
      setOverrides(next)
    }
  })

  const readSettingValue = (setting: BehaviorSetting) => {
    const current = overrides()
    if (current.has(setting.id)) return current.get(setting.id)
    return setting.get(preferences())
  }

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

  const currentPreset = createMemo(() => preferences().toolCallExpansionDefaults.preset)

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

  const BehaviorRow: Component<{ setting: BehaviorSetting }> = (props) => {
    const setting = props.setting
    const disabled = createMemo(() => (setting.disabled ? Boolean(setting.disabled()) : false))

    if (setting.kind === "toggle") {
      const options = createMemo<SelectOption[]>(() => [
        { value: "true", label: t("settings.common.enabled") },
        { value: "false", label: t("settings.common.disabled") },
      ])
      const currentValue = createMemo(() => String(Boolean(readSettingValue(setting))))
      const selectedOption = createMemo(() => options().find((opt) => opt.value === currentValue()))

      return (
        <div class={`settings-toggle-row ${disabled() ? "opacity-60" : ""}`}>
          <div>
            <div class="settings-toggle-title">{t(setting.titleKey)}</div>
            <div class="settings-toggle-caption">{t(setting.subtitleKey)}</div>
          </div>
          <Select<SelectOption>
            value={selectedOption()}
            onChange={(opt) => {
              if (!opt) return
              const next = opt.value === "true"
              setOverride(setting.id, next)
              setting.set(next)
            }}
            options={options()}
            optionValue="value"
            optionTextValue="label"
            disabled={disabled()}
            itemComponent={(itemProps) => (
              <Select.Item item={itemProps.item} class="selector-option">
                <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
              </Select.Item>
            )}
          >
            <Select.Trigger class="selector-trigger" aria-label={t(setting.titleKey)}>
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
      )
    }

    const enumSetting = setting as Extract<BehaviorSetting, { kind: "enum" }>
    const options = createMemo<SelectOption[]>(() =>
      enumSetting.options.map((opt: { value: string; labelKey: string }) => ({
        value: String(opt.value),
        label: t(opt.labelKey),
      })),
    )
    const currentValue = createMemo(() => String(readSettingValue(setting) ?? ""))
    const selectedOption = createMemo(() => options().find((opt) => opt.value === currentValue()))

    return (
      <div class={`settings-toggle-row ${disabled() ? "opacity-60" : ""}`}>
        <div>
          <div class="settings-toggle-title">{t(setting.titleKey)}</div>
          <div class="settings-toggle-caption">{t(setting.subtitleKey)}</div>
        </div>
        <Select<SelectOption>
          value={selectedOption()}
          onChange={(opt) => {
            if (!opt) return
            setOverride(setting.id, opt.value)
            enumSetting.set(opt.value as any)
          }}
          options={options()}
          optionValue="value"
          optionTextValue="label"
          disabled={disabled()}
          itemComponent={(itemProps) => (
            <Select.Item item={itemProps.item} class="selector-option">
              <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
            </Select.Item>
          )}
        >
          <Select.Trigger class="selector-trigger" aria-label={t(setting.titleKey)}>
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
    )
  }

  const modeLabel = (mode: ThemeMode) => {
    if (mode === "system") return t("theme.mode.system")
    if (mode === "light") return t("theme.mode.light")
    return t("theme.mode.dark")
  }

  const presetLabel = (preset: ToolCallExpansionPreset | "custom") => t(`settings.behavior.expansionPreset.${preset}.title`)

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.theme.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.theme.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>
        <div class="settings-choice-grid">
          {themeModeOptions.map((option) => {
            const Icon = option.icon
            return (
              <button
                type="button"
                class="settings-choice"
                data-selected={themeMode() === option.value ? "true" : "false"}
                onClick={() => setThemeMode(option.value)}
              >
                <span class="settings-choice-icon-wrap">
                  <Icon class="settings-choice-icon" />
                </span>
                <span class="settings-choice-copy">
                  <span class="settings-choice-label">{modeLabel(option.value)}</span>
                  <span class="settings-choice-description">{t(`settings.appearance.theme.option.${option.value}`)}</span>
                </span>
                <span class="settings-choice-check" aria-hidden="true">
                  <Check class="w-4 h-4" />
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <StartupStateSettingsCard />

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.behavior.title")}</h3>
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
          <For each={behaviorSettings()}>{(setting) => <BehaviorRow setting={setting} />}</For>
        </div>
      </div>
    </div>
  )
}
