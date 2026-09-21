import { onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { isOpenCodeConnected, openCodeSetupStatus as status, openCodeSetupError,
  openCodeSetupBusy, openCodeSetupChecking, openCodeSetupAction,
  openOpenCodeSetup, refreshOpenCodeSetup, runOpenCodeSetup } from "../../stores/opencode-setup"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  const disabled = () => openCodeSetupBusy() || openCodeSetupChecking()
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
          <Show when={data().updateAvailable && data().latestVersion}>
            <p role="status">{t("settings.opencode.update.available", { version: data().latestVersion ?? "" })}</p>
            <Show when={!data().canUpgrade}><p class="settings-toggle-caption">{t("settings.opencode.setup.manual")}</p></Show>
          </Show>
          <Show when={data().updateAvailable === false && data().latestVersion && !data().checkError}>
            <p role="status">{t("settings.opencode.update.upToDate")}</p>
          </Show>
          <Show when={data().checkError}><p role="status">{t("settings.opencode.update.checkFailed")}</p></Show>
          <Show when={data().serviceState === "restart_available" || data().serviceState === "restart_required"}>
            <p class="settings-toggle-caption">{t(data().serviceState === "restart_required" ? "settings.opencode.setup.restartRequired" : "settings.opencode.setup.restartAvailable")}</p>
          </Show>
        </>}
      </Show>
      <Show when={openCodeSetupError() && status()}><p class="settings-error-message" role="alert">{t("settings.opencode.setup.actionFailed")}</p></Show>
      <Show when={openCodeSetupAction() === "install"}><p role="status">{t("settings.opencode.update.updating")}</p></Show>
      <div class="settings-info-actions">
        <Show when={status()?.canUpgrade}>
          <button type="button" class="settings-pill-button" disabled={disabled()} onClick={() => void runOpenCodeSetup("install")}>
            {openCodeSetupAction() === "install" ? t("settings.opencode.update.updating") : status()?.state === "missing"
              ? t("settings.opencode.setup.install") : t("settings.opencode.update.action", { version: status()?.latestVersion ?? "" })}
          </button>
        </Show>
        <button type="button" class="settings-pill-button" onClick={() => openOpenCodeSetup()}>
        {t("settings.opencode.setup.manage")}
      </button></div>
    </div>
  </section>
}
