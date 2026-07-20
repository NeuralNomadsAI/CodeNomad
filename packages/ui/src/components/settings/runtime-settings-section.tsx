import { createEffect, createSignal, type Component } from "solid-js"
import { Terminal } from "lucide-solid"
import OpenCodeBinarySelector from "../opencode-binary-selector"
import { useConfig } from "../../stores/preferences"
import { useI18n } from "../../lib/i18n"
import { OpenCodeUpdateCard } from "./opencode-update-card"
import { SideCarsSettingsSection } from "./sidecars-settings-section"

export const RuntimeSettingsSection: Component = () => {
  const { t } = useI18n()
  const { serverSettings, updateLastUsedBinary } = useConfig()
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

      <OpenCodeUpdateCard />
      <SideCarsSettingsSection />
    </div>
  )
}
