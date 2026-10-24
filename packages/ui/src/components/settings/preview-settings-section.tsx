import { Code, MonitorPlay, Server, Shield } from "lucide-solid"
import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import type {
  PreviewFeatureSettings,
  PreviewOriginMode,
  PreviewSandboxSettings,
  PreviewSettings,
} from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { showConfirmDialog } from "../../stores/alerts"
import { useConfig, validatePreviewOrigin } from "../../stores/preferences"
import { SettingsChoiceRow } from "./settings-switch"

const originModes: ReadonlyArray<{ id: PreviewOriginMode; labelKey: string }> = [
  { id: "opaque", labelKey: "settings.preview.origin.mode.opaque" },
  { id: "app", labelKey: "settings.preview.origin.mode.app" },
  { id: "custom", labelKey: "settings.preview.origin.mode.custom" },
]

const sandboxOptions: ReadonlyArray<{ id: keyof PreviewSandboxSettings; labelKey: string }> = [
  { id: "forms", labelKey: "settings.preview.sandbox.forms" },
  { id: "modals", labelKey: "settings.preview.sandbox.modals" },
  { id: "popups", labelKey: "settings.preview.sandbox.popups" },
  { id: "downloads", labelKey: "settings.preview.sandbox.downloads" },
]

const featureOptions: ReadonlyArray<{ id: keyof PreviewFeatureSettings; labelKey: string }> = [
  { id: "camera", labelKey: "settings.preview.features.camera" },
  { id: "microphone", labelKey: "settings.preview.features.microphone" },
  { id: "clipboardRead", labelKey: "settings.preview.features.clipboardRead" },
  { id: "clipboardWrite", labelKey: "settings.preview.features.clipboardWrite" },
  { id: "geolocation", labelKey: "settings.preview.features.geolocation" },
  { id: "fullscreen", labelKey: "settings.preview.features.fullscreen" },
]

/**
 * Server-wide preview policy: origin tier, document sandbox and delegated
 * browser features. Toggles save immediately; the security-sensitive origin
 * mode and custom origin need an explicit confirmation or Save. The server
 * remains authoritative for the policy it enforces.
 */
export const PreviewSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const settings = createMemo(() => config.serverSettings().preview)
  const currentOrigin = window.location.origin

  const [mode, setMode] = createSignal<PreviewOriginMode>(settings().originMode)
  const [customOriginDraft, setCustomOriginDraft] = createSignal(settings().customOrigin)
  const [originError, setOriginError] = createSignal<string | null>(null)
  const originValidationError = () => originError()
    ?? (settings().originMode === "custom" && !settings().customOrigin ? t("settings.preview.origin.invalid") : null)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)

  // Follow authoritative changes without discarding a draft the user is
  // editing: only a different stored value replaces the local value.
  let storedMode = settings().originMode
  createEffect(() => {
    const next = settings().originMode
    if (next === storedMode) return
    storedMode = next
    setMode(next)
  })
  let storedCustomOrigin = settings().customOrigin
  createEffect(() => {
    const next = settings().customOrigin
    if (next === storedCustomOrigin) return
    storedCustomOrigin = next
    setCustomOriginDraft(next)
  })

  // Saves stay ordered so rapid toggles merge into the last confirmed policy
  // instead of overwriting each other with a stale snapshot.
  let saveQueue: Promise<void> = Promise.resolve()
  const enqueueSave = (build: (current: PreviewSettings) => PreviewSettings): Promise<boolean> => {
    const result = saveQueue.then(async () => {
      setSaving(true)
      setSaveError(null)
      try {
        await config.updatePreviewSettings(build(settings()))
        return true
      } catch {
        setSaveError(t("settings.preview.saveError"))
        return false
      } finally {
        setSaving(false)
      }
    })
    saveQueue = result.then(() => undefined)
    return result
  }

  const chooseMode = async (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement
    const next = select.value as PreviewOriginMode
    if (next === mode()) return
    setOriginError(null)

    // A dedicated origin is only applied by its own Save, once an origin is valid.
    if (next === "custom") {
      setMode("custom")
      return
    }

    // Keep the select on the effective mode until a confirmation accepts it.
    select.value = mode()
    if (next === settings().originMode) {
      setMode(next)
      return
    }
    if (next === "app") {
      const confirmed = await showConfirmDialog(t("settings.preview.origin.appConfirmMessage"), {
        title: t("settings.preview.origin.appConfirmTitle"),
        variant: "warning",
        confirmLabel: t("settings.preview.origin.appConfirmLabel"),
        cancelLabel: t("settings.preview.origin.appCancelLabel"),
        dismissible: false,
      })
      if (!confirmed) return
    }

    setMode(next)
    select.value = next
    const saved = await enqueueSave((current) => ({ ...current, originMode: next }))
    if (!saved) setMode(settings().originMode)
  }

  const saveCustomOrigin = async () => {
    const normalized = validatePreviewOrigin(customOriginDraft())
    if (!normalized) {
      setOriginError(t("settings.preview.origin.invalid"))
      return
    }
    if (normalized === currentOrigin) {
      setOriginError(t("settings.preview.origin.appOriginConflict"))
      return
    }
    setOriginError(null)
    const saved = await enqueueSave((current) => ({ ...current, originMode: "custom", customOrigin: normalized }))
    if (!saved) return
    setMode("custom")
    setCustomOriginDraft(normalized)
  }

  const setSandbox = (key: keyof PreviewSandboxSettings, value: boolean) => {
    void enqueueSave((current) => ({ ...current, sandbox: { ...current.sandbox, [key]: value } }))
  }

  const setFeature = (key: keyof PreviewFeatureSettings, value: boolean) => {
    void enqueueSave((current) => ({ ...current, features: { ...current.features, [key]: value } }))
  }

  return (
    <div class="settings-section-stack preview-settings-section">
      <h2 class="sr-only">{t("settings.preview.title")}</h2>
      <p class="settings-help-text">{t("settings.preview.subtitle")}</p>

      <Show when={saveError()}>
        {(message) => <div class="settings-error-message" role="alert">{message()}</div>}
      </Show>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Shield class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">
                {t("settings.preview.origin.title")}
                <Show when={mode() === "opaque"}>
                  <span class="settings-scope-badge ml-2">{t("settings.preview.origin.recommended")}</span>
                </Show>
              </h3>
              <p class="settings-card-subtitle">{t("settings.preview.origin.subtitle")}</p>
            </div>
          </div>
          <select
            class="selector-trigger"
            aria-label={t("settings.preview.origin.title")}
            value={mode()}
            onChange={(event) => void chooseMode(event)}
          >
            <For each={originModes}>
              {(option) => (
                <option value={option.id} selected={mode() === option.id}>
                  {t(option.labelKey)}
                </option>
              )}
            </For>
          </select>
        </div>

        <p class="settings-inline-note">{t("settings.preview.origin.current", { origin: currentOrigin })}</p>

        <Show when={mode() === "opaque"}>
          <p class="settings-inline-note">{t("settings.preview.origin.opaqueNote")}</p>
        </Show>
        <Show when={mode() === "app"}>
          <p class="settings-inline-note settings-inline-warning">{t("settings.preview.origin.appNote")}</p>
        </Show>
        <Show when={mode() === "custom"}>
          <p class="settings-inline-note">{t("settings.preview.origin.customNote")}</p>
          <div class="settings-form-group">
            <label class="settings-form-label" for="preview-custom-origin">
              {t("settings.preview.origin.customLabel")}
            </label>
            <div class="selector-input-group">
              <input
                id="preview-custom-origin"
                class="selector-input"
                type="url"
                autocomplete="off"
                spellcheck={false}
                value={customOriginDraft()}
                placeholder={t("settings.preview.origin.customPlaceholder")}
                aria-invalid={originValidationError() ? "true" : undefined}
                onInput={(event) => {
                  setCustomOriginDraft(event.currentTarget.value)
                  setOriginError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveCustomOrigin()
                }}
              />
              <button
                type="button"
                class="selector-button selector-button-primary"
                disabled={saving()}
                onClick={() => void saveCustomOrigin()}
              >
                {t("settings.preview.origin.customSave")}
              </button>
            </div>
            <Show when={originValidationError()}>
              {(message) => <div class="settings-error-message" role="alert">{message()}</div>}
            </Show>
            <p class="settings-inline-note">{t("settings.preview.origin.customContract")}</p>
          </div>
        </Show>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Code class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.preview.sandbox.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.preview.sandbox.subtitle")}</p>
            </div>
          </div>
        </div>
        <div class="settings-stack">
          <SettingsChoiceRow
            checked
            disabled
            title={t("settings.preview.sandbox.scripts")}
            caption={t("settings.preview.sandbox.scriptsNote")}
            onChange={() => undefined}
          />
          <For each={sandboxOptions}>
            {(option) => (
              <SettingsChoiceRow
                checked={settings().sandbox[option.id]}
                title={t(option.labelKey)}
                onChange={(enabled) => setSandbox(option.id, enabled)}
              />
            )}
          </For>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <MonitorPlay class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.preview.features.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.preview.features.subtitle")}</p>
            </div>
          </div>
        </div>
        <div class="settings-stack">
          <For each={featureOptions}>
            {(option) => (
              <SettingsChoiceRow
                checked={settings().features[option.id]}
                title={t(option.labelKey)}
                onChange={(enabled) => setFeature(option.id, enabled)}
              />
            )}
          </For>
        </div>
        <p class="settings-inline-note">{t("settings.preview.features.browserNote")}</p>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Server class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.preview.serviceWorkers.title")}</h3>
            </div>
          </div>
        </div>
        <p class="settings-inline-note">
          {settings().originMode === "app"
            ? t("settings.preview.serviceWorkers.app")
            : settings().originMode === "custom"
              ? t("settings.preview.serviceWorkers.custom")
              : t("settings.preview.serviceWorkers.opaque")}
        </p>
      </div>

      <p class="settings-inline-note">{t("settings.preview.nativeNote")}</p>
    </div>
  )
}
