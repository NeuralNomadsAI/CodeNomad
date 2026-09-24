import { onMount, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { refreshOpenCodeSetup } from "../../stores/opencode-setup"
import { OpenCodeSetupPanel } from "./opencode-setup-panel"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  onMount(() => void refreshOpenCodeSetup())
  return <section class="settings-card">
    <div class="settings-card-header"><div>
      <h3 class="settings-card-title">{t("settings.opencode.update.title")}</h3>
      <p class="settings-card-subtitle">{t("settings.opencode.setup.description")}</p>
    </div><span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span></div>
    <div class="settings-card-body">
      <OpenCodeSetupPanel />
    </div>
  </section>
}
