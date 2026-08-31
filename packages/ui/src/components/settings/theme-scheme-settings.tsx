import { Check } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useTheme } from "../../lib/theme"
import { nextColorSchemePresetName } from "../../lib/color-scheme-presets"
import { showConfirmDialog, showPromptDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"
import { registerSettingsDirtyGuard } from "../../stores/settings-dirty-guard"
import {
  BUILT_IN_COLOR_SCHEMES,
  DEFAULT_CUSTOM_COLORS,
  LIGHT_COLOR_SCHEME_COLORS,
  normalizeColorScheme,
  validateColorSchemeColors,
  type ColorSchemeColors,
  type ColorSchemeId,
} from "../../lib/theme-scheme"

const COLOR_FIELDS: ReadonlyArray<{ key: keyof ColorSchemeColors; labelKey: string }> = [
  { key: "surfaceBase", labelKey: "settings.appearance.colorScheme.custom.field.surfaceBase" },
  { key: "surfaceSecondary", labelKey: "settings.appearance.colorScheme.custom.field.surfaceSecondary" },
  { key: "surfaceMuted", labelKey: "settings.appearance.colorScheme.custom.field.surfaceMuted" },
  { key: "borderBase", labelKey: "settings.appearance.colorScheme.custom.field.borderBase" },
  { key: "textPrimary", labelKey: "settings.appearance.colorScheme.custom.field.textPrimary" },
  { key: "textMuted", labelKey: "settings.appearance.colorScheme.custom.field.textMuted" },
  { key: "accentPrimary", labelKey: "settings.appearance.colorScheme.custom.field.accentPrimary" },
  { key: "statusSuccess", labelKey: "settings.appearance.colorScheme.custom.field.statusSuccess" },
  { key: "statusWarning", labelKey: "settings.appearance.colorScheme.custom.field.statusWarning" },
  { key: "statusError", labelKey: "settings.appearance.colorScheme.custom.field.statusError" },
  { key: "userAccent", labelKey: "settings.appearance.colorScheme.custom.field.userAccent" },
  { key: "agentAccent", labelKey: "settings.appearance.colorScheme.custom.field.agentAccent" },
  { key: "compactionAccent", labelKey: "settings.appearance.colorScheme.custom.field.compactionAccent" },
  { key: "yoloAccent", labelKey: "settings.appearance.colorScheme.custom.field.yoloAccent" },
]

interface PaletteOption {
  key: string
  id?: ColorSchemeId
  presetId?: string
  name: string
  appearance: "light" | "dark"
  colors: Readonly<ColorSchemeColors>
}

export const ThemeSchemeSettings: Component = () => {
  const { t } = useI18n()
  const { colorScheme, setColorScheme } = useTheme()
  const config = useConfig()
  const [draftColors, setDraftColors] = createSignal<ColorSchemeColors>({ ...DEFAULT_CUSTOM_COLORS })
  const [appearance, setAppearance] = createSignal<"light" | "dark">("dark")
  const [editingKey, setEditingKey] = createSignal("")
  const [sourceName, setSourceName] = createSignal(t("settings.appearance.colorScheme.option.custom"))
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveFailed, setSaveFailed] = createSignal(false)

  const classicColors = BUILT_IN_COLOR_SCHEMES.find((scheme) => scheme.id === "classic")!.colors!
  const systemColors = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? classicColors
    : LIGHT_COLOR_SCHEME_COLORS

  const options = createMemo<PaletteOption[]>(() => [
    ...BUILT_IN_COLOR_SCHEMES.map((scheme): PaletteOption => ({
      key: `builtin:${scheme.id}`,
      id: scheme.id,
      name: t(scheme.labelKey),
      appearance: scheme.id === "system"
        ? (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : scheme.appearance === "light" ? "light" : "dark",
      colors: scheme.id === "system"
        ? systemColors()
        : scheme.id === "light"
          ? LIGHT_COLOR_SCHEME_COLORS
          : scheme.id === "custom"
            ? config.customColorSchemePreference().colors ?? DEFAULT_CUSTOM_COLORS
            : scheme.colors ?? DEFAULT_CUSTOM_COLORS,
    })),
    ...Object.entries(config.colorSchemePresets()).map(([id, preset]): PaletteOption => ({
      key: `preset:${id}`,
      presetId: id,
      name: preset.name,
      appearance: preset.appearance,
      colors: preset.colors,
    })),
  ])

  const activeKey = createMemo(() => config.activeColorSchemePresetId()
    ? `preset:${config.activeColorSchemePresetId()}`
    : `builtin:${colorScheme().id}`)
  const validDraft = createMemo(() => validateColorSchemeColors(draftColors()))

  createEffect(() => {
    if (dirty()) return
    const option = options().find((candidate) => candidate.key === activeKey())
    if (!option) return
    setEditingKey(option.key)
    setSourceName(option.name)
    setAppearance(option.appearance)
    setDraftColors({ ...option.colors })
    setSaveFailed(false)
  })

  const unregisterDirtyGuard = registerSettingsDirtyGuard(async () => !dirty() || showConfirmDialog(
    t("settings.configFiles.confirmDiscard.message"),
    {
      confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"),
      cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"),
    },
  ))
  onCleanup(unregisterDirtyGuard)

  const selectOption = (option: PaletteOption) => {
    setDirty(false)
    setSaveFailed(false)
    setEditingKey(option.key)
    setSourceName(option.name)
    setAppearance(option.appearance)
    setDraftColors({ ...option.colors })
    if (option.presetId) {
      void config.selectColorSchemePreset(option.presetId).catch(() => setSaveFailed(true))
      return
    }
    setColorScheme(option.id === "custom"
      ? normalizeColorScheme({ id: "custom", appearance: option.appearance, colors: option.colors })
      : normalizeColorScheme(option.id))
  }

  const updateColor = (option: PaletteOption, key: keyof ColorSchemeColors, value: string) => {
    const colors = editingKey() === option.key ? draftColors() : option.colors
    setEditingKey(option.key)
    setSourceName(option.name)
    setAppearance(option.appearance)
    setDraftColors({ ...colors, [key]: value.toUpperCase() })
    setDirty(true)
    setSaveFailed(false)
  }

  const resetDraft = () => {
    const option = options().find((candidate) => candidate.key === editingKey())
    if (option) {
      setDraftColors({ ...option.colors })
      setAppearance(option.appearance)
    }
    setDirty(false)
    setSaveFailed(false)
  }

  const savePreset = async () => {
    if (!dirty() || !validDraft()) return
    const defaultName = nextColorSchemePresetName(sourceName(), Object.values(config.colorSchemePresets()).map((preset) => preset.name))
    const name = await showPromptDialog(t("settings.appearance.colorScheme.description.custom"), {
      title: t("settings.appearance.colorScheme.title"),
      inputLabel: t("settings.appearance.colorScheme.title"),
      inputDefaultValue: defaultName,
      confirmLabel: t("settings.appearance.colorScheme.custom.save"),
    })
    if (!name?.trim()) return
    setSaving(true)
    setSaveFailed(false)
    try {
      const id = await config.saveColorSchemePreset(name, appearance(), draftColors())
      setEditingKey(`preset:${id}`)
      setSourceName(name.trim())
      setDirty(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const colorsFor = (option: PaletteOption) => editingKey() === option.key ? draftColors() : option.colors

  return (
    <div class="settings-card theme-scheme-settings">
      <div class="settings-card-header">
        <h3 class="settings-card-title">{t("settings.appearance.colorScheme.title")}</h3>
        <span class="settings-scope-badge">{t("settings.scope.device")}</span>
      </div>

      <div class="theme-scheme-list">
        <For each={options()}>{(option) => (
          <div class="theme-scheme-card" data-selected={(dirty() ? editingKey() : activeKey()) === option.key ? "true" : "false"}>
            <button type="button" class="theme-scheme-select" onClick={() => selectOption(option)}>
              <span class="theme-scheme-name">{option.name}</span>
              <Check class="theme-scheme-check" aria-hidden="true" />
            </button>
            <span class="theme-scheme-swatches">
              <For each={COLOR_FIELDS}>{(field) => {
                const color = () => colorsFor(option)[field.key]
                const label = () => t(field.labelKey)
                return (
                  <input
                    type="color"
                    value={color()}
                    title={`${label()} · ${color()}`}
                    aria-label={`${option.name} · ${label()} · ${color()}`}
                    onInput={(event) => updateColor(option, field.key, event.currentTarget.value)}
                  />
                )
              }}</For>
            </span>
          </div>
        )}</For>
      </div>

      <div class="theme-scheme-editor">
        <div class="theme-scheme-appearance-options" aria-label={t("settings.appearance.colorScheme.custom.appearance")}>
          <For each={["light", "dark"] as const}>{(option) => (
            <button
              type="button"
              class="theme-scheme-appearance-option"
              data-selected={appearance() === option ? "true" : "false"}
              aria-pressed={appearance() === option}
              onClick={() => {
                setAppearance(option)
                setDirty(true)
                setSaveFailed(false)
              }}
            >
              {t(`settings.appearance.colorScheme.custom.appearance.${option}`)}
            </button>
          )}</For>
        </div>
        <Show when={dirty() && !validDraft()}>
          <p class="theme-scheme-warning" role="alert">{t("settings.appearance.colorScheme.custom.warning.contrast")}</p>
        </Show>
        <Show when={saveFailed()}>
          <p class="theme-scheme-warning" role="alert">{t("settings.appearance.colorScheme.custom.saveError")}</p>
        </Show>
        <div class="theme-scheme-actions">
          <button type="button" class="selector-button selector-button-secondary" disabled={!dirty() || saving()} onClick={resetDraft}>
            {t("settings.appearance.colorScheme.custom.reset")}
          </button>
          <button type="button" class="selector-button selector-button-primary" disabled={!dirty() || !validDraft() || saving()} onClick={() => void savePreset()}>
            {t("settings.appearance.colorScheme.custom.save")}
          </button>
        </div>
      </div>
    </div>
  )
}
