import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useTheme } from "../../lib/theme"
import { nextColorSchemePresetName } from "../../lib/color-scheme-presets"
import { showConfirmDialog } from "../../stores/alerts"
import { useConfig } from "../../stores/preferences"
import { registerSettingsDirtyGuard } from "../../stores/settings-dirty-guard"
import {
  BUILT_IN_COLOR_SCHEMES,
  DEFAULT_CUSTOM_COLORS,
  LIGHT_COLOR_SCHEME_COLORS,
  SYSTEM_DARK_COLOR_SCHEME_COLORS,
  SYSTEM_LIGHT_COLOR_SCHEME_COLORS,
  isColorSchemeColors,
  normalizeColorScheme,
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
  description: string
  appearance: "light" | "dark"
  colors: Readonly<ColorSchemeColors>
  originalColors: Readonly<ColorSchemeColors>
}

export const ThemeSchemeSettings: Component = () => {
  const { t } = useI18n()
  const { colorScheme, setColorScheme } = useTheme()
  const config = useConfig()
  const [draftColors, setDraftColors] = createSignal<ColorSchemeColors>({ ...DEFAULT_CUSTOM_COLORS })
  const [appearance, setAppearance] = createSignal<"light" | "dark">("dark")
  const [filter, setFilter] = createSignal<"light" | "dark">("dark")
  const [visitedKeys, setVisitedKeys] = createSignal<Partial<Record<"light" | "dark", string>>>({})
  const [editingKey, setEditingKey] = createSignal("")
  const [sourceName, setSourceName] = createSignal(t("settings.appearance.colorScheme.option.custom"))
  const [draftName, setDraftName] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saveFailed, setSaveFailed] = createSignal(false)

  const systemMedia = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined
  const [systemDark, setSystemDark] = createSignal(systemMedia?.matches ?? false)
  const handleSystemAppearance = (event: MediaQueryListEvent) => setSystemDark(event.matches)
  systemMedia?.addEventListener("change", handleSystemAppearance)
  onCleanup(() => systemMedia?.removeEventListener("change", handleSystemAppearance))
  const systemColors = () => systemDark() ? SYSTEM_DARK_COLOR_SCHEME_COLORS : SYSTEM_LIGHT_COLOR_SCHEME_COLORS

  const options = createMemo<PaletteOption[]>(() => [
    ...BUILT_IN_COLOR_SCHEMES.map((scheme): PaletteOption => {
      const originalColors = scheme.id === "system"
        ? systemColors()
        : scheme.id === "light"
          ? LIGHT_COLOR_SCHEME_COLORS
          : scheme.colors ?? DEFAULT_CUSTOM_COLORS
      const savedColors = scheme.id === "custom"
        ? config.customColorSchemePreference().colors
        : config.colorSchemeOverrides()[scheme.id]
      return {
        key: `builtin:${scheme.id}`,
        id: scheme.id,
        name: t(scheme.labelKey),
        description: t(scheme.descriptionKey),
        appearance: scheme.id === "system"
          ? (systemDark() ? "dark" : "light")
          : scheme.id === "custom"
            ? (config.customColorSchemePreference().appearance === "light" ? "light" : "dark")
          : scheme.appearance === "light" ? "light" : "dark",
        colors: savedColors ?? originalColors,
        originalColors,
      }
    }),
    ...Object.entries(config.colorSchemePresets()).map(([id, preset]): PaletteOption => ({
      key: `preset:${id}`,
      presetId: id,
      name: preset.name,
      description: t("settings.appearance.colorScheme.description.custom"),
      appearance: preset.appearance,
      colors: preset.colors,
      originalColors: preset.colors,
    })),
  ])

  const activeKey = createMemo(() => config.activeColorSchemePresetId()
    ? `preset:${config.activeColorSchemePresetId()}`
    : `builtin:${colorScheme().id}`)
  const filteredOptions = createMemo(() => options().filter((option) => option.appearance === filter()))
  const editingOption = createMemo(() => options().find((option) => option.key === editingKey()))
  const validDraft = createMemo(() => isColorSchemeColors(draftColors()))
  const savedBuiltinOverride = createMemo(() => {
    const option = editingOption()
    if (!option?.id) return false
    if (option.id === "custom") return COLOR_FIELDS.some((field) => option.colors[field.key] !== option.originalColors[field.key])
    return Boolean(config.colorSchemeOverrides()[option.id])
  })

  createEffect(() => {
    if (!config.isLoaded() || dirty()) return
    const option = options().find((candidate) => candidate.key === activeKey())
    if (!option) return
    setEditingKey(option.key)
    setSourceName(option.name)
    setAppearance(option.appearance)
    setFilter(option.appearance)
    setVisitedKeys((current) => ({ ...current, [option.appearance]: option.key }))
    setDraftColors({ ...option.colors })
    setSaveFailed(false)
  })

  const confirmDiscardIfDirty = async () => !dirty() || showConfirmDialog(
    t("settings.configFiles.confirmDiscard.message"),
    {
      variant: "warning",
      confirmLabel: t("settings.configFiles.confirmDiscard.confirmLabel"),
      cancelLabel: t("settings.configFiles.confirmDiscard.cancelLabel"),
      dismissible: false,
    },
  )
  const unregisterDirtyGuard = registerSettingsDirtyGuard(confirmDiscardIfDirty)
  onCleanup(unregisterDirtyGuard)

  const selectOption = async (option: PaletteOption) => {
    if (editingKey() === option.key || !(await confirmDiscardIfDirty())) return
    setDirty(false)
    setCreating(false)
    setSaveFailed(false)
    setEditingKey(option.key)
    setVisitedKeys((current) => ({ ...current, [option.appearance]: option.key }))
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

  const updateColor = async (option: PaletteOption, key: keyof ColorSchemeColors, value: string) => {
    if (editingKey() !== option.key && !(await confirmDiscardIfDirty())) return false
    const colors = editingKey() === option.key ? draftColors() : option.colors
    setEditingKey(option.key)
    setSourceName(option.name)
    setAppearance(option.appearance)
    setDraftColors({ ...colors, [key]: value.toUpperCase() })
    setDirty(true)
    setSaveFailed(false)
    return true
  }

  const resetBuiltin = async () => {
    const option = editingOption()
    if (!option?.id) return
    setSaving(true)
    setSaveFailed(false)
    try {
      if (option.id === "custom") await config.setColorSchemePreference(normalizeColorScheme("custom"))
      else await config.resetColorSchemeOverride(option.id)
      setDraftColors({ ...option.originalColors })
      setAppearance(option.appearance)
      setDirty(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const startNewPreset = () => {
    const name = nextColorSchemePresetName(sourceName(), Object.values(config.colorSchemePresets()).map((preset) => preset.name))
    setDraftName(name)
    setCreating(true)
    setDirty(true)
    setSaveFailed(false)
  }

  const savePreset = async () => {
    if (!dirty() || !validDraft()) return
    const option = editingOption()
    if (!option) return
    const presetId = !creating() ? option.presetId : undefined
    const name = creating()
      ? draftName().trim()
      : presetId
        ? option.name
        : nextColorSchemePresetName(sourceName(), Object.values(config.colorSchemePresets()).map((preset) => preset.name))
    if (!name) return
    setSaving(true)
    setSaveFailed(false)
    try {
      if (!creating() && option.id) {
        if (option.id === "custom") {
          await config.setColorSchemePreference(normalizeColorScheme({ id: "custom", appearance: option.appearance, colors: draftColors() }))
        } else {
          await config.saveColorSchemeOverride(option.id, option.appearance, draftColors())
        }
        setDirty(false)
        return
      }
      const id = await config.saveColorSchemePreset(name, appearance(), draftColors(), presetId)
      setEditingKey(`preset:${id}`)
      setVisitedKeys((current) => ({ ...current, [appearance()]: `preset:${id}` }))
      setSourceName(name)
      setCreating(false)
      setDirty(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const deletePreset = async (option: PaletteOption) => {
    if (!option.presetId) return
    const confirmed = await showConfirmDialog(t("settings.appearance.colorScheme.custom.deleteConfirm", { name: option.name }), {
      variant: "warning",
      confirmLabel: t("settings.appearance.colorScheme.custom.delete"),
      dismissible: false,
    })
    if (!confirmed) return
    setSaving(true)
    setSaveFailed(false)
    try {
      await config.deleteColorSchemePreset(option.presetId)
      const fallback = options().find((candidate) => candidate.key === "builtin:custom")!
      setEditingKey(fallback.key)
      setSourceName(fallback.name)
      setAppearance(fallback.appearance)
      setFilter(fallback.appearance)
      setDraftColors({ ...fallback.colors })
      setCreating(false)
      setDirty(false)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const changeFilter = async (next: "light" | "dark") => {
    if (filter() === next || !(await confirmDiscardIfDirty())) return
    setDirty(false)
    setCreating(false)
    setFilter(next)
    const option = options().find((candidate) => candidate.key === visitedKeys()[next] && candidate.appearance === next)
      ?? options().find((candidate) => candidate.appearance === next)
    if (option) void selectOption(option)
  }

  const colorsFor = (option: PaletteOption) => editingKey() === option.key ? draftColors() : option.colors

  return (
    <div class="settings-card theme-scheme-settings">
      <div class="settings-card-header">
        <h3 class="settings-card-title">{t("settings.appearance.colorScheme.title")}</h3>
        <span class="settings-scope-badge">{t("settings.scope.device")}</span>
      </div>

      <div class="theme-scheme-list">
        <div class="theme-scheme-toolbar">
          <div class="theme-scheme-appearance-options" aria-label={t("settings.appearance.colorScheme.custom.appearance")}>
            <For each={["light", "dark"] as const}>{(option) => (
              <button
                type="button"
                class="theme-scheme-appearance-option"
                data-selected={filter() === option ? "true" : "false"}
                aria-pressed={filter() === option}
                onClick={() => void changeFilter(option)}
              >
                {t(`settings.appearance.colorScheme.custom.appearance.${option}`)}
              </button>
            )}</For>
          </div>
        <select
          class="selector-input theme-scheme-picker"
          value={editingOption()?.key ?? ""}
          aria-label={t("settings.appearance.colorScheme.title")}
          onChange={(event) => {
            const select = event.currentTarget
            const option = options().find((candidate) => candidate.key === select.value)
            if (!option) return
            void selectOption(option).then(() => { select.value = editingKey() })
          }}
        >
          <For each={filteredOptions()}>{(option) => <option value={option.key} selected={editingKey() === option.key}>{option.name}</option>}</For>
        </select>
        </div>
        <Show when={editingOption()} keyed>{(option) => (
          <div class="theme-scheme-card" title={option.description}>
            <Show when={creating()} fallback={<span class="theme-scheme-name">{option.name}</span>}>
              <label class="theme-scheme-name-editor">
                <span>{t("settings.appearance.colorScheme.custom.name")}</span>
                <input class="selector-input" value={draftName()} maxLength={80} onInput={(event) => setDraftName(event.currentTarget.value)} />
              </label>
            </Show>
            <span class="theme-scheme-swatches">
              <For each={COLOR_FIELDS}>{(field) => {
                const color = () => colorsFor(option)[field.key]
                const label = () => t(field.labelKey)
                return (
                  <label class="theme-scheme-swatch" title={`${label()} · ${color()}`}>
                    <input
                      type="color"
                      value={color()}
                      aria-label={`${option.name} · ${label()} · ${color()}`}
                      onInput={(event) => {
                        const input = event.currentTarget
                        void updateColor(option, field.key, input.value).then((updated) => {
                          if (!updated) input.value = color()
                        })
                      }}
                    />
                    <span>{label()}</span>
                  </label>
                )
              }}</For>
            </span>
          </div>
        )}</Show>
      </div>

      <div class="theme-scheme-editor">
        <Show when={saveFailed()}>
          <p class="theme-scheme-warning" role="alert">{t("settings.appearance.colorScheme.custom.saveError")}</p>
        </Show>
        <div class="theme-scheme-actions">
          <Show when={editingOption()?.presetId}>
            <button type="button" class="selector-button selector-button-secondary" disabled={creating() || saving()} onClick={() => void deletePreset(editingOption()!)}>
              {t("settings.appearance.colorScheme.custom.delete")}
            </button>
          </Show>
          <Show when={savedBuiltinOverride()}>
            <button type="button" class="selector-button selector-button-secondary" disabled={creating() || saving()} onClick={() => void resetBuiltin()}>
              {t("settings.appearance.colorScheme.custom.reset")}
            </button>
          </Show>
          <Show when={dirty()}>
            <Show when={!creating()}>
              <button type="button" class="selector-button selector-button-secondary" disabled={saving()} onClick={startNewPreset}>
                {t("settings.appearance.colorScheme.custom.new")}
              </button>
            </Show>
            <button type="button" class="selector-button selector-button-primary" disabled={!validDraft() || saving() || (creating() && !draftName().trim())} onClick={() => void savePreset()}>
              {t("settings.appearance.colorScheme.custom.save")}
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
