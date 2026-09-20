import { onMount, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { openSettings } from "../../stores/settings-screen"
import { openCodeSetupStatus as status, openCodeSetupBusy as busy, openCodeSetupError,
  refreshOpenCodeSetup, runOpenCodeSetup, setOpenCodeSetupOpen } from "../../stores/opencode-setup"

export const OpenCodeUpdateCard: Component = () => {
  const { t } = useI18n()
  onMount(() => void refreshOpenCodeSetup())
  return <section class="settings-card" aria-busy={busy()}>
    <div class="settings-card-header"><div>
      <h3 class="settings-card-title">{t("settings.opencode.update.title")}</h3>
      <p class="settings-card-subtitle">{t("settings.opencode.setup.description")}</p>
    </div><span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span></div>
    <Show when={status()} fallback={<p role="status">{t("settings.opencode.update.checking")}</p>}>
      {data => <>
        <p role="status">{t(`settings.opencode.setup.${data().state}`)}</p>
        <div class="settings-info-grid">
          <div class="settings-info-row"><span>{t("settings.opencode.update.installed")}</span><span>{data().currentVersion ?? "—"}</span></div>
          <div class="settings-info-row"><span>{t("settings.opencode.setup.minimum")}</span><span>{data().minimumVersion}</span></div>
          <div class="settings-info-row"><span>{t("settings.opencode.setup.daemon")}</span><span>{data().daemonVersion ?? "—"}</span></div>
        </div>
        <p class="settings-toggle-caption break-all">{data().binaryPath}</p>
        <Show when={data().target === "wsl"}><p>{t("settings.opencode.setup.wsl")}</p></Show>
        <Show when={data().serviceState === "restart_required" || data().serviceState === "restart_available"}><p role="status">{t("settings.opencode.setup.restartRequired")}</p></Show>
        <Show when={data().serviceState === "error"}><p role="alert">{t("settings.opencode.setup.serviceError")}</p></Show>
        <Show when={data().checkError}><p role="status">{t("settings.opencode.update.checkFailed")}</p></Show>
        <Show when={!data().canUpgrade && (data().state === "missing" || data().state === "update_required")}>
          <p>{t("settings.opencode.setup.manual")}</p>
        </Show>
        <div class="settings-info-actions">
          <Show when={data().canUpgrade}><button type="button" class="settings-pill-button" disabled={busy()} onClick={() => void runOpenCodeSetup("install")}>
            {busy() ? t("settings.opencode.update.updating") : data().state === "missing" ? t("settings.opencode.setup.install")
              : t("settings.opencode.update.action", { version: data().latestVersion ?? "" })}
          </button></Show>
          <Show when={data().state === "ready" && data().serviceState !== "restart_required"}>
            <button type="button" class="settings-pill-button" disabled={busy()} onClick={() => void runOpenCodeSetup("start")}>{t("settings.opencode.setup.connect")}</button>
          </Show>
          <Show when={data().canRestart}><button type="button" class="settings-pill-button" disabled={busy()} onClick={() => void runOpenCodeSetup("restart")}>{t("settings.opencode.setup.restart")}</button></Show>
        </div>
      </>}
    </Show>
    <Show when={openCodeSetupError()}><p class="settings-error-message" role="alert">{t("settings.opencode.update.failed")}</p></Show>
    <div class="settings-info-actions">
      <button type="button" class="settings-pill-button" disabled={busy()} onClick={() => void refreshOpenCodeSetup()}>{t("settings.opencode.update.retry")}</button>
      <button type="button" class="settings-pill-button" disabled={busy()} onClick={() => { setOpenCodeSetupOpen(false); void openSettings("opencode") }}>{t("settings.opencode.setup.chooseBinary")}</button>
    </div>
  </section>
}
