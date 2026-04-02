import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createSignal, For, type Component } from "solid-js"
import { Check, ChevronDown, Laptop, Moon, Sun, Type } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { useTheme, type ThemeMode } from "../../lib/theme"
import { useConfig } from "../../stores/preferences"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"

const themeModeOptions: Array<{ value: ThemeMode; icon: typeof Laptop }> = [
  { value: "system", icon: Laptop },
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
]

export const AppearanceSettingsSection: Component = () => {
  const { t } = useI18n()
  const { themeMode, setThemeMode } = useTheme()
  const {
    preferences,
    updatePreferences,
    toggleShowThinkingBlocks,
    toggleKeyboardShortcutHints,
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
    setFontFamilySans,
    setFontFamilyMono,
  } = useConfig()

  const behaviorSettings = createMemo(() =>
    getBehaviorSettings({
      preferences,
      updatePreferences,
      toggleShowThinkingBlocks,
      toggleKeyboardShortcutHints,
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
      setFontFamilySans,
      setFontFamilyMono,
    }),
  )

  const [overrides, setOverrides] = createSignal<Map<string, unknown>>(new Map())

  const setOverride = (id: string, value: unknown) => {
    setOverrides((prev) => {
      const next = new Map(prev)
      next.set(id, value)
      return next
    })
  }

  // Font settings state
  const [sansFont, setSansFont] = createSignal<string>(preferences().fontFamilySans || "")
  const [monoFont, setMonoFont] = createSignal<string>(preferences().fontFamilyMono || "")

  // Save font settings
  const saveFontSettings = () => {
    // Pass the raw values to the setter functions, they will normalize them
    setFontFamilySans(sansFont())
    setFontFamilyMono(monoFont())
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

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.behavior.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.behavior.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-stack">
          <For each={behaviorSettings()}>{(setting) => <BehaviorRow setting={setting} />}</For>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.fonts.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.fonts.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <div class="settings-stack">
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.appearance.fonts.sans.title")}</div>
              <div class="settings-toggle-caption">{t("settings.appearance.fonts.sans.subtitle")}</div>
            </div>
            <input
              type="text"
              class="settings-text-input"
              value={sansFont()}
              onInput={(e) => setSansFont(e.currentTarget.value)}
              onBlur={saveFontSettings}
              placeholder={t("settings.appearance.fonts.sans.placeholder")}
            />
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.appearance.fonts.mono.title")}</div>
              <div class="settings-toggle-caption">{t("settings.appearance.fonts.mono.subtitle")}</div>
            </div>
            <input
              type="text"
              class="settings-text-input"
              value={monoFont()}
              onInput={(e) => setMonoFont(e.currentTarget.value)}
              onBlur={saveFontSettings}
              placeholder={t("settings.appearance.fonts.mono.placeholder")}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
