import { Terminal } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"
import { openCodeSetupBusy } from "../../stores/opencode-setup"
import OpenCodeBinarySelector from "../opencode-binary-selector"

export function OpenCodeExecutableCard() {
  const { t } = useI18n()
  const { serverSettings, updateLastUsedBinary } = useConfig()
  return <div class="settings-card">
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
    <OpenCodeBinarySelector selectedBinary={serverSettings().opencodeBinary || "opencode2"}
      onBinaryChange={updateLastUsedBinary} disabled={openCodeSetupBusy()} isVisible />
  </div>
}
