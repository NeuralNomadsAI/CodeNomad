import { createEffect, createSignal, type Component } from "solid-js"
import { Terminal } from "lucide-solid"
import OpenCodeBinarySelector from "../opencode-binary-selector"
import EnvironmentVariablesEditor from "../environment-variables-editor"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"

export const OpenCodeSettingsSection: Component = () => {
  const { t } = useI18n()
  const { serverSettings, updateLastUsedBinary, updateLogLevel } = useConfig()
  const [selectedBinary, setSelectedBinary] = createSignal(serverSettings().opencodeBinary || "opencode")

  createEffect(() => {
    const binary = serverSettings().opencodeBinary || "opencode"
    setSelectedBinary((current) => (current === binary ? current : binary))
  })

  const handleBinaryChange = (binary: string) => {
    setSelectedBinary(binary)
    updateLastUsedBinary(binary)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Terminal class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.opencode.runtime.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.opencode.runtime.subtitle")}</p>
            </div>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <OpenCodeBinarySelector selectedBinary={selectedBinary()} onBinaryChange={handleBinaryChange} isVisible />
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.opencode.logLevel.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.opencode.logLevel.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <div class="settings-card-body">
          <select
            class="settings-select"
            value={serverSettings().preferences?.logLevel ?? "DEBUG"}
            onChange={(e) => {
              const newLogLevel = e.currentTarget.value
              updateLogLevel(newLogLevel)
            }}
          >
            <option value="DEBUG">{`DEBUG`}</option>
            <option value="INFO">{`INFO`}</option>
            <option value="WARN">{`WARN`}</option>
            <option value="ERROR">{`ERROR`}</option>
          </select>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("advancedSettings.environmentVariables.title")}</h3>
            <p class="settings-card-subtitle">{t("advancedSettings.environmentVariables.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>
        <EnvironmentVariablesEditor />
      </div>
    </div>
  )
}
