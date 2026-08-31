import { Check } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Show, untrack, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useTheme } from "../../lib/theme"
import { useConfig } from "../../stores/preferences"
import {
  BUILT_IN_COLOR_SCHEMES,
  DEFAULT_CUSTOM_COLORS,
  isCanonicalHexColor,
  normalizeColorScheme,
  validateColorSchemeColors,
  type ColorSchemeColors,
  type NormalizedColorScheme,
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

const customSelection = (scheme: NormalizedColorScheme): NormalizedColorScheme =>
  scheme.id === "custom"
    ? normalizeColorScheme(scheme)
    : normalizeColorScheme({ id: "custom", appearance: "dark", colors: DEFAULT_CUSTOM_COLORS })

const SYSTEM_SWATCHES = ["#FFFFFF", "#1A1A1A", "#0066FF", "#0080FF"]
const LIGHT_SWATCHES = ["#FFFFFF", "#F5F5F5", "#111827", "#0066FF"]

export const ThemeSchemeSettings: Component = () => {
  const { t } = useI18n()
  const { colorScheme, setColorScheme } = useTheme()
  const { customColorSchemePreference } = useConfig()
  const initialCustom = customSelection(customColorSchemePreference())
  const [appearance, setAppearance] = createSignal<"light" | "dark">(initialCustom.appearance === "light" ? "light" : "dark")
  const [draftColors, setDraftColors] = createSignal<ColorSchemeColors>({ ...initialCustom.colors! })
  const [dirty, setDirty] = createSignal(false)
  let lastPersistedCustom = JSON.stringify(initialCustom)
  const validFormat = createMemo(() => COLOR_FIELDS.every(({ key }) => isCanonicalHexColor(draftColors()[key])))
  const validDraft = createMemo(() => validateColorSchemeColors(draftColors()))

  const updateColor = (key: keyof ColorSchemeColors, value: string) => {
    setDirty(true)
    setDraftColors((current) => ({ ...current, [key]: value }))
  }

  createEffect(() => {
    const saved = customSelection(customColorSchemePreference())
    const serialized = JSON.stringify(saved)
    if (serialized === lastPersistedCustom) return
    lastPersistedCustom = serialized
    const local = untrack(() => ({
      active: colorScheme().id === "custom",
      appearance: appearance(),
      colors: draftColors(),
      dirty: dirty(),
    }))
    const matchesDraft = saved.appearance === local.appearance && JSON.stringify(saved.colors) === JSON.stringify(local.colors)
    if (local.active && local.dirty && !matchesDraft) return
    setAppearance(saved.appearance === "light" ? "light" : "dark")
    setDraftColors({ ...saved.colors! })
    setDirty(false)
  })

  const selectScheme = (id: NormalizedColorScheme["id"]) => {
    if (colorScheme().id === id) return
    if (id !== "custom") {
      const saved = customSelection(customColorSchemePreference())
      setAppearance(saved.appearance === "light" ? "light" : "dark")
      setDraftColors({ ...saved.colors! })
      setDirty(false)
      setColorScheme(normalizeColorScheme(id))
      return
    }
    const saved = customSelection(customColorSchemePreference())
    setDirty(false)
    setDraftColors({ ...saved.colors! })
    setAppearance(saved.appearance === "light" ? "light" : "dark")
    setColorScheme(saved)
  }

  const saveCustom = () => {
    const colors = draftColors()
    if (!validateColorSchemeColors(colors)) return
    const next: NormalizedColorScheme = { id: "custom", appearance: appearance(), colors: { ...colors } }
    setColorScheme(next)
  }

  const resetCustom = () => {
    setDirty(true)
    setDraftColors({ ...DEFAULT_CUSTOM_COLORS })
    setAppearance("dark")
  }

  const swatches = (id: NormalizedColorScheme["id"], colors?: Readonly<ColorSchemeColors>) => {
    if (id === "custom") {
      const draft = draftColors()
      return (["surfaceBase", "surfaceSecondary", "textPrimary", "accentPrimary"] as const).map((key) =>
        isCanonicalHexColor(draft[key]) ? draft[key] : DEFAULT_CUSTOM_COLORS[key],
      )
    }
    if (id === "system") return SYSTEM_SWATCHES
    if (id === "light") return LIGHT_SWATCHES
    if (colors) return [colors.surfaceBase, colors.surfaceSecondary, colors.textPrimary, colors.accentPrimary]
    return LIGHT_SWATCHES
  }

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.appearance.colorScheme.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.appearance.colorScheme.subtitle")}</p>
        </div>
        <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
      </div>

      <div class="settings-choice-grid theme-scheme-grid">
        <For each={BUILT_IN_COLOR_SCHEMES}>{(scheme) => (
          <button
            type="button"
            class="settings-choice theme-scheme-card"
            data-selected={colorScheme().id === scheme.id ? "true" : "false"}
            aria-pressed={colorScheme().id === scheme.id}
            onClick={() => selectScheme(scheme.id)}
          >
            <span class="theme-scheme-swatches" aria-hidden="true">
              <For each={swatches(scheme.id, scheme.colors)}>{(color) => <span style={{ background: color }} />}</For>
            </span>
            <span class="settings-choice-copy">
              <span class="settings-choice-label">{t(scheme.labelKey)}</span>
              <span class="settings-choice-description">{t(scheme.descriptionKey)}</span>
            </span>
            <span class="settings-choice-check theme-scheme-card-check" aria-hidden="true"><Check /></span>
          </button>
        )}</For>
      </div>

      <Show when={colorScheme().id === "custom"}>
        <div class="theme-scheme-editor">
          <fieldset class="theme-scheme-appearance">
            <legend>{t("settings.appearance.colorScheme.custom.appearance")}</legend>
            <div class="theme-scheme-appearance-options">
              <For each={["light", "dark"] as const}>{(option) => (
                <button
                  type="button"
                  class="theme-scheme-appearance-option"
                  data-selected={appearance() === option ? "true" : "false"}
                  aria-pressed={appearance() === option}
                  onClick={() => {
                    setDirty(true)
                    setAppearance(option)
                  }}
                >
                  {t(`settings.appearance.colorScheme.custom.appearance.${option}`)}
                  <Check class="theme-scheme-appearance-check" aria-hidden="true" />
                </button>
              )}</For>
            </div>
          </fieldset>

          <fieldset class="theme-scheme-colors">
            <legend>{t("settings.appearance.colorScheme.custom.colors")}</legend>
            <div class="theme-scheme-color-grid">
              <For each={COLOR_FIELDS}>{(field) => {
                const label = () => t(field.labelKey)
                const pickerValue = () => isCanonicalHexColor(draftColors()[field.key]) ? draftColors()[field.key] : DEFAULT_CUSTOM_COLORS[field.key]
                return (
                  <div class="theme-scheme-color-field">
                    <span>{label()}</span>
                    <span class="theme-scheme-color-controls">
                      <input
                        type="color"
                        value={pickerValue()}
                        aria-label={t("settings.appearance.colorScheme.custom.pickerAriaLabel", { name: label() })}
                        onInput={(event) => updateColor(field.key, event.currentTarget.value.toUpperCase())}
                      />
                      <input
                        type="text"
                        value={draftColors()[field.key]}
                        aria-label={t("settings.appearance.colorScheme.custom.valueAriaLabel", { name: label() })}
                        aria-invalid={!isCanonicalHexColor(draftColors()[field.key])}
                        dir="ltr"
                        spellcheck={false}
                        onInput={(event) => updateColor(field.key, event.currentTarget.value.toUpperCase())}
                      />
                    </span>
                  </div>
                )
              }}</For>
            </div>
          </fieldset>

          <Show when={!validDraft()}>
            <p class="theme-scheme-warning" role="alert">
              {t(validFormat() ? "settings.appearance.colorScheme.custom.warning.contrast" : "settings.appearance.colorScheme.custom.warning.format")}
            </p>
          </Show>
          <div class="theme-scheme-actions">
            <button type="button" class="selector-button selector-button-secondary" onClick={resetCustom}>
              {t("settings.appearance.colorScheme.custom.reset")}
            </button>
            <button type="button" class="selector-button selector-button-primary" disabled={!validDraft()} onClick={saveCustom}>
              {t("settings.appearance.colorScheme.custom.save")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
