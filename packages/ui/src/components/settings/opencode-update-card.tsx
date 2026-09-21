import { onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { isOpenCodeConnected, openCodeSetupStatus as status, openCodeSetupError,
  openOpenCodeSetup, refreshOpenCodeSetup } from "../../stores/opencode-setup"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  onMount(() => void refreshOpenCodeSetup())
  return <section class="settings-card">
    <div class="settings-card-header"><div>
      <h3 class="settings-card-title">{t("settings.opencode.update.title")}</h3>
      <p class="settings-card-subtitle">{t("settings.opencode.setup.description")}</p>
    </div><span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span></div>
    <div class="settings-card-body">
      <Show when={status()} fallback={<p role="status">{t(openCodeSetupError() ? "settings.opencode.update.checkFailed" : "settings.opencode.update.checking")}</p>}>
        {data => <>
          <p role="status">{t(isOpenCodeConnected() ? "settings.opencode.setup.connected"
            : data().state === "ready" ? "settings.opencode.setup.disconnected" : `settings.opencode.setup.${data().state}`)}</p>
          <div class="settings-info-grid">
            <div class="settings-info-row"><span>{t("settings.opencode.update.installed")}</span><span>{data().currentVersion ?? "—"}</span></div>
            <div class="settings-info-row"><span>{t("settings.opencode.setup.daemon")}</span><span>{data().daemonVersion ?? "—"}</span></div>
          </div>
        </>}
      </Show>
      <div class="settings-info-actions"><button type="button" class="settings-pill-button" onClick={() => openOpenCodeSetup()}>
        {t("settings.opencode.setup.manage")}
      </button></div>
    </div>
  </section>
}
